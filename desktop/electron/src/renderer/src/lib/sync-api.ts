// LAN 同步 API 适配层 —— 包装后端 SyncService 的 Wails IPC
//
// 与 vault-api.ts 同样的桥接策略：通过 @wailsio/runtime 的 Call.ByName
// 调用，组件层不直接 import bindings。
//
// 后端服务名：main.SyncService.<Method>
// 详见 desktop/internal/services/syncservice.go。

import { Call as $WailsCall } from "@wailsio/runtime";

/* ----------------------------------------------------------------------------
 * 类型 —— 与 Go SyncStatus / SyncConflict / SyncProgress 字节对齐
 * -------------------------------------------------------------------------- */

export interface SyncProgress {
  stage:
    | "idle"
    | "pairing"
    | "manifest"
    | "fetch"
    | "push"
    | "merge"
    | "commit"
    | "done"
    | "error";
  processed: number;
  total: number;
  message?: string;
  updatedAt: number;
}

export interface SyncManifestEntry {
  id: string;
  updatedAt: number;
  deletedAt?: number;
  contentHash?: string;
  revision?: number;
}

export interface SyncConflict {
  id: string;
  kind: "concurrent_edit" | "divergent_content" | "delete_vs_edit";
  /** 本端解密后的 payload（可能为 null：本端不存在 / 解密失败） */
  local: SyncItem | null;
  /** 对端解密后的 payload */
  remote: SyncItem | null;
  localManifest: SyncManifestEntry;
  remoteManifest: SyncManifestEntry;
  /** UI 默认勾选项：true 表示「建议保留对端」 */
  suggestedRemote: boolean;
  /** 用户已决策：local / remote / duplicate / skip */
  resolution?: "local" | "remote" | "duplicate" | "skip";
}

export interface SyncItem {
  id: string;
  type: string;
  name: string;
  fields: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
  revision?: number;
}

export interface SyncStatus {
  serverRunning: boolean;
  serverPort?: number;
  serverPin?: string;
  serverHosts?: string[];
  qrPayload?: string;
  active: boolean;
  role?: "server" | "client" | "";
  progress: SyncProgress;
  conflicts?: SyncConflict[];
}

/* ----------------------------------------------------------------------------
 * API
 * -------------------------------------------------------------------------- */

const SVC = "main.SyncService";

export async function startSyncServer(): Promise<SyncStatus> {
  return (await $WailsCall.ByName(`${SVC}.StartServer`)) as SyncStatus;
}

export async function stopSyncServer(): Promise<void> {
  await $WailsCall.ByName(`${SVC}.StopServer`);
}

export async function connectToSyncServer(
  baseUrl: string,
  pin: string,
): Promise<SyncStatus> {
  return (await $WailsCall.ByName(
    `${SVC}.ConnectToServer`,
    baseUrl,
    pin,
  )) as SyncStatus;
}

export async function disconnectSync(): Promise<void> {
  await $WailsCall.ByName(`${SVC}.Disconnect`);
}

export async function getSyncStatus(): Promise<SyncStatus> {
  return (await $WailsCall.ByName(`${SVC}.GetStatus`)) as SyncStatus;
}

export async function getPendingConflicts(): Promise<SyncConflict[]> {
  const arr = (await $WailsCall.ByName(
    `${SVC}.GetPendingConflicts`,
  )) as SyncConflict[] | null;
  return arr ?? [];
}

export async function resolveConflict(
  id: string,
  resolution: "local" | "remote" | "duplicate" | "skip",
): Promise<void> {
  await $WailsCall.ByName(`${SVC}.ResolveConflict`, id, resolution);
}

export async function applyMerge(): Promise<number> {
  return (await $WailsCall.ByName(`${SVC}.ApplyMerge`)) as number;
}

/* ----------------------------------------------------------------------------
 * QR payload helpers
 * -------------------------------------------------------------------------- */

/** 把 `zpass-sync://host:port?pin=xxx` 解析成 {baseUrl, pin}。 */
export function parseSyncQRPayload(
  payload: string,
): { baseUrl: string; pin: string } | null {
  try {
    const url = new URL(payload.replace(/^zpass-sync:\/\//, "http://"));
    const pin = url.searchParams.get("pin");
    if (!pin) return null;
    return { baseUrl: `http://${url.host}`, pin };
  } catch {
    return null;
  }
}
