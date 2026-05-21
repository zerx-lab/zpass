---
name: diagnose-dev-reload
description: Diagnose why `task dev` hot-restart isn't picking up Go changes (no sidecar respawn, stale endpoints, renderer hitting old port/token). Use when the user reports "I changed Go code but nothing happened", "the backend didn't reload", or "the watcher seems stuck".
---

## The reload pipeline (mental model)

`task dev` runs two processes via `concurrently`:

1. **Electron** (`pnpm run start`) — main process starts the Go sidecar from `bin/<os>-<arch>/relay-backend`, parses the handshake JSON line, and exposes `{port, token, baseUrl}` to the renderer via preload.
2. **Watcher** (`node scripts/dev-watcher.mjs`) — chokidar watches `*.go` / `go.mod` / `go.sum`, debounces 300ms, then runs `openapi → codegen → build:go` and writes `.dev-reload` (content: epoch ms).

The Electron main process `fs.watch`es the parent directory, filters by filename `.dev-reload`, dedups by `mtimeMs`, then:
- Kills the old sidecar.
- Spawns a new one (new port, new token).
- Calls `reloadIgnoringCache()` on all windows.
- Renderer's `getClient()` cache is invalidated by the reload.

## Checklist (run in order)

1. **Is the watcher actually running?**
   `task dev` should show two log streams (`electron` blue, `watcher` magenta). If only `electron` is logging, `concurrently` killed the watcher — look at terminal for an error. Common cause: chokidar v4+ failure because someone passed a glob instead of a directory.

2. **Does the watcher see your edit?**
   The watcher logs each detected change. Save a Go file. If nothing logs:
   - Confirm the file is under a watched directory (not under `node_modules`, `.git`, `bin/`, etc.).
   - On Linux check `cat /proc/sys/fs/inotify/max_user_watches` — exhausted watches silently drop events. Raise it if needed.
   - Confirm `scripts/dev-watcher.mjs` excludes `.dev-reload` itself; if it doesn't, the watcher self-loops and may throttle.

3. **Did the watcher rebuild?**
   After a detected change you should see `openapi → codegen → build:go` run in sequence. If `build:go` fails, the binary at `bin/<os>-<arch>/relay-backend` is **not** replaced — the next sidecar respawn would just run the old binary. Fix the compile error first.

4. **Was `.dev-reload` updated?**
   ```
   stat -c '%y %n' .dev-reload
   ```
   The mtime should match your last save. If not, the watcher's write step failed.

5. **Did Electron react?**
   The main process logs the respawn. If `.dev-reload` mtime advanced but no respawn:
   - The `fs.watch` may be filtering by a filename that doesn't match (Windows rename+change emits two events with different names — confirm the main process filter accepts both).
   - The `mtimeMs` dedup may treat two fast saves as one; that's intended, not a bug.

6. **Did the renderer reconnect?**
   New sidecar = new port and new token. Each window should `reloadIgnoringCache()` automatically. If the renderer logs `401 X-Relay-Token` it's still holding the old token — confirm `getClient()` is not cached in module scope above the `reload` boundary. The current implementation in `electron/src/api/client.ts` caches inside the module; the renderer reload clears it.

## Platform-specific pitfalls

- **Windows**: `process.kill(pid, "SIGUSR2")` is a no-op. Reload is intentionally driven by the `.dev-reload` trigger file, not signals — keep it that way.
- **Linux**: inotify watch limits silently drop events at scale. See step 2.
- **macOS**: FSEvents coalesces fast saves; the debounce in the watcher already accounts for that. Don't lower the debounce below ~300ms.

## Things that look like bugs but aren't

- **UI state lost on reload**: expected. Go has no hot code replacement; the sidecar is fully restarted and the renderer is fully reloaded. TS HMR (Forge's Vite) is a separate path that handles renderer-only edits without sidecar restart.
- **`schema.ts` changed but no reload happened**: that's the renderer side. Vite HMR handles it without touching the sidecar.
- **Two reloads back-to-back after a single save**: usually atomic-write editors (vim's `:w`) or Windows rename+change. The main process dedups by `mtimeMs`; if you still see doubles, your editor wrote twice with different mtimes.

## Quick reset

If state seems wedged:

```
task clean:dev        # rm .dev-reload
# Ctrl-C task dev
task dev
```

If the binary is suspect:

```
rm -rf bin
task build:go
task dev
```
