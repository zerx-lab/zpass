// 云同步 API 适配层 —— 包装后端 CloudService 的 Wails IPC
//
// 与 sync-api.ts / vault-api.ts 同样的桥接策略：通过 @wailsio/runtime 的
// Call.ByName 调用，组件层不直接 import bindings。
//
// 后端服务名：main.CloudService.<Method>
// 详见 desktop/internal/services/cloudservice.go（账户/认证）与
// cloudsync.go（同步引擎）。
//
// 零知识约束：主密码、Secret Key 只在调用入参里出现一次，立刻交给后端做
// Argon2id/SRP 派生，绝不写入任何 store / config / 日志。注册返回的
// secretKey 是用户唯一副本，UI 必须展示并提示用户离线保存。

import { Call as $WailsCall } from "@wailsio/runtime";
import type { SyncConflict } from "@/lib/sync-api";

export type { SyncConflict, SyncItem } from "@/lib/sync-api";

const SVC = "main.CloudService";

/* ----------------------------------------------------------------------------
 * 类型 —— 与 Go CloudStatus / RegisterResult / AccountResult / CloudSyncSummary
 * 字节对齐
 * -------------------------------------------------------------------------- */

export interface CloudStatus {
  configured: boolean;
  baseUrl: string;
  signedIn: boolean;
  email?: string;
  accountId?: string;
  /** OS 钥匙串后端标识（诊断用），如 "linux-secret-service" */
  storeBackend: string;
  /** 后端是否可持久化 token（钥匙串可用） */
  storePersist: boolean;
  /** 当前 server 已缓存一个持久化 token（快速解锁可用），但尚无活动会话 */
  hasCachedToken: boolean;
}

export interface RegisterResult {
  email: string;
  accountId: string;
  /** 用户唯一副本的 Secret Key（Z1- 前缀）。必须展示并提示离线保存。 */
  secretKey: string;
  signedIn: boolean;
}

export interface AccountResult {
  email: string;
  accountId: string;
  signedIn: boolean;
}

export interface CloudSyncSummary {
  vaults: number;
  pulled: number;
  pushed: number;
  conflicts: number;
  signedIn: boolean;
}

export interface LinkedSpace {
  spaceId: string;
  vaultId: string;
}

/* ----------------------------------------------------------------------------
 * 错误规范化 —— 同 vault-api 的 callWails
 * -------------------------------------------------------------------------- */

async function callCloud<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e =
      err instanceof Error ? err : new Error(String((err as { message?: string })?.message ?? err));
    // 诊断日志留在控制台；不把后端内部细节冒泡给用户文案。
    console.error(`[cloud-api] ${label} failed:`, e.message);
    throw e;
  }
}

/* ----------------------------------------------------------------------------
 * 配置 / 状态
 * -------------------------------------------------------------------------- */

/** 设置云端 server origin（前端启动时从持久化的 zpass.cloud.baseUrl 注入）。 */
export async function configureCloud(baseUrl: string): Promise<void> {
  await callCloud("Configure", () => $WailsCall.ByName(`${SVC}.Configure`, baseUrl) as Promise<void>);
}

export async function getCloudStatus(): Promise<CloudStatus> {
  return callCloud("Status", () => $WailsCall.ByName(`${SVC}.Status`) as Promise<CloudStatus>);
}

/* ----------------------------------------------------------------------------
 * 账户：注册 / 登录 / 登出
 * -------------------------------------------------------------------------- */

/** 注册新云账户。返回的 secretKey 必须展示给用户离线保存（不可恢复）。 */
export async function registerCloud(email: string, masterPassword: string): Promise<RegisterResult> {
  return callCloud(
    "Register",
    () => $WailsCall.ByName(`${SVC}.Register`, email, masterPassword) as Promise<RegisterResult>,
  );
}

/** SRP-6a 登录 + keyset 恢复。需要 email + 主密码 + Secret Key。 */
export async function signInCloud(
  email: string,
  masterPassword: string,
  secretKey: string,
): Promise<AccountResult> {
  return callCloud(
    "SignIn",
    () =>
      $WailsCall.ByName(`${SVC}.SignIn`, email, masterPassword, secretKey) as Promise<AccountResult>,
  );
}

export async function signOutCloud(): Promise<void> {
  await callCloud("SignOut", () => $WailsCall.ByName(`${SVC}.SignOut`) as Promise<void>);
}

/* ----------------------------------------------------------------------------
 * 同步：空间绑定 / 立即同步 / 冲突解决
 * -------------------------------------------------------------------------- */

/** 为一个本地空间创建云 vault 并绑定，返回 server 分配的 vaultId。 */
export async function createCloudVault(spaceId: string): Promise<string> {
  return callCloud(
    "CreateCloudVault",
    () => $WailsCall.ByName(`${SVC}.CreateCloudVault`, spaceId) as Promise<string>,
  );
}

export async function listLinkedSpaces(): Promise<LinkedSpace[]> {
  const arr = (await callCloud(
    "LinkedSpaces",
    () => $WailsCall.ByName(`${SVC}.LinkedSpaces`) as Promise<LinkedSpace[] | null>,
  )) as LinkedSpace[] | null;
  return arr ?? [];
}

export async function unlinkSpace(spaceId: string): Promise<void> {
  await callCloud("UnlinkSpace", () => $WailsCall.ByName(`${SVC}.UnlinkSpace`, spaceId) as Promise<void>);
}

export async function syncNow(): Promise<CloudSyncSummary> {
  return callCloud("SyncNow", () => $WailsCall.ByName(`${SVC}.SyncNow`) as Promise<CloudSyncSummary>);
}

export async function listCloudConflicts(): Promise<SyncConflict[]> {
  const arr = (await callCloud(
    "ListConflicts",
    () => $WailsCall.ByName(`${SVC}.ListConflicts`) as Promise<SyncConflict[] | null>,
  )) as SyncConflict[] | null;
  return arr ?? [];
}

export async function resolveCloudConflict(
  id: string,
  resolution: "local" | "remote" | "duplicate" | "skip",
): Promise<void> {
  await callCloud(
    "ResolveConflict",
    () => $WailsCall.ByName(`${SVC}.ResolveConflict`, id, resolution) as Promise<void>,
  );
}

export async function applyCloudMerge(): Promise<number> {
  return callCloud("ApplyMerge", () => $WailsCall.ByName(`${SVC}.ApplyMerge`) as Promise<number>);
}
