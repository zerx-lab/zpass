---
name: verify
description: Run the project's acceptance gate (`task verify`) and fix any typecheck, test, or lint failures it reports. Use before committing, before declaring a task done, or whenever the user asks to "verify", "run checks", or "make sure it passes".
disable-model-invocation: false
allowed-tools: Bash(task *) Bash(go *) Bash(pnpm *)
---

## What `task verify` actually runs

It aggregates three gates (see `Taskfile.yml`):

1. `task typecheck` — depends on `task codegen` (which depends on `task openapi`), then runs `pnpm run typecheck` (`tsc --noEmit`). This means **any Go API change is regenerated and typechecked here**, so TS errors from `schema.ts` drift are caught at this step.
2. `task test:go` — `go test ./...`.
3. `task lint` — runs both:
   - `lint:go`: `golangci-lint run ./...` (config: `.golangci.yml` — govet+nilness, staticcheck, errcheck, ineffassign, unused, gofmt).
   - `lint:ts`: `pnpm exec biome lint` (config: `biome.json`, `schema.ts` already excluded).

`task build` does **not** subsume verify; it only runs `build:go + codegen + typecheck + icons`. Tests and lint still must pass through verify.

## Workflow

1. Run `task verify`.
2. If it fails, read the **first** failure (later ones often cascade from it). Group fixes by phase:
   - **typecheck failures** → almost always TS code calling an operation/type that no longer matches `schema.ts`. Either the renderer code is stale, or the Go side changed without updating callers. Fix the renderer to match the regenerated types; do NOT hand-edit `schema.ts`.
   - **go test failures** → fix the code or the test. Don't disable tests to make verify pass.
   - **golangci-lint failures** → fix the cause; do not add `//nolint` unless the rule is genuinely wrong for that line (rare).
   - **biome failures** → run `pnpm exec biome check --write electron/src` only if the user already accepts auto-fixes; otherwise fix by hand to keep the diff surgical.
3. Re-run `task verify` until it is green.
4. Report the result. If verify still fails after reasonable attempts, surface the exact failure rather than claim success.

## Hard rules

- Do **not** "clean up" unrelated lint warnings to make the diff look tidy. Surgical changes only — every edit must trace to the user's request or to a failure verify just reported.
- Do **not** add new lint rules or relax existing ones to dodge a failure. New rules go into `.golangci.yml` / `biome.json` **first**, then the code is written to satisfy them.
- Do **not** mark a task complete while verify is red. State the failure explicitly.

## Common pitfalls

- **TS errors after a Go change**: you forgot the codegen chain. `task typecheck` already depends on `task codegen` which depends on `task openapi`, so running `task verify` should regenerate. If something feels stale, run `task openapi && task codegen` manually and inspect `openapi.yaml` and `electron/src/api/schema.ts`.
- **`relay-backend not found`**: tests/typecheck don't need the binary, but if you tried `task build` first and it errored before `build:go`, the bin is missing. Run `task build:go`.
- **Biome flags `schema.ts`**: it shouldn't — `biome.json` already excludes it. If you see this, check whether someone copied generated content into another file.
