---
name: add-api-endpoint
description: Add a new HTTP endpoint end-to-end across the Go (Huma) backend and the Electron TS renderer. Use when the user asks to add a route, expose a new API, or wire a new request/response type from Go to TS. Covers the mandatory `Go struct → huma.Register → openapi → codegen → typed client` chain.
---

## Architectural invariants (do not violate)

- Business logic lives **only** in Go under `/internal`. Electron renderer just consumes the generated client.
- Request/response TS types come **only** from `electron/src/api/schema.ts` (auto-generated from `openapi.yaml`). Never hand-write them.
- Endpoints **must** be registered through Huma's `huma.Register(api, op, handler)`. Bare `net/http` handlers never appear in OpenAPI and are invisible to TS.

## Workflow

1. **Define the Go types and handler** in `internal/api/api.go` (or a sub-file in the same package).
   - Input struct: path/query/header tags drive OpenAPI parameters.
   - Output struct must wrap the JSON body in a `Body` field (Huma convention).
   - Annotate fields with `json:"..."`, `example:"..."`, `doc:"..."` so the generated TS is self-documenting.
   - Keep the handler thin; push real logic into a sub-package of `/internal`.

2. **Register the operation** in `api.Register(api huma.API)`:
   ```go
   huma.Register(api, huma.Operation{
       OperationID: "kebab-case-id",       // becomes the TS operation key
       Method:      http.MethodGet,        // or Post/Put/Patch/Delete
       Path:        "/things/{id}",
       Summary:     "One-line summary",
       Description: "Longer prose.",
       Tags:        []string{"domain"},
   }, handlerFn)
   ```

3. **Regenerate the contract**:
   ```
   task openapi    # Go reflects its routes into openapi.yaml
   task codegen    # openapi-typescript writes electron/src/api/schema.ts
   ```
   `task dev` and `task build` chain these automatically; running them individually is only needed for a one-shot check.

4. **Consume from the renderer** through `getClient()` in `electron/src/api/client.ts`. The client is `openapi-fetch` typed by `paths` from `schema.ts`:
   ```ts
   const client = await getClient();
   const { data, error } = await client.GET("/things/{id}", {
     params: { path: { id } },
   });
   ```
   The auth header (`X-Relay-Token`) is injected by the wrapper. Do not re-add it.

5. **Verify** with `task verify` before finishing. See the `verify` skill if it fails.

## Quick reference: existing example

`internal/api/api.go` already contains `get-health` and `greet` operations — mirror their shape rather than inventing a new style. Keep handler signatures `func(ctx, *In) (*Out, error)`.

## Things that will silently break the contract

- Returning a plain struct without `Body` wrapper → OpenAPI shows no response schema.
- Using `http.HandleFunc` on the mux directly → endpoint works at runtime but TS client has no type for it.
- Editing `electron/src/api/schema.ts` by hand → next `task codegen` overwrites it; Biome already ignores this file.
- Forgetting `task codegen` after `task openapi` → silent type drift between Go and TS.

## Definition of done

- New operation visible in `openapi.yaml` (diff shows the route under `paths:`).
- New entry visible in `electron/src/api/schema.ts` under `paths`.
- Renderer code that calls it typechecks (`task typecheck`).
- `task verify` passes.
