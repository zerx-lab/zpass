// ZPass Phone —— 云同步服务（服务 + 反应式状态合一单例）
//
// 移植 harmony CloudService.ets（角色对应 desktop cloudservice.go + cloudsync.go + 渲染层
// stores/cloud.ts）：账户注册 / SRP-6a 登录 / MFA / keyset 收发 / 多空间云 vault 创建·绑定·解绑 /
// 自动镜像 reconcile / 周期 + SSE 触发同步 / 冲突管理 / 套餐额度与冻结处理 / 持久化。
//
// 与 harmony 的差异（平台适配，行为等价）：
//   - 反应式：harmony @ObservedV2/@Trace → 这里用监听器注册表（subscribe/emit + 记忆化
//     getState 快照），由 contexts/cloud-context.tsx 经 useSyncExternalStore 消费。
//   - vaultStore.refresh() → 注册式 onVaultRefresh 回调（cloud-context 接到 vault-context.refresh）。
//     vaultStore.spaces/activeSpaceId/setActiveSpace → vaultService.listSpaces()/setActiveSpace。
//   - 解锁/锁定钩子由 vault-context 直接调 onVaultUnlocked(mp)/onVaultLocked（非 vaultStore 注册）。
//   - HUKS 密封 secrets → expo-secure-store（cloud-secrets.ts）。account.secrets 存哨兵
//     'secure-store'；真实 secretKey/token 落 SecureStore，文件里留空。
//
// 多空间模型：每个本地空间 ↔ 一个云 vault（1:1）。双向自动镜像见 reconcileSpaces/doReconcile。
// 零知识：主密码仅瞬时入参；账户私钥 / per-vault key 仅内存（锁定即清）；持久化只存 token +
// Secret Key（SecureStore）+ 每空间绑定 + 每空间每条目水位 + DEK 封装的云密码（仅本机可解）。

import {
  APIError,
  CloudClient,
  type DeletedVaultsResponse,
  type EntitlementDimension,
  type Entitlements,
  type EventStreamHandle,
  type KdfParams,
  type VaultSummary,
} from "./cloud-client";
import {
  CLOUD_ARGON2_ITER,
  CLOUD_ARGON2_MEM_KIB,
  CLOUD_ARGON2_PAR,
  CLOUD_KDF_ALG,
  CLOUD_SALT_LEN,
  CLOUD_SK_VERSION,
  deriveAuk,
  deriveSrpX,
  generateKeyset,
  generateSecretKey,
  generateVaultKey,
  openVaultKey,
  openVaultMeta,
  parseSecretKey,
  sealVaultKey,
  sealVaultMeta,
  srpFinish,
  srpMakeVerifier,
  srpStart,
  unwrapAccountPrivKey,
  verifyServerM2,
  wrapAccountPrivKey,
  type ParsedSecretKey,
} from "./cloud-crypto";
import {
  clearCloudState,
  loadCloudState,
  saveCloudState,
  type CloudAccountRecord,
  type CloudItemSyncState,
  type CloudVaultBinding,
} from "./cloud-storage";
import {
  CloudSyncError,
  resolveConflictLocal,
  resolveConflictRemote,
  runCloudSync,
  type CloudConflict,
  type SyncContext,
} from "./cloud-sync";
import { deleteCloudSecrets, loadCloudSecrets, saveCloudSecrets } from "./cloud-secrets";
import { fromB64, randomBytes, toB64, utf8, utf8Decode, wipeBytes } from "./crypto";
import { vaultService, type SpaceMutationEvent } from "./vault-service";
import { DEFAULT_SPACE_ID, deriveGlyph, type Space } from "./spaces";

const PERIODIC_SYNC_MS = 90_000;
const NUDGE_DEBOUNCE_MS = 2_000;
const FULL_UPGRADE_MS = 6 * 60 * 60 * 1000;
/** account.secrets 哨兵：真实凭据存 expo-secure-store，文件里只记此标记。 */
const SECURE_STORE_SENTINEL = "secure-store";

/** 生产云服务地址（固定）。生产环境直接使用；也是开发默认值的回退。 */
export const DEFAULT_CLOUD_BASE_URL = "https://zpass-app.zerx.dev";

/**
 * 开发期本地云后端地址。由 Taskfile 注入的 EXPO_PUBLIC_CLOUD_DEV_URL 决定，未注入回退
 * localhost:8080（Expo 打包时把 EXPO_PUBLIC_* 内联进 bundle）。
 *   - Android 模拟器访问宿主机：http://10.0.2.2:8080
 *   - 真机：宿主机 LAN IP，如 http://192.168.x.x:8080
 */
const DEV_CLOUD_URL = (process.env.EXPO_PUBLIC_CLOUD_DEV_URL ?? "").trim();
export const LOCAL_CLOUD_BASE_URL = DEV_CLOUD_URL || "http://localhost:8080";

/**
 * 冷启动无持久化地址时的初始云服务地址：
 *   - 生产 / 未注入开发地址 → 线上 DEFAULT_CLOUD_BASE_URL；
 *   - 开发模式且注入了 EXPO_PUBLIC_CLOUD_DEV_URL → 本地后端（免去每次手动切换）。
 * dev 仍可在云账户页一键切换；生产环境切换入口被 __DEV__ 隐藏。
 */
export const INITIAL_CLOUD_BASE_URL =
  __DEV__ && DEV_CLOUD_URL ? LOCAL_CLOUD_BASE_URL : DEFAULT_CLOUD_BASE_URL;

interface MfaPending {
  mfaToken: string;
  email: string;
  sk: ParsedSecretKey;
  secretKeyStr: string;
  auk: Uint8Array;
}

interface KeysetSession {
  priv: Uint8Array;
  pub: Uint8Array;
}

/** 云保险库数量配额（max_vaults 维度投影）：limit=null 表示不限。 */
interface VaultQuota {
  limit: number | null;
  current: number;
}

/** 单个空间的云同步状态投影（页面列表渲染用）。 */
export interface SpaceCloudStatus {
  spaceId: string;
  spaceName: string;
  /** 已绑定的云 vault id（未绑定为 ''）。 */
  vaultId: string;
  bound: boolean;
  /** 该空间的 vault 因套餐降级冻结（可拉取、不可写入）。 */
  frozen: boolean;
  /** 用户显式解绑，不参与自动镜像。 */
  detached: boolean;
  /** 自动镜像因套餐额度（云保险库数量）失败。 */
  overQuota: boolean;
}

/** 远端 vault 概要（解密名 + 本地绑定标注），供 UI 展示与手动绑定。 */
export interface RemoteVaultInfo {
  vaultId: string;
  name: string;
  itemCount: number;
  frozen: boolean;
  boundSpaceId: string;
}

/** 反应式公开状态快照（contexts/cloud-context.tsx 经 useSyncExternalStore 消费）。 */
export interface CloudPublicState {
  configured: boolean;
  baseUrl: string;
  hasAccount: boolean;
  signedIn: boolean;
  email: string;
  accountId: string;
  anyBound: boolean;
  spaceStates: SpaceCloudStatus[];
  plan: string;
  syncing: boolean;
  lastSyncAt: number;
  lastError: string;
  conflicts: CloudConflict[];
  secretKeyBackup: string;
  hydrated: boolean;
  mfaRequired: boolean;
}

export class CloudService {
  /* ----- 反应式状态（getState 投影；写后 emit） ----- */
  private configured = false;
  private baseUrl = "";
  private hasAccount = false;
  private signedIn = false;
  private emailAddr = "";
  private accountIdStr = "";
  private anyBound = false;
  private spaceStates: SpaceCloudStatus[] = [];
  private plan = "";
  private syncing = false;
  private lastSyncAt = 0;
  private lastError = "";
  private conflicts: CloudConflict[] = [];
  private secretKeyBackup = "";
  private hydrated = false;
  private mfaRequired = false;

  /* ----- 监听器 + 记忆化快照 ----- */
  private listeners = new Set<() => void>();
  private snapshot: CloudPublicState | null = null;
  /** UI 刷新回调（cloud-context 接到 vault-context.refresh）。 */
  private onVaultRefresh: (() => void | Promise<void>) | null = null;

  /* ----- 内存会话（锁定即清） ----- */
  private client: CloudClient | null = null;
  private accountPriv: Uint8Array | null = null;
  private accountPub: Uint8Array | null = null;
  private secretKey = "";
  private token = "";
  private userId = "";
  private tenantId = "";
  private secretsInSecureStore = false;
  private bindings = new Map<string, CloudVaultBinding>();
  private vaultKeys = new Map<string, Uint8Array>();
  private syncStates = new Map<string, Map<string, CloudItemSyncState>>();
  private frozenVaultIds = new Set<string>();
  private detachedSpaces = new Set<string>();
  private overQuotaSpaces = new Set<string>();
  private tombstoneCursor = 0;
  private pendingRemoteDeletes = new Set<string>();

  private periodicTimer: ReturnType<typeof setInterval> | undefined;
  private nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  private autoRestoreDisabled = false;
  private lastFullSyncAt = 0;
  private reconciling = false;
  private reconcilePending = false;
  private syncPending = false;
  private pendingFull = false;
  private eventStream: EventStreamHandle | null = null;
  private realtimeStopped = true;
  private realtimeBackoff = 1000;
  private realtimeTimer: ReturnType<typeof setTimeout> | undefined;
  private realtimeConnectedAt = 0;
  private nudgeFull = false;
  private mfaPending: MfaPending | null = null;
  private wrappedPasswordB64 = "";
  private freshLocalVault = false;
  private removeDefaultAfterFocus = false;

  /* ------------------------------------------------------------------------ */
  /* 反应式接口                                                                */
  /* ------------------------------------------------------------------------ */

  /** 订阅状态变化（useSyncExternalStore）；返回取消订阅函数。 */
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  /** 记忆化状态快照（同一引用直到下次 emit），供 useSyncExternalStore 比较。 */
  getState = (): CloudPublicState => {
    if (!this.snapshot) {
      this.snapshot = {
        configured: this.configured,
        baseUrl: this.baseUrl,
        hasAccount: this.hasAccount,
        signedIn: this.signedIn,
        email: this.emailAddr,
        accountId: this.accountIdStr,
        anyBound: this.anyBound,
        spaceStates: this.spaceStates,
        plan: this.plan,
        syncing: this.syncing,
        lastSyncAt: this.lastSyncAt,
        lastError: this.lastError,
        conflicts: this.conflicts,
        secretKeyBackup: this.secretKeyBackup,
        hydrated: this.hydrated,
        mfaRequired: this.mfaRequired,
      };
    }
    return this.snapshot;
  };

  private emit(): void {
    this.snapshot = null;
    this.listeners.forEach((l) => l());
  }

  /** 注册 vault 刷新回调（cloud-context 接到 vault-context.refresh）。 */
  registerVaultRefresh(cb: () => void | Promise<void>): void {
    this.onVaultRefresh = cb;
  }

  private async notifyVaultRefresh(): Promise<void> {
    if (!this.onVaultRefresh) return;
    try {
      await this.onVaultRefresh();
    } catch {
      // 刷新失败不影响同步结果
    }
  }

  /** 清除注册后一次性展示的 Secret Key（用户备份后调用）。 */
  dismissSecretKeyBackup(): void {
    this.secretKeyBackup = "";
    this.emit();
  }

  /* ------------------------------------------------------------------------ */
  /* 启动水合                                                                  */
  /* ------------------------------------------------------------------------ */

  /** 冷启动加载持久化的云状态（不建立会话；会话待解锁时恢复）。 */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    try {
      const st = await loadCloudState();
      if (st.account) {
        this.baseUrl = st.account.baseUrl;
        this.emailAddr = st.account.email;
        this.accountIdStr = st.account.accountId;
        this.userId = st.account.userId;
        this.tenantId = st.account.tenantId;
        this.configured = this.baseUrl.length > 0;
        this.hasAccount = true;
        this.client = new CloudClient(this.baseUrl);
        await this.loadSecrets(st.account);
        this.wrappedPasswordB64 = st.account.wrappedPassword;
        if (this.token) this.client.setToken(this.token);
      }
      if (!this.baseUrl) this.baseUrl = INITIAL_CLOUD_BASE_URL;
      this.configured = this.baseUrl.length > 0;
      if (!this.client) this.client = new CloudClient(this.baseUrl);
      for (const b of st.vaults) {
        this.bindings.set(b.spaceId, { spaceId: b.spaceId, vaultId: b.vaultId, cursor: b.cursor });
      }
      if (st.syncState) {
        for (const spaceId of Object.keys(st.syncState)) {
          const inner = st.syncState[spaceId];
          const m = new Map<string, CloudItemSyncState>();
          for (const id of Object.keys(inner)) m.set(id, inner[id]);
          this.syncStates.set(spaceId, m);
        }
      }
      if (st.detached) for (const id of st.detached) this.detachedSpaces.add(id);
      this.tombstoneCursor = st.tombstoneCursor;
      if (st.pendingRemoteDeletes) for (const id of st.pendingRemoteDeletes) this.pendingRemoteDeletes.add(id);
      this.anyBound = this.bindings.size > 0;
    } catch {
      // 损坏/缺失 → 空状态
    } finally {
      this.hydrated = true;
      vaultService.registerMutationHook(() => this.nudge());
      vaultService.registerSpaceHook((e: SpaceMutationEvent) => {
        void this.handleSpaceMutation(e);
      });
      await this.refreshSpaceStates();
      this.emit();
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 配置                                                                      */
  /* ------------------------------------------------------------------------ */

  /** 设置云服务地址（http(s)://host:port）。 */
  configure(baseUrl: string): void {
    const b = (baseUrl ?? "").trim();
    if (!b) throw new Error("请输入云服务地址");
    this.baseUrl = b;
    if (!this.client) this.client = new CloudClient(b);
    else this.client.setBaseURL(b);
    this.configured = true;
    this.emit();
  }

  /** 标记本地保险库刚为「首次使用即选云同步」新建（首登对账后清占位默认空间）。 */
  markFreshLocalVault(): void {
    this.freshLocalVault = true;
  }

  /**
   * vault 解锁后补封装云主密码（云优先首登：register/signIn 时本地 vault 尚未建/解锁，
   * establishSession 内的封装会静默失败；建库解锁后调此方法补封装，确保后续解锁
   * （含生物识别、本地密码 ≠ 云密码）自动恢复云会话）。
   */
  persistAutoUnlockCredential(cloudPassword: string): void {
    this.refreshWrappedPassword(cloudPassword);
    void this.persist();
  }

  /* ------------------------------------------------------------------------ */
  /* 注册 / 登录                                                               */
  /* ------------------------------------------------------------------------ */

  /** 注册新账户；返回一次性 Secret Key（用户须离线备份）。 */
  async register(email: string, masterPassword: string): Promise<string> {
    this.ensureClient();
    const em = (email ?? "").trim().toLowerCase();
    if (!em || em.indexOf("@") < 0) throw new Error("请输入有效邮箱");
    if (!masterPassword || masterPassword.length < 8) throw new Error("主密码至少 8 位");

    const secretKey = generateSecretKey();
    const sk = parseSecretKey(secretKey);
    const saltEnc = randomBytes(CLOUD_SALT_LEN);
    const saltAuth = randomBytes(CLOUD_SALT_LEN);
    let auk: Uint8Array | null = null;
    let srpX: Uint8Array | null = null;
    try {
      auk = await deriveAuk(masterPassword, saltEnc, sk, CLOUD_ARGON2_MEM_KIB, CLOUD_ARGON2_ITER, CLOUD_ARGON2_PAR);
      srpX = await deriveSrpX(masterPassword, saltAuth, sk, CLOUD_ARGON2_MEM_KIB, CLOUD_ARGON2_ITER, CLOUD_ARGON2_PAR);
      const reg = srpMakeVerifier(srpX, saltAuth);
      const kdf: KdfParams = {
        alg: CLOUD_KDF_ALG,
        m: CLOUD_ARGON2_MEM_KIB,
        t: CLOUD_ARGON2_ITER,
        p: CLOUD_ARGON2_PAR,
        salt_enc: toB64(saltEnc),
        sk_version: CLOUD_SK_VERSION,
      };
      const resp = await this.client!.register({
        email: em,
        srp_salt: toB64(reg.salt),
        srp_verifier: toB64(reg.verifier),
        kdf_params: kdf,
      });
      this.applyToken(resp.session_token);
      this.userId = resp.user_id;
      this.tenantId = resp.tenant_id;

      const ks = generateKeyset();
      const wrapped = wrapAccountPrivKey(auk, ks.privateKey);
      await this.client!.putKeyset({
        public_key: toB64(ks.publicKey),
        encrypted_private_key: toB64(wrapped),
        algo: "x25519",
      });

      this.establishSession(em, sk.accountId, secretKey, masterPassword, ks.privateKey, ks.publicKey);
      await this.refreshSecretsBlob();
      await this.persist();
      this.secretKeyBackup = secretKey;
      this.emit();
      this.kickReconcile();
      return secretKey;
    } catch (e) {
      throw this.friendly(e);
    } finally {
      wipeBytes(auk);
      wipeBytes(srpX);
    }
  }

  /** 首次在本设备登录（需输入 Secret Key）。 */
  async signIn(email: string, masterPassword: string, secretKey: string): Promise<void> {
    if (!secretKey || !secretKey.trim()) throw new Error("请输入 Secret Key");
    await this.signInInternal((email ?? "").trim().toLowerCase(), masterPassword, secretKey.trim());
  }

  /** 用已保存的邮箱 + Secret Key 重新登录（优先 DEK 封装的真实云密码，兼容本地密码 ≠ 云密码）。 */
  async restoreSession(masterPassword: string): Promise<void> {
    if (!this.hasAccount || !this.emailAddr || !this.secretKey) throw new Error("无已保存的云账户");
    const wrapped = this.unwrapCloudPassword();
    const typed = masterPassword ?? "";
    if (!wrapped && !typed) throw new Error("请输入主密码");
    if (wrapped) {
      try {
        await this.signInInternal(this.emailAddr, wrapped, this.secretKey);
        return;
      } catch (e) {
        if (!typed || typed === wrapped) throw e instanceof Error ? e : new Error(String(e));
      }
    }
    await this.signInInternal(this.emailAddr, typed, this.secretKey);
  }

  private async signInInternal(email: string, masterPassword: string, secretKeyStr: string): Promise<void> {
    this.ensureClient();
    if (!email || email.indexOf("@") < 0) throw new Error("请输入有效邮箱");
    if (!masterPassword) throw new Error("请输入主密码");
    const sk = parseSecretKey(secretKeyStr);
    const start = srpStart();
    let srpX: Uint8Array | null = null;
    let auk: Uint8Array | null = null;
    let transferred = false;
    try {
      const ls = await this.client!.loginStart({ email, A: toB64(start.aPub) });
      const saltAuth = fromB64(ls.srp_salt);
      const saltEnc = fromB64(ls.kdf_params.salt_enc);
      const m = ls.kdf_params.m;
      const t = ls.kdf_params.t;
      const p = ls.kdf_params.p;
      srpX = await deriveSrpX(masterPassword, saltAuth, sk, m, t, p);
      const proof = srpFinish(start.secretA, start.aPub, fromB64(ls.B), srpX, saltAuth, email);
      const lf = await this.client!.loginFinish({ login_id: ls.login_id, M1: toB64(proof.m1) });
      const ok = verifyServerM2(start.aPub, proof.m1, proof.k, fromB64(lf.M2));
      if (!ok) throw new Error("服务端身份校验失败（M2 不匹配）—— 地址有误或遭遇中间人");
      auk = await deriveAuk(masterPassword, saltEnc, sk, m, t, p);
      if (lf.mfa_required === true && lf.mfa_token) {
        this.clearMfaPending();
        this.mfaPending = { mfaToken: lf.mfa_token, email, sk, secretKeyStr, auk };
        this.mfaRequired = true;
        transferred = true;
        this.emit();
        return;
      }
      if (!lf.session_token) throw new Error("登录失败：邮箱、主密码或 Secret Key 不正确");
      this.applyToken(lf.session_token);
      const sess = await this.recoverKeyset(auk);
      this.establishSession(email, sk.accountId, secretKeyStr, masterPassword, sess.priv, sess.pub);
      await this.refreshSecretsBlob();
      await this.persist();
      this.emit();
      this.kickReconcile();
    } catch (e) {
      throw this.friendly(e);
    } finally {
      wipeBytes(srpX);
      if (!transferred) wipeBytes(auk);
    }
  }

  /** 登出：清除内存会话 + 删除本地云状态。 */
  async signOut(): Promise<void> {
    const sid = this.sessionIdFromToken(this.token);
    if (sid && this.client && this.token) {
      try {
        await this.client.revokeSession(sid);
      } catch {
        // 离线 / 已失效 → 忽略
      }
    }
    this.tearDownSession();
    this.clearMfaPending();
    this.conflicts = [];
    this.hasAccount = false;
    this.emailAddr = "";
    this.accountIdStr = "";
    this.secretKey = "";
    this.secretsInSecureStore = false;
    this.wrappedPasswordB64 = "";
    this.plan = "";
    this.bindings.clear();
    this.syncStates.clear();
    this.frozenVaultIds.clear();
    this.detachedSpaces.clear();
    this.overQuotaSpaces.clear();
    this.tombstoneCursor = 0;
    this.pendingRemoteDeletes.clear();
    this.anyBound = false;
    this.lastFullSyncAt = 0;
    this.secretKeyBackup = "";
    this.freshLocalVault = false;
    this.removeDefaultAfterFocus = false;
    try {
      await deleteCloudSecrets();
    } catch {
      // 忽略
    }
    await clearCloudState();
    await this.refreshSpaceStates();
    this.emit();
  }

  /** 校验输入的 Secret Key 是否与当前云账户一致（清空云端数据前二次确认）。 */
  verifySecretKey(input: string): boolean {
    const norm = (s: string): string => (s ?? "").trim().split("-").join("").split(" ").join("").toUpperCase();
    const a = norm(input);
    return a.length > 0 && a === norm(this.secretKey);
  }

  /** 清空云端数据：删除账户下所有可删（owner）的云 vault，并清空本地绑定/水位/密钥（账户保持登录）。 */
  async clearAllCloudData(): Promise<void> {
    this.requireSession();
    const resp = await this.client!.listVaults();
    let transientFail = false;
    for (const v of resp.vaults) {
      try {
        await this.client!.deleteVault(v.vault_id);
      } catch (e) {
        if (e instanceof APIError && (e.status === 403 || e.status === 404)) continue;
        transientFail = true;
      }
    }
    if (transientFail) throw new Error("部分云保险库删除失败（网络问题），请联网后重试");
    this.bindings.forEach((b) => {
      const k = this.vaultKeys.get(b.vaultId);
      if (k) {
        wipeBytes(k);
        this.vaultKeys.delete(b.vaultId);
      }
    });
    this.bindings.clear();
    this.syncStates.clear();
    this.detachedSpaces.clear();
    this.overQuotaSpaces.clear();
    this.frozenVaultIds.clear();
    this.anyBound = false;
    await this.persist();
    await this.refreshSpaceStates();
    this.emit();
  }

  /* ------------------------------------------------------------------------ */
  /* 多空间云 vault 创建 / 绑定 / 解绑                                          */
  /* ------------------------------------------------------------------------ */

  /** 列出账户下的云 vault（解密名 + 本地绑定标注），供 UI 展示与手动绑定。 */
  async listRemoteVaults(): Promise<RemoteVaultInfo[]> {
    this.requireSession();
    try {
      const resp = await this.client!.listVaults();
      const boundBy = new Map<string, string>();
      this.bindings.forEach((b) => boundBy.set(b.vaultId, b.spaceId));
      const out: RemoteVaultInfo[] = [];
      for (const v of resp.vaults) {
        const name = await this.decryptRemoteName(v);
        out.push({
          vaultId: v.vault_id,
          name,
          itemCount: v.item_count,
          frozen: v.frozen,
          boundSpaceId: boundBy.get(v.vault_id) ?? "",
        });
      }
      return out;
    } catch (e) {
      throw this.friendly(e);
    }
  }

  /** 为某空间新建云 vault（铸新 vault key + 封装空间名 meta 上传），并刷新状态。 */
  async createCloudVault(spaceId: string, name?: string): Promise<void> {
    this.requireSession();
    if (!spaceId) throw new Error("空间 id 为空");
    if (this.bindings.has(spaceId)) return;
    try {
      await this.createVaultForSpace(spaceId, name);
    } catch (e) {
      throw this.friendly(e);
    }
    await this.persist();
    await this.refreshSpaceStates();
    this.emit();
    this.restartRealtime();
    await this.runSync(true);
  }

  /** 绑定已有云 vault 到某空间（账户私钥解封 wrapped_vault_key；1:1 校验），并立即首次同步。 */
  async bindCloudVault(spaceId: string, vaultId: string): Promise<void> {
    this.requireSession();
    if (!spaceId) throw new Error("空间 id 为空");
    if (!vaultId) throw new Error("vault id 为空");
    const existing = this.bindings.get(spaceId);
    if (existing) {
      if (existing.vaultId === vaultId) return;
      throw new Error("该空间已绑定其它云保险库，请先解绑");
    }
    let conflict = false;
    this.bindings.forEach((b) => {
      if (b.vaultId === vaultId && b.spaceId !== spaceId) conflict = true;
    });
    if (conflict) throw new Error("该云保险库已绑定到其它空间");
    try {
      const m = await this.client!.getVaultMemberSelf(vaultId);
      const vk = openVaultKey(this.accountPriv!, fromB64(m.wrapped_vault_key));
      this.vaultKeys.set(vaultId, vk);
      this.bindings.set(spaceId, { spaceId, vaultId, cursor: 0 });
      this.syncStates.set(spaceId, new Map<string, CloudItemSyncState>());
      this.detachedSpaces.delete(spaceId);
      this.overQuotaSpaces.delete(spaceId);
    } catch (e) {
      if (e instanceof APIError && e.isNotFound()) throw new Error("你不是该云保险库的成员");
      throw this.friendly(e);
    }
    await this.persist();
    await this.refreshSpaceStates();
    this.emit();
    this.restartRealtime();
    await this.runSync(true);
  }

  /** 解绑某空间的云 vault（仅移除本地绑定与水位，本地数据不动；标记 detached）。 */
  async unlinkSpace(spaceId: string): Promise<void> {
    const b = this.bindings.get(spaceId);
    this.bindings.delete(spaceId);
    this.syncStates.delete(spaceId);
    if (b) {
      this.frozenVaultIds.delete(b.vaultId);
      const k = this.vaultKeys.get(b.vaultId);
      if (k) {
        wipeBytes(k);
        this.vaultKeys.delete(b.vaultId);
      }
    }
    this.overQuotaSpaces.delete(spaceId);
    this.detachedSpaces.add(spaceId);
    this.anyBound = this.bindings.size > 0;
    await this.persist();
    await this.refreshSpaceStates();
    this.emit();
    this.restartRealtime();
  }

  /** 重新镜像某空间（清除解绑标记并新建云 vault）。 */
  async reuploadSpace(spaceId: string): Promise<void> {
    this.detachedSpaces.delete(spaceId);
    await this.createCloudVault(spaceId);
  }

  /** 查询套餐额度（刷新冻结集合与套餐名），返回原始 entitlements 供 UI 展示用量。 */
  async entitlements(): Promise<Entitlements> {
    this.requireSession();
    try {
      const ent = await this.client!.getEntitlements();
      this.plan = ent.plan;
      this.frozenVaultIds = new Set<string>();
      if (ent.frozen_vault_ids) for (const id of ent.frozen_vault_ids) this.frozenVaultIds.add(id);
      await this.refreshSpaceStates();
      this.emit();
      return ent;
    } catch (e) {
      throw this.friendly(e);
    }
  }

  /** 激活某个被冻结的 vault（套餐降级后换占可写名额），随后刷新额度并同步。 */
  async activateRemoteVault(vaultId: string): Promise<void> {
    this.requireSession();
    try {
      await this.client!.activateVault(vaultId);
    } catch (e) {
      throw this.friendly(e);
    }
    try {
      await this.entitlements();
    } catch {
      // 额度刷新失败不阻塞
    }
    await this.refreshSpaceStates();
    await this.runSync(true);
  }

  /* ------------------------------------------------------------------------ */
  /* 自动镜像（reconcile）                                                      */
  /* ------------------------------------------------------------------------ */

  /** 三步对账（云→本地领养/下拉 + 本地→云上传 + 全量同步 + 首登切焦点 + 清占位默认空间）。 */
  async reconcileSpaces(): Promise<void> {
    if (!this.signedIn) return;
    if (this.reconciling) {
      this.reconcilePending = true;
      await this.runSync(true);
      return;
    }
    this.reconciling = true;
    try {
      do {
        this.reconcilePending = false;
        let focusTarget = "";
        try {
          focusTarget = await this.doReconcile();
        } catch (e) {
          this.lastError = this.messageOf(e);
          this.emit();
        }
        await this.runSync(true);
        if (focusTarget) await this.maybeFocusPulledSpace(focusTarget);
        await this.cleanupPlaceholderDefault();
      } while (this.reconcilePending);
    } finally {
      this.reconciling = false;
    }
  }

  private kickReconcile(): void {
    this.reconcileSpaces()
      .then(() => {})
      .catch(() => {});
  }

  /** 三步对账实现。返回首个「下拉新建」空间 id（仅首次登录非空），供同步后切焦点。 */
  private async doReconcile(): Promise<string> {
    if (!vaultService.isUnlocked()) return "";
    let changed = false;
    if (await this.processDeletionTombstones()) changed = true;
    if (await this.retryPendingRemoteDeletes()) changed = true;
    const snap = await vaultService.listSpaces();
    const spaces = snap.spaces;
    const firstSignIn = this.bindings.size === 0;
    const wasFresh = this.freshLocalVault;
    this.freshLocalVault = false;

    const resp = await this.client!.listVaults();
    const remote = resp.vaults;
    const cloudHadRemoteVaults = remote.length > 0;
    const boundVaultIds = new Set<string>();
    this.bindings.forEach((b) => boundVaultIds.add(b.vaultId));

    let firstPulledSpaceId = "";

    // ── step 1：云 → 本地镜像 ──
    for (const v of remote) {
      const vid = v.vault_id;
      if (boundVaultIds.has(vid)) continue;
      if (this.pendingRemoteDeletes.has(vid)) continue;
      let name = await this.decryptRemoteName(v);
      if (!name) {
        if (v.item_count <= 0) continue;
        try {
          await this.ensureVaultKeyFor(vid);
        } catch {
          continue;
        }
        name = `云保险库 ${this.shortVaultId(vid)}`;
      }
      if (spaces.some((s) => s.name === name && this.detachedSpaces.has(s.id))) continue;
      const candidates = spaces.filter(
        (s) => s.name === name && !this.bindings.has(s.id) && !this.detachedSpaces.has(s.id),
      );
      try {
        if (candidates.length === 1) {
          if (await this.adoptRemoteVault(candidates[0].id, vid)) {
            boundVaultIds.add(vid);
            changed = true;
          }
        } else if (candidates.length === 0) {
          const space = await vaultService.createSpace(name, true);
          if (await this.adoptRemoteVault(space.id, vid)) {
            boundVaultIds.add(vid);
            changed = true;
            if (!firstPulledSpaceId) firstPulledSpaceId = space.id;
          }
        }
      } catch {
        // 单个 vault 镜像失败不影响其余
      }
    }

    // ── step 2：本地 → 云镜像 ──
    const toUpload: Space[] = [];
    for (const s of spaces) {
      if (this.bindings.has(s.id) || this.detachedSpaces.has(s.id)) continue;
      if (s.id === DEFAULT_SPACE_ID && cloudHadRemoteVaults) {
        const items = await vaultService.listItemsForSpace(s.id);
        if (items.length === 0) continue;
      }
      toUpload.push(s);
    }
    this.overQuotaSpaces.clear();
    if (toUpload.length > 0) {
      const quota = await this.fetchVaultQuota();
      let remaining = Number.POSITIVE_INFINITY;
      if (quota && quota.limit !== null) {
        remaining = quota.limit - quota.current;
        if (remaining < 0) remaining = 0;
      }
      if (toUpload.length > remaining) {
        for (const s of toUpload) this.overQuotaSpaces.add(s.id);
        this.lastError = "本地空间数超出套餐的云保险库上限，请在同步页手动选择要上云的空间";
      } else {
        let quotaHit = false;
        for (const s of toUpload) {
          if (quotaHit) {
            this.overQuotaSpaces.add(s.id);
            continue;
          }
          try {
            await this.createVaultForSpace(s.id, s.name);
            changed = true;
          } catch (e) {
            if (e instanceof APIError && e.isPlanLimit()) {
              quotaHit = true;
              this.overQuotaSpaces.add(s.id);
              this.lastError = "已达到套餐的云保险库数量上限，部分空间未上云";
            } else {
              this.lastError = this.messageOf(e);
            }
          }
        }
      }
    }

    if (changed) {
      await this.persist();
      this.restartRealtime();
      await this.notifyVaultRefresh();
    }
    await this.refreshSpaceStates();
    this.emit();
    if (wasFresh && firstSignIn && firstPulledSpaceId.length > 0) this.removeDefaultAfterFocus = true;
    return firstSignIn ? firstPulledSpaceId : "";
  }

  /** 首次登录把焦点从「空的默认空间」切到下拉落地的真实空间（仅当前空间无条目时切）。 */
  private async maybeFocusPulledSpace(spaceId: string): Promise<void> {
    try {
      if (!vaultService.isUnlocked()) return;
      await this.notifyVaultRefresh();
      const snap = await vaultService.listSpaces();
      if (!snap.spaces.some((s) => s.id === spaceId)) return;
      if (snap.activeSpaceId === spaceId) return;
      const activeItems = await vaultService.listItemsForSpace(snap.activeSpaceId);
      if (activeItems.length > 0) return;
      await vaultService.setActiveSpace(spaceId);
      await this.notifyVaultRefresh();
    } catch {
      // 焦点切换失败不影响同步结果
    }
  }

  /** 清除「首次使用即选云同步」遗留的占位默认空间（防御式多重前置校验）。 */
  private async cleanupPlaceholderDefault(): Promise<void> {
    if (!this.removeDefaultAfterFocus) return;
    this.removeDefaultAfterFocus = false;
    try {
      if (!vaultService.isUnlocked()) return;
      if (this.bindings.has(DEFAULT_SPACE_ID)) return;
      const snap = await vaultService.listSpaces();
      if (!snap.spaces.some((s) => s.id === DEFAULT_SPACE_ID)) return;
      if (snap.spaces.length <= 1) return;
      if (snap.activeSpaceId === DEFAULT_SPACE_ID) return;
      const items = await vaultService.listItemsForSpace(DEFAULT_SPACE_ID);
      if (items.length > 0) return;
      await vaultService.purgeSpace(DEFAULT_SPACE_ID);
      this.detachedSpaces.delete(DEFAULT_SPACE_ID);
      this.overQuotaSpaces.delete(DEFAULT_SPACE_ID);
      await this.notifyVaultRefresh();
      await this.refreshSpaceStates();
      this.emit();
    } catch {
      // best-effort
    }
  }

  /** 远端云保险库数量配额（max_vaults 维度）。失败/无维度 → null（回退逐个尝试）。 */
  private async fetchVaultQuota(): Promise<VaultQuota | null> {
    try {
      const ent = await this.client!.getEntitlements();
      this.plan = ent.plan;
      let dim: EntitlementDimension | null = null;
      for (const d of ent.dimensions) {
        if (d.dimension === "max_vaults") {
          dim = d;
          break;
        }
        if (!dim && d.dimension.indexOf("vault") >= 0) dim = d;
      }
      if (!dim) return null;
      return { limit: dim.limit, current: dim.current };
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 删除墓碑传播（reconcile step 0）                                           */
  /* ------------------------------------------------------------------------ */

  private async processDeletionTombstones(): Promise<boolean> {
    if (!this.signedIn || !this.client || !vaultService.isUnlocked()) return false;
    let changed = false;
    let purgedAny = false;
    for (let guard = 0; guard < 100; guard++) {
      let page: DeletedVaultsResponse | null = null;
      try {
        page = await this.client!.listDeletedVaults(this.tombstoneCursor, 0);
      } catch {
        break;
      }
      if (!page || page.deleted.length === 0) break;
      for (const d of page.deleted) {
        let spaceId = "";
        this.bindings.forEach((b) => {
          if (b.vaultId === d.vault_id) spaceId = b.spaceId;
        });
        if (!spaceId) continue;
        try {
          const b = this.bindings.get(spaceId);
          this.bindings.delete(spaceId);
          this.syncStates.delete(spaceId);
          if (b) {
            const k = this.vaultKeys.get(b.vaultId);
            if (k) {
              wipeBytes(k);
              this.vaultKeys.delete(b.vaultId);
            }
          }
          this.detachedSpaces.delete(spaceId);
          this.overQuotaSpaces.delete(spaceId);
          await vaultService.purgeSpace(spaceId);
          purgedAny = true;
          changed = true;
        } catch {
          // 单个 purge 失败：vault 已删，继续推进游标
        }
      }
      if (page.next_cursor > this.tombstoneCursor) {
        this.tombstoneCursor = page.next_cursor;
        changed = true;
      }
      if (!page.has_more) break;
    }
    if (purgedAny) {
      this.anyBound = this.bindings.size > 0;
      await this.notifyVaultRefresh();
    }
    return changed;
  }

  private async retryPendingRemoteDeletes(): Promise<boolean> {
    if (this.pendingRemoteDeletes.size === 0 || !this.client) return false;
    let changed = false;
    const ids: string[] = [];
    this.pendingRemoteDeletes.forEach((v) => ids.push(v));
    for (const vid of ids) {
      try {
        await this.client!.deleteVault(vid);
        this.pendingRemoteDeletes.delete(vid);
        changed = true;
      } catch (e) {
        if (e instanceof APIError && (e.status === 403 || e.status === 404)) {
          this.pendingRemoteDeletes.delete(vid);
          changed = true;
        }
      }
    }
    return changed;
  }

  private async deleteRemoteVaultBestEffort(vaultId: string): Promise<void> {
    try {
      await this.client!.deleteVault(vaultId);
    } catch (e) {
      if (e instanceof APIError && (e.status === 403 || e.status === 404)) return;
      this.pendingRemoteDeletes.add(vaultId);
      await this.persist();
    }
  }

  private async adoptRemoteVault(spaceId: string, vaultId: string): Promise<boolean> {
    try {
      const vk = await this.ensureVaultKeyFor(vaultId);
      if (!vk) return false;
      this.bindings.set(spaceId, { spaceId, vaultId, cursor: 0 });
      if (!this.syncStates.has(spaceId)) this.syncStates.set(spaceId, new Map<string, CloudItemSyncState>());
      this.overQuotaSpaces.delete(spaceId);
      this.anyBound = true;
      return true;
    } catch {
      return false;
    }
  }

  private async createVaultForSpace(spaceId: string, name?: string): Promise<void> {
    const nm = (name ?? (await this.resolveSpace(spaceId)).name).trim();
    const vk = generateVaultKey();
    const wrapped = sealVaultKey(this.accountPub!, vk);
    const metaBlob = toB64(sealVaultMeta(vk, { name: nm, glyph: deriveGlyph(nm) }));
    const resp = await this.client!.createVault({ wrapped_vault_key: toB64(wrapped), encrypted_meta: metaBlob });
    this.vaultKeys.set(resp.vault_id, vk);
    this.bindings.set(spaceId, { spaceId, vaultId: resp.vault_id, cursor: 0 });
    this.syncStates.set(spaceId, new Map<string, CloudItemSyncState>());
    this.detachedSpaces.delete(spaceId);
    this.overQuotaSpaces.delete(spaceId);
    this.anyBound = true;
  }

  /* ------------------------------------------------------------------------ */
  /* 同步                                                                      */
  /* ------------------------------------------------------------------------ */

  /** 手动「立即同步」—— 先对齐空间（领养/建库），再全量对账。 */
  async syncNow(): Promise<void> {
    await this.reconcileSpaces();
  }

  /** 核心同步：遍历所有空间绑定，逐空间全量重建或增量 delta。syncing 守护防重入。 */
  async runSync(full: boolean): Promise<void> {
    if (!this.signedIn) return;
    if (!vaultService.isUnlocked()) return;
    if (this.bindings.size === 0) return;
    if (this.syncing) {
      this.syncPending = true;
      if (full) this.pendingFull = true;
      return;
    }
    this.syncing = true;
    this.lastError = "";
    this.emit();
    let applied = 0;
    try {
      const list: CloudVaultBinding[] = [];
      this.bindings.forEach((b) => list.push(b));
      for (const b of list) {
        if (!this.bindings.has(b.spaceId)) continue;
        try {
          const vk = await this.ensureVaultKeyFor(b.vaultId);
          const ctx: SyncContext = { client: this.client!, vaultId: b.vaultId, spaceId: b.spaceId, vaultKey: vk };
          const st = this.stateFor(b.spaceId);
          const outcome = await runCloudSync(ctx, full, st, b.cursor);
          b.cursor = outcome.newCursor;
          if (outcome.frozen) this.frozenVaultIds.add(b.vaultId);
          else this.frozenVaultIds.delete(b.vaultId);
          this.mergeSpaceConflicts(b.spaceId, full, outcome.conflicts);
          applied += outcome.applied;
        } catch (e) {
          if (!(await this.handlePerBindingError(e, b))) break;
        }
      }
      this.lastSyncAt = Date.now();
      if (full) this.lastFullSyncAt = this.lastSyncAt;
      await this.persist();
      await this.refreshSpaceStates();
      if (applied > 0) await this.notifyVaultRefresh();
    } finally {
      this.syncing = false;
      this.emit();
    }
    if (this.syncPending) {
      const f = this.pendingFull;
      this.syncPending = false;
      this.pendingFull = false;
      await this.runSync(f);
    }
  }

  /** 逐绑定错误处理。返回 false 表示致命错误应终止整轮；true 表示已处理继续下一空间。 */
  private async handlePerBindingError(e: unknown, b: CloudVaultBinding): Promise<boolean> {
    if ((e instanceof CloudSyncError && e.code === "unauthorized") || (e instanceof APIError && e.isUnauthorized())) {
      this.tearDownSession();
      this.lastError = "云会话已失效，请重新登录";
      return false;
    }
    if (e instanceof APIError && e.isNotFound()) {
      await this.processDeletionTombstones();
      if (!this.bindings.has(b.spaceId)) return true;
      this.bindings.delete(b.spaceId);
      this.syncStates.delete(b.spaceId);
      const k = this.vaultKeys.get(b.vaultId);
      if (k) {
        wipeBytes(k);
        this.vaultKeys.delete(b.vaultId);
      }
      this.detachedSpaces.add(b.spaceId);
      this.anyBound = this.bindings.size > 0;
      this.lastError = `空间「${this.spaceNameOf(b.spaceId)}」已失去云访问权限，已解绑`;
      return true;
    }
    this.lastError = this.messageOf(e);
    return true;
  }

  /** 增量冲突合并：full 同步时丢弃该空间旧冲突；按 localId upsert 新冲突。 */
  private mergeSpaceConflicts(spaceId: string, full: boolean, incoming: CloudConflict[]): void {
    if (!full && incoming.length === 0) return;
    const byId = new Map<string, CloudConflict>();
    for (const c of this.conflicts) {
      if (full && c.spaceId === spaceId) continue;
      byId.set(c.localId, c);
    }
    for (const c of incoming) byId.set(c.localId, c);
    const out: CloudConflict[] = [];
    byId.forEach((c) => out.push(c));
    this.conflicts = out;
    this.emit();
  }

  /** 本地编辑后的去抖增量同步触发。 */
  nudge(): void {
    this.scheduleNudge(false);
  }

  private scheduleNudge(full: boolean): void {
    if (!this.signedIn || this.bindings.size === 0) return;
    if (full) this.nudgeFull = true;
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = undefined;
      const f = this.nudgeFull;
      this.nudgeFull = false;
      void this.runSync(f);
    }, NUDGE_DEBOUNCE_MS);
  }

  /** 解决一条冲突（'local' 采用本端 / 'remote' 采用对端）。 */
  async resolveConflict(localId: string, choice: string): Promise<void> {
    const conflict = this.conflicts.find((c) => c.localId === localId);
    if (!conflict) return;
    const b = this.bindings.get(conflict.spaceId);
    if (!b) {
      this.conflicts = this.conflicts.filter((c) => c.localId !== localId);
      this.emit();
      return;
    }
    try {
      const vk = await this.ensureVaultKeyFor(b.vaultId);
      const ctx: SyncContext = { client: this.client!, vaultId: b.vaultId, spaceId: b.spaceId, vaultKey: vk };
      const st = this.stateFor(b.spaceId);
      if (choice === "remote") await resolveConflictRemote(conflict, st);
      else await resolveConflictLocal(ctx, conflict, st);
      this.conflicts = this.conflicts.filter((c) => c.localId !== localId);
      await this.persist();
      this.emit();
      await this.notifyVaultRefresh();
    } catch (e) {
      this.handleSyncError(e);
      throw this.friendly(e);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 空间增删钩子（由 VaultService 调用）                                       */
  /* ------------------------------------------------------------------------ */

  private async handleSpaceMutation(e: SpaceMutationEvent): Promise<void> {
    if (!this.signedIn) return;
    try {
      if (e.kind === "delete") {
        let deletedVaultId = "";
        if (this.bindings.has(e.spaceId)) {
          const b = this.bindings.get(e.spaceId);
          deletedVaultId = b ? b.vaultId : "";
          this.bindings.delete(e.spaceId);
          this.syncStates.delete(e.spaceId);
          if (b) {
            const k = this.vaultKeys.get(b.vaultId);
            if (k) {
              wipeBytes(k);
              this.vaultKeys.delete(b.vaultId);
            }
          }
          this.anyBound = this.bindings.size > 0;
          await this.persist();
        }
        this.detachedSpaces.delete(e.spaceId);
        this.overQuotaSpaces.delete(e.spaceId);
        await this.refreshSpaceStates();
        this.emit();
        await this.runSync(false);
        if (deletedVaultId) await this.deleteRemoteVaultBestEffort(deletedVaultId);
      } else if (e.kind === "create") {
        await this.reconcileSpaces();
      } else if (e.kind === "rename") {
        await this.updateSpaceMeta(e.spaceId);
        await this.refreshSpaceStates();
        this.emit();
      }
    } catch {
      // best-effort：钩子失败不影响本地空间操作
    }
  }

  private async updateSpaceMeta(spaceId: string): Promise<void> {
    const b = this.bindings.get(spaceId);
    if (!b) return;
    const vk = await this.ensureVaultKeyFor(b.vaultId);
    const space = await this.resolveSpace(spaceId);
    const metaBlob = toB64(sealVaultMeta(vk, { name: space.name, glyph: deriveGlyph(space.name) }));
    await this.client!.updateVaultMeta(b.vaultId, { encrypted_meta: metaBlob });
  }

  /* ------------------------------------------------------------------------ */
  /* vault 锁定/解锁钩子（由 vault-context 调用）                               */
  /* ------------------------------------------------------------------------ */

  /** 页面进入时确保云会话已恢复（兜底：解锁钩子可能错过 / 先于 hydrate）。幂等。 */
  async ensureRestored(): Promise<void> {
    if (this.signedIn || !this.hasAccount) return;
    if (!vaultService.isUnlocked()) return;
    await this.onVaultUnlocked("");
  }

  /** 解锁 vault 后自动恢复云会话、自动镜像并同步（优先 DEK 封装云密码，兼容本地密码 ≠ 云密码）。 */
  async onVaultUnlocked(masterPassword: string): Promise<void> {
    if (!this.configured || !this.hasAccount || this.signedIn || this.autoRestoreDisabled) return;
    if (!masterPassword && !this.wrappedPasswordB64) return;
    try {
      await this.restoreSession(masterPassword);
      if (this.mfaRequired) {
        this.cancelMfa();
        this.autoRestoreDisabled = true;
        return;
      }
    } catch {
      this.autoRestoreDisabled = true;
    }
  }

  /** 锁定 vault：清除内存密钥、停周期同步（保留持久化账户待下次恢复）。 */
  onVaultLocked(): void {
    this.wipeSessionKeys();
    this.signedIn = false;
    this.conflicts = [];
    this.frozenVaultIds.clear();
    this.clearMfaPending();
    this.stopPeriodic();
    this.stopRealtime();
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = undefined;
    void this.refreshSpaceStates();
    this.emit();
  }

  /* ------------------------------------------------------------------------ */
  /* 内部                                                                      */
  /* ------------------------------------------------------------------------ */

  private ensureClient(): void {
    if (!this.client) {
      if (!this.baseUrl) throw new Error("云服务地址未配置");
      this.client = new CloudClient(this.baseUrl);
    }
  }

  private requireSession(): void {
    if (!this.signedIn || !this.accountPriv || !this.accountPub) throw new Error("请先登录云账户");
  }

  private stateFor(spaceId: string): Map<string, CloudItemSyncState> {
    let m = this.syncStates.get(spaceId);
    if (!m) {
      m = new Map<string, CloudItemSyncState>();
      this.syncStates.set(spaceId, m);
    }
    return m;
  }

  private async ensureVaultKeyFor(vaultId: string): Promise<Uint8Array> {
    const cached = this.vaultKeys.get(vaultId);
    if (cached) return cached;
    if (!this.accountPriv) throw new Error("云会话未建立，请重新登录");
    const m = await this.client!.getVaultMemberSelf(vaultId);
    const vk = openVaultKey(this.accountPriv, fromB64(m.wrapped_vault_key));
    this.vaultKeys.set(vaultId, vk);
    return vk;
  }

  private async decryptRemoteName(v: VaultSummary): Promise<string> {
    if (!v.encrypted_meta) return "";
    try {
      const vk = await this.ensureVaultKeyFor(v.vault_id);
      const meta = openVaultMeta(vk, fromB64(v.encrypted_meta));
      return meta.name;
    } catch {
      return "";
    }
  }

  private shortVaultId(id: string): string {
    return id.length > 8 ? id.slice(0, 8) : id;
  }

  private async resolveSpace(spaceId: string): Promise<Space> {
    const snap = await vaultService.listSpaces();
    const found = snap.spaces.find((s) => s.id === spaceId);
    if (found) return found;
    return { id: spaceId, name: spaceId, order: 0, createdAt: 0 };
  }

  private spaceNameOf(spaceId: string): string {
    const s = this.spaceStates.find((x) => x.spaceId === spaceId);
    return s ? s.spaceName : spaceId;
  }

  /** 由本地空间 + 绑定 + 冻结/解绑/超额集合投影 spaceStates。 */
  private async refreshSpaceStates(): Promise<void> {
    let spaces: Space[] = [];
    try {
      const snap = await vaultService.listSpaces();
      spaces = snap.spaces;
    } catch {
      this.spaceStates = [];
      this.anyBound = false;
      this.emit();
      return;
    }
    const out: SpaceCloudStatus[] = [];
    let anyBound = false;
    for (const s of spaces) {
      const b = this.bindings.get(s.id);
      const bound = b !== undefined;
      if (bound) anyBound = true;
      out.push({
        spaceId: s.id,
        spaceName: s.name,
        vaultId: bound ? b!.vaultId : "",
        bound,
        frozen: bound ? this.frozenVaultIds.has(b!.vaultId) : false,
        detached: this.detachedSpaces.has(s.id),
        overQuota: this.overQuotaSpaces.has(s.id),
      });
    }
    this.spaceStates = out;
    this.anyBound = anyBound;
    this.emit();
  }

  private applyToken(token: string): void {
    this.token = token;
    this.ensureClient();
    this.client!.setToken(token);
  }

  private establishSession(
    email: string,
    accountId: string,
    secretKey: string,
    cloudPassword: string,
    priv: Uint8Array,
    pub: Uint8Array,
  ): void {
    this.wipeSessionKeys();
    this.clearMfaPending();
    this.accountPriv = priv;
    this.accountPub = pub;
    this.emailAddr = email;
    this.accountIdStr = accountId;
    this.secretKey = secretKey;
    this.signedIn = true;
    this.hasAccount = true;
    this.autoRestoreDisabled = false;
    this.refreshWrappedPassword(cloudPassword);
    this.startPeriodic();
    this.startRealtime();
    this.emit();
  }

  /** 用本地保险库 DEK 封装云主密码并缓存（持久化在 persist 落盘）。仅 vault 解锁时可封装。 */
  private refreshWrappedPassword(cloudPassword: string): void {
    if (!cloudPassword) return;
    try {
      const ct = vaultService.sealCloudCredential(utf8(cloudPassword));
      this.wrappedPasswordB64 = toB64(ct);
    } catch {
      // vault 锁定 / 封装失败 → 保留旧值
    }
  }

  /** 解封 DEK 包裹的云主密码（需 vault 已解锁）；无封装 / 锁定 / 密文损坏返回 ''。 */
  private unwrapCloudPassword(): string {
    if (!this.wrappedPasswordB64) return "";
    try {
      const pt = vaultService.openCloudCredential(fromB64(this.wrappedPasswordB64));
      return utf8Decode(pt);
    } catch {
      return "";
    }
  }

  private wipeSessionKeys(): void {
    if (this.accountPriv) wipeBytes(this.accountPriv);
    this.vaultKeys.forEach((k) => wipeBytes(k));
    this.vaultKeys.clear();
    this.accountPriv = null;
    this.accountPub = null;
  }

  private tearDownSession(): void {
    this.wipeSessionKeys();
    this.signedIn = false;
    this.token = "";
    if (this.client) this.client.clearToken();
    this.stopPeriodic();
    this.stopRealtime();
    this.clearMfaPending();
    this.emit();
  }

  private handleSyncError(e: unknown): void {
    if (e instanceof CloudSyncError && e.code === "unauthorized") {
      this.tearDownSession();
      this.lastError = "云会话已失效，请重新登录";
      return;
    }
    if (e instanceof APIError && e.isUnauthorized()) {
      this.tearDownSession();
      this.lastError = "云会话已失效，请重新登录";
      return;
    }
    this.lastError = this.messageOf(e);
  }

  private async persist(): Promise<void> {
    const useStore = this.secretsInSecureStore;
    const account: CloudAccountRecord = {
      baseUrl: this.baseUrl,
      email: this.emailAddr,
      accountId: this.accountIdStr,
      secretKey: useStore ? "" : this.secretKey,
      token: useStore ? "" : this.token,
      userId: this.userId,
      tenantId: this.tenantId,
      secrets: useStore ? SECURE_STORE_SENTINEL : "",
      wrappedPassword: this.wrappedPasswordB64,
    };
    const vaults: CloudVaultBinding[] = [];
    this.bindings.forEach((b) => vaults.push({ spaceId: b.spaceId, vaultId: b.vaultId, cursor: b.cursor }));
    const syncState: Record<string, Record<string, CloudItemSyncState>> = {};
    this.syncStates.forEach((m, spaceId) => {
      const inner: Record<string, CloudItemSyncState> = {};
      m.forEach((st, id) => {
        inner[id] = st;
      });
      syncState[spaceId] = inner;
    });
    const detached: string[] = [];
    this.detachedSpaces.forEach((id) => detached.push(id));
    const pendingRemoteDeletes: string[] = [];
    this.pendingRemoteDeletes.forEach((id) => pendingRemoteDeletes.push(id));
    try {
      await saveCloudState({
        account,
        vaults,
        syncState,
        detached,
        tombstoneCursor: this.tombstoneCursor,
        pendingRemoteDeletes,
      });
    } catch {
      // 持久化失败不阻塞主流程
    }
  }

  /** 完成 MFA（TOTP）二次验证并建立会话。 */
  async completeMfa(code: string): Promise<void> {
    const p = this.mfaPending;
    if (!p) throw new Error("无待验证的 MFA 流程");
    if (!code || !code.trim()) throw new Error("请输入验证码");
    try {
      const resp = await this.client!.loginMfa({ mfa_token: p.mfaToken, code: code.trim() });
      this.applyToken(resp.session_token);
      const sess = await this.recoverKeyset(p.auk);
      // MFA 账户每次登录都需 TOTP，无法静默自动恢复 → 不封装云密码（''）。
      this.establishSession(p.email, p.sk.accountId, p.secretKeyStr, "", sess.priv, sess.pub);
      await this.refreshSecretsBlob();
      await this.persist();
      this.emit();
      this.kickReconcile();
    } catch (e) {
      if (e instanceof APIError) {
        if (e.isGone()) {
          this.clearMfaPending();
          throw new Error("验证已超时，请重新登录");
        }
        if (e.isUnauthorized()) throw new Error("验证码错误，请重试");
        if (e.status === 429) throw new Error("尝试过于频繁，请稍后再试");
      }
      throw this.friendly(e);
    }
  }

  /** 取消 MFA 流程。 */
  cancelMfa(): void {
    this.clearMfaPending();
  }

  private clearMfaPending(): void {
    if (this.mfaPending) {
      wipeBytes(this.mfaPending.auk);
      this.mfaPending = null;
    }
    this.mfaRequired = false;
    this.emit();
  }

  /** 从账户 keyset 恢复私钥/公钥（无则现配）。 */
  private async recoverKeyset(auk: Uint8Array): Promise<KeysetSession> {
    try {
      const got = await this.client!.getKeyset();
      return { pub: fromB64(got.public_key), priv: unwrapAccountPrivKey(auk, fromB64(got.encrypted_private_key)) };
    } catch (e) {
      if (e instanceof APIError && e.isNotFound()) {
        const gen = generateKeyset();
        const wrapped = wrapAccountPrivKey(auk, gen.privateKey);
        await this.client!.putKeyset({
          public_key: toB64(gen.publicKey),
          encrypted_private_key: toB64(wrapped),
          algo: "x25519",
        });
        return { pub: gen.publicKey, priv: gen.privateKey };
      }
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  /** 重算 SecureStore 托管的 secrets（secretKey/token 变更后）；SecureStore 不可用则退化为明文落盘。 */
  private async refreshSecretsBlob(): Promise<void> {
    const ok = await saveCloudSecrets({ secretKey: this.secretKey, token: this.token });
    this.secretsInSecureStore = ok;
  }

  /** 从持久化账户记录恢复 secretKey/token（SecureStore 或明文回退）。 */
  private async loadSecrets(account: CloudAccountRecord): Promise<void> {
    if (account.secrets === SECURE_STORE_SENTINEL) {
      this.secretsInSecureStore = true;
      const s = await loadCloudSecrets();
      this.secretKey = s ? s.secretKey : "";
      this.token = s ? s.token : "";
    } else {
      this.secretsInSecureStore = false;
      this.secretKey = account.secretKey;
      this.token = account.token;
    }
  }

  /** 解码自身 JWT 的 sid（不验签，仅读 payload 段）。失败返回 ''。 */
  private sessionIdFromToken(token: string): string {
    try {
      const parts = token.split(".");
      if (parts.length < 2) return "";
      let seg = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (seg.length % 4 !== 0) seg += "=";
      const obj = JSON.parse(utf8Decode(fromB64(seg))) as Record<string, unknown>;
      const sid = obj.sid;
      return typeof sid === "string" ? sid : "";
    } catch {
      return "";
    }
  }

  private startPeriodic(): void {
    this.stopPeriodic();
    this.periodicTimer = setInterval(() => {
      if (this.signedIn && this.bindings.size > 0 && vaultService.isUnlocked()) {
        const full = this.lastFullSyncAt === 0 || Date.now() - this.lastFullSyncAt >= FULL_UPGRADE_MS;
        void this.runSync(full);
      }
    }, PERIODIC_SYNC_MS);
  }

  private stopPeriodic(): void {
    clearInterval(this.periodicTimer);
    this.periodicTimer = undefined;
  }

  /* ------------------------------------------------------------------------ */
  /* 实时事件流 (SSE)                                                          */
  /* ------------------------------------------------------------------------ */

  private startRealtime(): void {
    if (!this.realtimeStopped) return;
    if (!this.signedIn || !this.client) return;
    this.realtimeStopped = false;
    this.realtimeBackoff = 1000;
    this.connectRealtime();
  }

  private stopRealtime(): void {
    this.realtimeStopped = true;
    clearTimeout(this.realtimeTimer);
    this.realtimeTimer = undefined;
    if (this.eventStream) {
      this.eventStream.close();
      this.eventStream = null;
    }
  }

  private restartRealtime(): void {
    if (!this.signedIn) return;
    this.stopRealtime();
    this.startRealtime();
  }

  private connectRealtime(): void {
    if (this.realtimeStopped || !this.signedIn || !this.client) return;
    this.realtimeConnectedAt = Date.now();
    this.eventStream = this.client.openEventStream(
      (name: string, data: string) => this.onRealtimeEvent(name, data),
      (err: APIError | null) => this.onRealtimeClosed(err),
    );
  }

  private onRealtimeEvent(name: string, _data: string): void {
    if (name === "revoked") {
      this.tearDownSession();
      this.lastError = "云会话已被吊销，请重新登录";
      void this.refreshSpaceStates();
      return;
    }
    if (name === "resync") {
      this.scheduleNudge(true);
      return;
    }
    if (name === "vault_deleted") {
      this.kickReconcile();
      return;
    }
    if (name === "change") {
      this.scheduleNudge(false);
    }
  }

  private onRealtimeClosed(err: APIError | null): void {
    this.eventStream = null;
    if (this.realtimeStopped) return;
    if (err && err.isUnauthorized()) {
      this.tearDownSession();
      this.lastError = "云会话已失效，请重新登录";
      void this.refreshSpaceStates();
      return;
    }
    const healthy = Date.now() - this.realtimeConnectedAt >= 30_000;
    if (healthy) this.realtimeBackoff = 1000;
    const delay = this.realtimeBackoff + Math.floor(Math.random() * (this.realtimeBackoff / 2));
    this.realtimeBackoff = Math.min(this.realtimeBackoff * 2, 120_000);
    clearTimeout(this.realtimeTimer);
    this.realtimeTimer = setTimeout(() => {
      this.realtimeTimer = undefined;
      this.connectRealtime();
    }, delay);
  }

  private friendly(e: unknown): Error {
    if (e instanceof APIError) {
      if (e.isConflict()) return new Error("该邮箱已注册");
      if (e.isUnauthorized()) return new Error("认证失败：邮箱、主密码或 Secret Key 不正确");
      if (e.isPlanLimit()) return new Error("已达到套餐的云保险库数量上限，请升级套餐或解绑其它空间");
      if (e.isVaultFrozen()) return new Error("云保险库已冻结（套餐降级），无法写入");
      if (e.isNetwork()) return new Error(`网络错误：${e.message}`);
      return new Error(e.message);
    }
    if (e instanceof Error) return e;
    return new Error(String(e));
  }

  private messageOf(e: unknown): string {
    if (e instanceof Error) return e.message;
    return String(e);
  }
}

/** 进程内单例。 */
export const cloudService = new CloudService();
