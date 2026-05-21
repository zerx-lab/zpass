import { defineConfig } from "vite";

// Electron main process build. The Forge Vite plugin injects the lib entry
// from `forge.config.ts` and CJS-output settings; we only add overrides here.
export default defineConfig({});
