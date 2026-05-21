// Spawns the Go backend as a sidecar child process, parses its handshake
// (the first stdout line — JSON with `port`, `token`, `baseUrl`), and exposes
// those values to the renderer via preload.
//
// The handshake is the single source of truth for how the renderer reaches
// the backend. Never hard-code the port: it is chosen by the OS at runtime.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

export interface Handshake {
  port: number;
  token: string;
  baseUrl: string;
}

export interface Backend {
  handshake: Handshake;
  process: ChildProcess;
  /** Kill the child process. Safe to call multiple times. */
  stop(): void;
}

/**
 * Resolve the path of the Go sidecar binary for the current platform.
 *
 * Dev mode: looks under `<repo>/bin/<platform>-<arch>/desktop-backend[.exe]`.
 * Packaged: looks under `process.resourcesPath/bin/...`.
 */
function resolveBinaryPath(): string {
  const exe =
    process.platform === "win32" ? "desktop-backend.exe" : "desktop-backend";
  const platformDir = `${process.platform}-${process.arch}`;

  const base = app.isPackaged
    ? join(process.resourcesPath, "bin")
    : join(app.getAppPath(), "bin");

  const candidate = join(base, platformDir, exe);
  if (!existsSync(candidate)) {
    throw new Error(
      `Go sidecar not found at ${candidate}. Run \`task build:go\` first.`,
    );
  }
  return candidate;
}

/**
 * Start the Go backend and resolve once the handshake JSON line is received.
 * Rejects if the child exits before printing the handshake.
 */
export function startBackend(): Promise<Backend> {
  return new Promise((resolve, reject) => {
    const binary = resolveBinaryPath();
    const child = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"] });

    let buf = "";
    let settled = false;
    const onStdout = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      child.stdout?.off("data", onStdout);
      try {
        const handshake = JSON.parse(line) as Handshake;
        settled = true;
        resolve({
          handshake,
          process: child,
          stop: () => {
            if (!child.killed) child.kill();
          },
        });
      } catch (err) {
        settled = true;
        reject(new Error(`invalid handshake line: ${line} (${String(err)})`));
        child.kill();
      }
    };
    child.stdout?.on("data", onStdout);

    // Forward stderr to our own stderr so panics are visible.
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[go] ${chunk.toString("utf8")}`);
    });

    child.once("exit", (code, signal) => {
      if (!settled) {
        reject(
          new Error(
            `Go backend exited before handshake (code=${code} signal=${signal})`,
          ),
        );
      }
    });
  });
}
