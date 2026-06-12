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

/** 实时推送通道（SSE 长连接）状态枚举 —— 与 Go 端 cloud:realtime:state 事件对齐 */
export type CloudRealtimeState = "offline" | "connecting" | "connected" | "reconnecting";

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
  /** 实时推送通道状态：offline / connecting / connected / reconnecting */
  realtime?: CloudRealtimeState;
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

/** 云端一个 vault(空间)的零知识安全元数据 + 本地绑定状态。 */
export interface RemoteVault {
  vaultId: string;
  /** 服务端创建时间(RFC3339 字符串)。 */
  createdAt: string;
  /** 条目数(服务端可见的计数,不含明文)。 */
  itemCount: number;
  /** 同步高水位 seq。 */
  currentSeq: number;
  /** 当前账户在该 vault 的角色(owner/member 等)。 */
  role: string;
  /** 已绑定到的本地空间 id;空串 = 未绑定。 */
  boundSpaceId: string;
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

/**
 * 用本地解锁时输入的主密码静默恢复云会话。
 *
 * 零知识约束下账户私钥不落盘,每次启动必须用主密码重新派生;但 email +
 * Secret Key 已在上次登录时存进 OS 钥匙串,所以用户只在本地解锁处输入一次
 * 主密码,即可重建云会话并恢复自动同步——无需再走独立登录页。
 *
 * 无配置 / 未存凭据时返回 signedIn:false(不是错误),调用方可在每次解锁后
 * 无条件触发。返回 signedIn:false 或抛错都应被静默处理,绝不阻塞本地解锁。
 */
export async function restoreCloudSession(masterPassword: string): Promise<AccountResult> {
  return callCloud(
    "RestoreSession",
    () => $WailsCall.ByName(`${SVC}.RestoreSession`, masterPassword) as Promise<AccountResult>,
  );
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

/** 列出账户下所有云端 vault(空间)及其本地绑定状态。 */
export async function listRemoteVaults(): Promise<RemoteVault[]> {
  const arr = (await callCloud(
    "ListRemoteVaults",
    () => $WailsCall.ByName(`${SVC}.ListRemoteVaults`) as Promise<RemoteVault[] | null>,
  )) as RemoteVault[] | null;
  return arr ?? [];
}

/** 把一个已存在的云端 vault 绑定到本地空间(随后自动同步拉取其条目)。 */
export async function bindCloudVault(spaceId: string, vaultId: string): Promise<void> {
  await callCloud(
    "BindCloudVault",
    () => $WailsCall.ByName(`${SVC}.BindCloudVault`, spaceId, vaultId) as Promise<void>,
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

/** 唤醒实时通道：杀掉可能半开的 SSE 流立即重连并补偿同步（幂等、廉价）。 */
export async function pokeCloudRealtime(): Promise<void> {
  return callCloud("PokeRealtime", () => $WailsCall.ByName(`${SVC}.PokeRealtime`) as Promise<void>);
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
