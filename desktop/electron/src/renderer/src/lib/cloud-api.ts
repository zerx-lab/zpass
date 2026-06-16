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
  /**
   * 解密后的空间名称(后端用 vault key 解出;服务端只存密文)。
   * 空串 = 旧 vault 尚未回填 meta,自动镜像会跳过,留手动绑定兜底。
   */
  name: string;
  glyph: string;
  tag: string;
  /**
   * 降级冻结:套餐 max_vaults 调低后,该 vault 落在活跃配额外 —— 服务端
   * 保留数据、放行读取,但拒绝写入(403 vault_frozen),直到用户改选活跃
   * 空间或升级套餐。
   */
  frozen: boolean;
}

/** 一个配额维度(limit 为 null = 不限;storage 维度单位为字节,其余为计数)。 */
export interface CloudEntitlementUsage {
  dimension: string;
  limit: number | null;
  current: number;
}

/** GET /v1/entitlements:套餐生效限额/用量 + 降级冻结的 vault 列表。 */
export interface CloudEntitlements {
  plan: string;
  dimensions: CloudEntitlementUsage[];
  frozenVaultIds: string[];
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

/**
 * 为一个本地空间创建云 vault 并绑定，返回 server 分配的 vaultId。
 * name/glyph/tag 镜像本地空间,用 vault key 加密后存服务端(零知识),
 * 其他设备据此自动重建同名本地空间。
 */
export async function createCloudVault(
  spaceId: string,
  name: string,
  glyph = "",
  tag = "",
): Promise<string> {
  return callCloud(
    "CreateCloudVault",
    () =>
      $WailsCall.ByName(`${SVC}.CreateCloudVault`, spaceId, name, glyph, tag) as Promise<string>,
  );
}

/** 更新云 vault 的加密元数据(本地空间重命名后调用;旧 vault 回填也走这里)。 */
export async function setVaultMeta(
  vaultId: string,
  name: string,
  glyph = "",
  tag = "",
): Promise<void> {
  await callCloud(
    "SetVaultMeta",
    () => $WailsCall.ByName(`${SVC}.SetVaultMeta`, vaultId, name, glyph, tag) as Promise<void>,
  );
}

/**
 * 删除云端 vault(仅 owner;服务端拒绝删最后一个 vault)。
 * 调用方应先 unlinkSpace 解除本地绑定。
 */
export async function deleteRemoteVault(vaultId: string): Promise<void> {
  await callCloud(
    "DeleteRemoteVault",
    () => $WailsCall.ByName(`${SVC}.DeleteRemoteVault`, vaultId) as Promise<void>,
  );
}

/** 一条 vault 删除墓碑(零知识:只含 vaultId + seq + 时间)。 */
export interface DeletedVault {
  vaultId: string;
  /** 全局单调游标;客户端保存收到的最大 seq 作下次 since。 */
  seq: number;
  deletedAt: string;
}

/** GET /v1/vaults/deleted 的一页结果。 */
export interface DeletedVaultsPage {
  deleted: DeletedVault[];
  nextCursor: number;
  hasMore: boolean;
}

/**
 * 拉取账户下 seq > since 的 vault 删除墓碑(增量)。reconcile 据此把"主动删除"
 * (命中本地绑定 → 自动删本地空间)与"失去访问"(保留 detached)区分开。
 * limit=0 时服务端用默认页大小。
 */
export async function listDeletedVaults(since: number, limit = 0): Promise<DeletedVaultsPage> {
  const page = (await callCloud(
    "ListDeletedVaults",
    () =>
      $WailsCall.ByName(`${SVC}.ListDeletedVaults`, since, limit) as Promise<DeletedVaultsPage | null>,
  )) as DeletedVaultsPage | null;
  return page ?? { deleted: [], nextCursor: since, hasMore: false };
}

/** 判断错误是否为套餐限额(403 plan_limit_exceeded)。 */
export function isPlanLimitError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return msg.includes("plan_limit_exceeded");
}

/** 判断错误是否为降级冻结(403 vault_frozen:vault 只读,写入被拒)。 */
export function isVaultFrozenError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return msg.includes("vault_frozen");
}

/**
 * 把某云 vault 置顶为活跃空间(降级冻结模型的换选)。被挤出活跃集合的
 * vault 转为冻结只读,数据不动;不限额账户调用无副作用。
 */
export async function activateRemoteVault(vaultId: string): Promise<void> {
  await callCloud(
    "ActivateRemoteVault",
    () => $WailsCall.ByName(`${SVC}.ActivateRemoteVault`, vaultId) as Promise<void>,
  );
}

/** 拉取套餐配额与用量(客户端事前提示限额,不再只靠撞 403)。 */
export async function getCloudEntitlements(): Promise<CloudEntitlements> {
  return callCloud(
    "Entitlements",
    () => $WailsCall.ByName(`${SVC}.Entitlements`) as Promise<CloudEntitlements>,
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
