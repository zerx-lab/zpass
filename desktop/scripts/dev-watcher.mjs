// Dev-only watcher: rebuilds the Go sidecar on *.go changes and tells the
// running Electron main process to swap it in.
//
// Pipeline per change (debounced 300 ms, coalesced to one in-flight build):
//   1. task openapi  -> dump OpenAPI for any schema change
//   2. task codegen  -> regenerate electron/src/api/schema.ts (Vite HMRs renderer)
//   3. task build:go -> rebuild bin/<os>-<arch>/relay-backend
//   4. write .dev-reload (with epoch ms) -> main process's fs.watch fires
//      reloadBackend(), respawning the sidecar.
//
// The trigger-file IPC is used instead of POSIX signals so Windows works the
// same way as Linux/macOS (Node `process.kill(pid, "SIGUSR2")` is a no-op
// on Windows).
//
// Why a separate Node script (instead of doing this inside main.ts):
//   - Keeps `task` invocations out of Electron's main process.
//   - Survives main-process restarts caused by Forge HMR on main.ts changes.
//   - One queue, one debounce, no races between Forge restarts.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";

// fileURLToPath, not .pathname: on Windows the latter yields "/C:/..." which
// is not a valid filesystem path.
const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const RELOAD_FILE = resolve(REPO, ".dev-reload");
const IS_WIN = process.platform === "win32";

let pending = false;
let running = false;
let debounceTimer = null;

function log(msg) {
  process.stderr.write(`[watcher] ${msg}\n`);
}

function runTask(name) {
  return new Promise((res, rej) => {
    // shell:true so Windows resolves task.exe via PATHEXT. On POSIX it's a
    // harmless extra /bin/sh layer.
    const child = spawn("task", [name], {
      cwd: REPO,
      stdio: ["ignore", "inherit", "inherit"],
      shell: IS_WIN,
    });
    child.once("error", rej);
    child.once("exit", (code) =>
      code === 0 ? res() : rej(new Error(`task ${name} exit ${code}`)),
    );
  });
}

function notifyMain() {
  try {
    // Write epoch ms so successive notifications differ in content; this
    // guarantees fs.watch sees a "change" event even if the inode/size is
    // unchanged on some filesystems.
    writeFileSync(RELOAD_FILE, `${Date.now()}\n`);
    log("trigger written");
  } catch (err) {
    log(`trigger write failed: ${String(err)}`);
  }
}

async function rebuild() {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  try {
    log("rebuilding Go sidecar...");
    const t0 = Date.now();
    await runTask("openapi");
    await runTask("codegen");
    await runTask("build:go");
    log(`rebuilt in ${Date.now() - t0}ms`);
    notifyMain();
  } catch (err) {
    log(`build failed: ${String(err)}`);
  } finally {
    running = false;
    if (pending) {
      pending = false;
      void rebuild();
    }
  }
}

function schedule() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void rebuild();
  }, 300);
}

// chokidar v4+ removed glob support: pass directories + an `ignored` predicate
// that filters by extension/path. See chokidar README "Upgrading" section.
const IGNORED_DIRS = ["node_modules", ".vite", "bin", "out", ".git"];
const watcher = chokidar.watch(REPO, {
  ignoreInitial: true,
  ignored: (p, stats) => {
    const rel = p.startsWith(REPO) ? p.slice(REPO.length + 1) : p;
    if (rel === "") return false; // root dir itself
    const top = rel.split(/[\\/]/, 1)[0];
    if (IGNORED_DIRS.includes(top)) return true;
    // For files: only Go sources and module files are interesting. Also
    // exclude our own trigger file to avoid a watch->build->trigger loop.
    if (stats?.isFile()) {
      const base = rel.split(/[\\/]/).pop() ?? "";
      if (base === ".dev-reload") return true;
      return !(base.endsWith(".go") || base === "go.mod" || base === "go.sum");
    }
    return false;
  },
});

let readyLogged = false;
watcher.on("ready", () => {
  if (readyLogged) return;
  readyLogged = true;
  log("watching *.go / go.mod / go.sum (save to rebuild)");
});
watcher.on("add", schedule);
watcher.on("change", schedule);
watcher.on("unlink", schedule);

const stop = () => {
  void watcher.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
