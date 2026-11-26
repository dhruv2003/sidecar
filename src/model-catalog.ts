import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { codexChildEnv } from './child-env.js'
import type { AppConfig } from './config.js'

export interface CatalogModel {
  id: string
  efforts: string[]
  image: boolean
}

export type CatalogSource = 'account' | 'bundled'

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 20_000
const DEFAULT_REFRESH_MS = 6 * 60 * 60_000

/**
 * Parse `codex debug models` output. Only models Codex itself lists in its picker
 * and that can be used through the API are kept, in Codex's priority order.
 */
export function parseModelCatalog(output: string): CatalogModel[] {
  const parsed: unknown = JSON.parse(output)
  const entries = (parsed as { models?: unknown })?.models
  if (!Array.isArray(entries)) throw new Error('model catalog has no models array')
  const models = entries
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .filter(entry => typeof entry.slug === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(entry.slug))
    .filter(entry => entry.visibility === 'list' && entry.supported_in_api !== false)
    .map((entry, index) => {
      const levels = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : []
      const efforts = levels
        .map(level => (level as { effort?: unknown })?.effort)
        .filter((effort): effort is string => typeof effort === 'string' && /^[a-z]{1,32}$/.test(effort))
      const modalities = Array.isArray(entry.input_modalities) ? entry.input_modalities : []
      const priority = typeof entry.priority === 'number' ? entry.priority : Number.MAX_SAFE_INTEGER
      return { id: entry.slug as string, efforts, image: modalities.includes('image'), priority, index }
    })
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
  const unique = models.filter((model, index) => models.findIndex(other => other.id === model.id) === index)
  if (unique.length === 0) throw new Error('model catalog lists no usable models')
  return unique.map(({ id, efforts, image }) => ({ id, efforts, image }))
}

/** Run `codex debug models` with an isolated CODEX_HOME and parse the result. */
export function readModelCatalog(codexCommand: string, codexHome: string, options: { bundled: boolean; timeoutMs?: number }): Promise<CatalogModel[]> {
  return new Promise((resolvePromise, reject) => {
    const args = ['debug', 'models', ...(options.bundled ? ['--bundled'] : [])]
    const child = spawn(codexCommand, args, {
      shell: false, windowsHide: true, cwd: codexHome,
      env: { ...codexChildEnv(), CODEX_HOME: codexHome, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let size = 0
    let failed: Error | undefined
    const timer = setTimeout(() => { failed = new Error('model catalog command timed out'); child.kill('SIGKILL') }, options.timeoutMs ?? COMMAND_TIMEOUT_MS)
    timer.unref()
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES) { failed = new Error('model catalog output is too large'); child.kill('SIGKILL'); return }
      chunks.push(chunk)
    })
    child.once('error', error => { failed = error })
    child.once('close', code => {
      clearTimeout(timer)
      if (failed) return reject(failed)
      if (code !== 0) return reject(new Error(`model catalog command exited with code ${code}`))
      try { resolvePromise(parseModelCatalog(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
    })
  })
}

/** Apply a discovered catalog, keeping anything the operator pinned through environment variables. */
export function applyModelCatalog(config: AppConfig, catalog: CatalogModel[]): void {
  const overrides = config.modelOverrides ?? {}
  const known = new Map(catalog.map(model => [model.id, model]))
  const models = overrides.models ? config.models : catalog.map(model => model.id)
  const imageModels = overrides.imageModels
    ? config.imageModels.filter(model => models.includes(model))
    : models.filter(model => known.get(model)?.image === true)
  const modelEfforts = overrides.modelEfforts
    ? config.modelEfforts
    : Object.fromEntries(models.map(model => {
      const efforts = known.get(model)?.efforts
      return [model, efforts && efforts.length > 0 ? efforts : config.modelEfforts[model] ?? ['low', 'medium', 'high', 'xhigh']]
    }))
  config.models = models
  config.imageModels = imageModels
  config.modelEfforts = modelEfforts
}

async function signedInHomes(root: string): Promise<string[]> {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return [] }
  const homes = await Promise.all(entries
    .filter(entry => entry.isDirectory() && /^key_[0-9a-f]{16}$/.test(entry.name))
    .map(async entry => {
      const home = resolve(root, entry.name)
      try {
        const details = await stat(join(home, 'auth.json'))
        if (!details.isFile() || details.size === 0) return undefined
        await access(join(home, 'auth.json'), constants.R_OK)
        return { home, modified: details.mtimeMs }
      } catch { return undefined }
    }))
  return homes
    .filter((home): home is { home: string; modified: number } => home !== undefined)
    .sort((a, b) => b.modified - a.modified)
    .map(home => home.home)
}

export interface ModelCatalogOptions {
  intervalMs?: number
  read?: typeof readModelCatalog
  log?: (event: Record<string, unknown>) => void
}

/**
 * Keeps the enabled model list in sync with the Codex CLI. A signed-in key's
 * catalog is preferred because Codex refreshes it from the account; otherwise the
 * catalog bundled with the CLI is used. The static defaults stay in place if both fail.
 */
export class ModelCatalogRefresher {
  private timer?: ReturnType<typeof setInterval>
  private running?: Promise<CatalogSource | undefined>
  private queued = false
  lastSource?: CatalogSource

  constructor(private readonly config: AppConfig, private readonly options: ModelCatalogOptions = {}) {}

  /**
   * Starts periodic refreshes and waits at most `maxWaitMs` for the first one, so a
   * slow or hung CLI never delays startup; the fallback list serves until it finishes.
   */
  async start(maxWaitMs = 5_000): Promise<CatalogSource | undefined> {
    if (!this.timer) {
      this.timer = setInterval(() => { void this.refresh() }, this.options.intervalMs ?? DEFAULT_REFRESH_MS)
      this.timer.unref()
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<undefined>(done => { timeout = setTimeout(() => done(undefined), maxWaitMs) })
    try { return await Promise.race([this.refresh(), waited]) } finally { clearTimeout(timeout) }
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** Coalesces overlapping calls; a call made while a refresh runs triggers one more afterwards. */
  refresh(): Promise<CatalogSource | undefined> {
    if (this.running) { this.queued = true; return this.running }
    this.running = this.load().finally(() => {
      this.running = undefined
      if (this.queued) { this.queued = false; void this.refresh() }
    })
    return this.running
  }

  private async load(): Promise<CatalogSource | undefined> {
    const read = this.options.read ?? readModelCatalog
    const log = this.options.log ?? (event => console.log(JSON.stringify(event)))
    for (const home of (await signedInHomes(this.config.codexStateRoot)).slice(0, 3)) {
      try {
        return this.use(await read(this.config.codexCommand, home, { bundled: false }), 'account', log)
      } catch { /* try the next signed-in key, then the bundled catalog */ }
    }
    let home: string | undefined
    try {
      home = await mkdtemp(join(tmpdir(), 'sidecar-models-'))
      return this.use(await read(this.config.codexCommand, home, { bundled: true }), 'bundled', log)
    } catch (error) {
      log({ event: 'model_catalog_unavailable', message: error instanceof Error ? error.message : 'unknown error', models: this.config.models.length })
      return undefined
    } finally {
      if (home) await rm(home, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private use(catalog: CatalogModel[], source: CatalogSource, log: (event: Record<string, unknown>) => void): CatalogSource {
    applyModelCatalog(this.config, catalog)
    this.lastSource = source
    log({ event: 'model_catalog_refreshed', source, models: this.config.models.length })
    return source
  }
}
