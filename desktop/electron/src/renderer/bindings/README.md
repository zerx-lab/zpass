# bindings/ — stand-in for `wails3 generate bindings`

The desktop was previously a Wails 3 app whose Vite plugin generated a folder
of JS modules under `frontend/bindings/<go-module>/<package>/` — each
exporting one function per Go service method that ultimately called
`Call.ByID(<numeric>)`. The ported frontend still imports from those paths
verbatim (see `lib/config-storage.ts`, `lib/vault-api.ts`).

To keep the import paths valid without committing to a code-generation step,
we ship hand-written stubs here that forward to the wailscompat shim:

- `make-service.js` exports a tiny Proxy factory that turns any property
  access into `Call.ByName("main.<Service>.<Method>", ...args)`.
- `configservice.js` and `vaultservice.js` use that factory; new services
  added to the dispatcher only need their own one-line file here.

Because every call hits the same `/wails/call` HTTP endpoint regardless of
which property name the renderer uses, we do not need to enumerate methods
ahead of time. If the Go side does not register a method by that name, the
backend returns a 404 and the renderer's normal error path handles it.

This whole directory is intentionally outside `src/` so the legacy
`@/../bindings/...` import path resolves correctly (see the alias note in
`vite.renderer.config.ts`).
