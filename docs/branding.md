# Sidecar Branding

Product: **Sidecar** — https://sidecar.co.in

Creator: **Dhruv** — https://thisisdhruv.in

The source brand kit is checked in at `brand-assets/Sidecar_Brand_Assets_Pack/`.

- `desktop/logo.png` uses the dark app-icon master for the desktop shell.
- `src/public/logo.png` uses the light app-icon master for the dashboard.
- Tauri platform icons use the blue app-icon master so the installed application has one strong, recognizable icon across platforms.

Tauri platform icons can be regenerated with:

```sh
node node_modules/@tauri-apps/cli/tauri.js icon brand-assets/Sidecar_Brand_Assets_Pack/png/app-icon-blue-1024.png --output src-tauri/icons
rm -rf src-tauri/icons/android src-tauri/icons/ios
```

The mark is **Split Pane**: a main pane with a narrow pane docked beside it, the app and its sidecar. The brand kit defines cobalt `#3155FF` (`#4D6BFF` on dark), charcoal `#0C0E13`, off-white `#F7F8FA`, and white, with Geist and Geist Mono as the typefaces (bundled in `src/public/fonts` and `desktop/fonts`). The symbol is text-free so it remains legible in a tray, dock, favicon, and compact dashboard header. Regenerate the SVGs with `python3 brand-assets/Sidecar_Brand_Assets_Pack/docs/make_svgs.py <Geist-SemiBold.woff2> <svg-dir>`.

When replacing the brand, update the two shipped UI logos, regenerate native icons from the selected 1024px master, and rebuild the desktop bundle.
