import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { applyModelCatalog, ModelCatalogRefresher, parseModelCatalog, readModelCatalog, type CatalogModel } from '../src/model-catalog.js'

const levels = (...efforts: string[]) => efforts.map(effort => ({ effort, description: `${effort} reasoning` }))
const catalogJson = JSON.stringify({
  models: [
    { slug: 'gpt-old', visibility: 'list', supported_in_api: true, priority: 9, supported_reasoning_levels: levels('low', 'medium'), input_modalities: ['text'] },
    { slug: 'gpt-hidden', visibility: 'hide', supported_in_api: true, priority: 0, supported_reasoning_levels: levels('low'), input_modalities: ['text', 'image'] },
    { slug: 'gpt-new', visibility: 'list', supported_in_api: true, priority: 1, supported_reasoning_levels: levels('low', 'medium', 'high', 'ultra'), input_modalities: ['text', 'image'] },
    { slug: 'gpt-no-api', visibility: 'list', supported_in_api: false, priority: 2, supported_reasoning_levels: levels('low'), input_modalities: ['text'] },
    { slug: 'bad slug; rm -rf', visibility: 'list', priority: 3 },
  ],
})
const catalog: CatalogModel[] = [
  { id: 'gpt-new', efforts: ['low', 'medium', 'high', 'ultra'], image: true },
  { id: 'gpt-old', efforts: ['low', 'medium'], image: false },
]

async function stateRoot() {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-catalog-'))
  return { root, config: loadConfig({ CODEX_STATE_ROOT: join(root, 'state'), CODEX_WORKSPACE_ROOT: join(root, 'workspaces') }) }
}

describe('model catalog parsing', () => {
  it('keeps only listed API models in Codex priority order with their efforts and image support', () => {
    expect(parseModelCatalog(catalogJson)).toEqual(catalog)
  })

  it('rejects output without usable models', () => {
    expect(() => parseModelCatalog('not json')).toThrow()
    expect(() => parseModelCatalog('{"models":"nope"}')).toThrow('no models array')
    expect(() => parseModelCatalog('{"models":[{"slug":"x","visibility":"hide"}]}')).toThrow('no usable models')
  })
})

describe('applying the catalog', () => {
  it('replaces the fallback list, dropping models Codex no longer lists', () => {
    const config = loadConfig({})
    applyModelCatalog(config, catalog)
    expect(config.models).toEqual(['gpt-new', 'gpt-old'])
    expect(config.imageModels).toEqual(['gpt-new'])
    expect(config.modelEfforts).toEqual({ 'gpt-new': ['low', 'medium', 'high', 'ultra'], 'gpt-old': ['low', 'medium'] })
  })

  it('never replaces model settings pinned through environment variables', () => {
    const config = loadConfig({ CODEX_MODELS: 'gpt-old,custom', CODEX_IMAGE_MODELS: 'custom' })
    applyModelCatalog(config, catalog)
    expect(config.models).toEqual(['gpt-old', 'custom'])
    expect(config.imageModels).toEqual(['custom'])
    expect(config.modelEfforts).toEqual({ 'gpt-old': ['low', 'medium'], custom: ['low', 'medium', 'high', 'xhigh'] })

    const pinnedEfforts = loadConfig({ CODEX_MODEL_EFFORTS: '{"gpt-new":["low"]}' })
    applyModelCatalog(pinnedEfforts, catalog)
    expect(pinnedEfforts.models).toEqual(['gpt-new', 'gpt-old'])
    expect(pinnedEfforts.modelEfforts).toEqual({ 'gpt-new': ['low'] })
  })
})

describe('catalog refresher', () => {
  it('prefers the most recently signed-in key and uses the live catalog', async () => {
    const { config } = await stateRoot()
    const home = join(config.codexStateRoot, 'key_0123456789abcdef')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'auth.json'), '{}')
    await mkdir(join(config.codexStateRoot, 'key_aaaaaaaaaaaaaaaa'), { recursive: true })
    const calls: Array<{ home: string; bundled: boolean }> = []
    const refresher = new ModelCatalogRefresher(config, {
      log: () => undefined,
      read: async (_command, codexHome, options) => { calls.push({ home: codexHome, bundled: options.bundled }); return catalog },
    })
    expect(await refresher.refresh()).toBe('account')
    expect(calls).toEqual([{ home: resolve(home), bundled: false }])
    expect(config.models).toEqual(['gpt-new', 'gpt-old'])
  })

  it('falls back to the bundled catalog, then to the static list when the CLI fails', async () => {
    const { config } = await stateRoot()
    const home = join(config.codexStateRoot, 'key_0123456789abcdef')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'auth.json'), '{}')
    const bundledOnly = new ModelCatalogRefresher(config, {
      log: () => undefined,
      read: async (_command, _home, options) => { if (!options.bundled) throw new Error('offline'); return catalog },
    })
    expect(await bundledOnly.refresh()).toBe('bundled')

    const { config: untouched } = await stateRoot()
    const before = [...untouched.models]
    const events: Array<Record<string, unknown>> = []
    const broken = new ModelCatalogRefresher(untouched, { log: event => events.push(event), read: async () => { throw new Error('missing CLI') } })
    expect(await broken.refresh()).toBeUndefined()
    expect(untouched.models).toEqual(before)
    expect(events).toEqual([expect.objectContaining({ event: 'model_catalog_unavailable', message: 'missing CLI' })])
  })

  it('does not hold up startup when the CLI hangs', async () => {
    const { config } = await stateRoot()
    const refresher = new ModelCatalogRefresher(config, { log: () => undefined, read: () => new Promise(() => undefined) })
    const started = Date.now()
    expect(await refresher.start(50)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2_000)
    refresher.stop()
  })
})

describe.skipIf(process.platform === 'win32')('reading from a Codex command', () => {
  it('runs `codex debug models` with an isolated CODEX_HOME', async () => {
    const { root } = await stateRoot()
    const output = join(root, 'catalog.json')
    const record = join(root, 'record.txt')
    const script = join(root, 'fake-codex')
    await writeFile(output, catalogJson)
    await writeFile(script, `#!/bin/sh\necho "$* $CODEX_HOME" > "${record}"\ncat "${output}"\n`)
    await chmod(script, 0o755)
    expect(await readModelCatalog(script, root, { bundled: true })).toEqual(catalog)
    expect((await readFile(record, 'utf8')).trim()).toBe(`debug models --bundled ${root}`)
  })

  it('rejects a command that fails', async () => {
    const { root } = await stateRoot()
    await expect(readModelCatalog('false', root, { bundled: false })).rejects.toThrow('exited with code 1')
  })
})

function bundledCodex(): string | undefined {
  const command = resolve('node_modules/.bin/codex')
  try { execFileSync(command, ['--version'], { stdio: 'ignore' }); return command } catch { return undefined }
}

describe.skipIf(!bundledCodex())('fallback list', () => {
  it('matches the catalog bundled with the pinned Codex CLI', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sidecar-bundled-'))
    const bundled = await readModelCatalog(bundledCodex()!, home, { bundled: true })
    const fallback = loadConfig({})
    expect(fallback.models).toEqual(bundled.map(model => model.id))
    expect(fallback.imageModels).toEqual(bundled.filter(model => model.image).map(model => model.id))
    expect(fallback.modelEfforts).toEqual(Object.fromEntries(bundled.map(model => [model.id, model.efforts])))
  })
})
