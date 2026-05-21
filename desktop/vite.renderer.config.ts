import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Renderer (browser) build for the ported ZPass React app.
//
// Two non-obvious knobs interact with Forge's plugin-vite defaults:
//
// 1. `root` is set to the renderer source folder so Vite finds index.html
//    directly. Forge defaults `root` to the project root; we override it.
// 2. Forge also sets `build.outDir` to the relative path `.vite/renderer/<name>`,
//    which Vite resolves against `root`. After (1) that would land in
//    `electron/src/renderer/.vite/...` and the asar packager — which collects
//    from the project root `.vite/` — would ship without the renderer bundle.
//    Pin outDir to an ABSOLUTE path so the override sticks.
//
// Alias contract:
//   - `@/...`              → `electron/src/renderer/src/*`  (matches the
//     legacy frontend's `@/lib/foo` imports verbatim).
//   - `@/../bindings/...`  → `electron/src/renderer/bindings/*`  (the
//     ported frontend imports wails3-generated binding modules through this
//     relative path; we ship hand-written stubs at that location that route
//     every call through the wailscompat HTTP bridge — see
//     `electron/src/renderer/bindings/README.md`).
//   - `@wailsio/runtime`   → the compat shim that translates Wails runtime
//     APIs (Call / Events / Window / System) to HTTP + Electron IPC. The
//     real package is intentionally not installed; this alias is the only
//     way the renderer talks to those names.
const rendererRoot = resolve(__dirname, "electron/src/renderer");
const rendererSrc = resolve(rendererRoot, "src");
const compatRoot = resolve(rendererSrc, "compat");

export default defineConfig({
  root: rendererRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      // The renderer imports binding files via `@/../bindings/...`,
      // which after alias resolution should land at
      // electron/src/renderer/bindings/<module>.js. Vite resolves @
      // FIRST and then evaluates the relative ../bindings prefix, so
      // the @ alias must point at `src/` (NOT `src/../`).
      { find: /^@\/(.*)$/, replacement: `${rendererSrc}/$1` },
      // Wails runtime is not installed; redirect every import to the
      // compat shim. This includes deep imports like
      // `@wailsio/runtime/plugins/vite` (used by the original Vite
      // config) — those are unused here but the broad pattern keeps
      // any stray import from blowing up the build.
      {
        find: /^@wailsio\/runtime(\/.*)?$/,
        replacement: `${compatRoot}/wails-runtime.ts`,
      },
    ],
  },
  build: {
    outDir: resolve(__dirname, ".vite/renderer/main_window"),
    emptyOutDir: true,
  },
  // Wails' dev server quirks (optimizeDeps preheat, port lockdown) do not
  // apply here — Electron Forge picks the dev port itself and we have no
  // "Vite must be ready before WebView opens" race.
  clearScreen: false,
});
