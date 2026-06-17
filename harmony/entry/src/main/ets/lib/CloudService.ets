// ZPass HarmonyOS —— 云同步服务（@ObservedV2 单例，服务 + 反应式状态合一）
//
// 角色对应 desktop internal/services/cloudservice.go + cloudsync.go + 渲染层 stores/cloud.ts：
// 账户注册 / SRP-6a 登录 / keyset 收发 / 多空间云 vault 创建·绑定·解绑 / 同步触发 / 冲突管理 /
// 套餐额度（entitlements）与冻结处理。与 SyncServer.ets 同范式：@Trace 字段直接给页面绑定。
//
// 多空间模型（与 desktop cloud_vaults 一致）：每个本地空间 ↔ 一个云 vault（1:1）。双向自动镜像
// （对标 1Password「登录即见你的保险库」，见 reconcileSpaces/doReconcile）：
//   - 云 → 本地：账户已有的云 vault 在本地无同名空间时，**新建本地空间并绑定下拉**（cloud-only
//     vault 落地）；本地有同名空间则直接领养，避免跨设备重复建库。**无名 vault**（无 meta：CLI/e2e
//     播种、老客户端）若有数据，用 vault id 派生的确定性兜底名「云保险库 xxxxxxxx」下拉；空的无名
//     vault（疑似垃圾）跳过。
//   - 本地 → 云：未绑定且未解绑（detached）的本地空间自动建云 vault；但账户已有云 vault 时，
//     **空的初始默认空间**（id='default'，唯一自动创建者）不上云，避免新设备生成垃圾 vault（与
//     desktop 的差异）；用户显式新建的空间照常镜像。
// 同步循环遍历所有绑定，逐空间全量/增量对账（CloudSync 引擎按 spaceId 切分本地 manifest）。
//
// 零知识：主密码只作方法入参瞬时使用，绝不落盘；账户私钥 / per-vault key 仅内存
// （vault 锁定即清除）；持久化只存 token + Secret Key + 每空间绑定 + 每空间每条目水位（见 CloudStorage）。
//
// 会话生命周期与 vault 解锁对齐：
//   - 解锁（输入主密码）→ onVaultUnlocked(mp) 自动恢复云会话、自动镜像并同步（无需单独云登录）
//   - 锁定 → onVaultLocked() 清除内存密钥、停周期同步
//   - 401（会话失效）→ tearDownSession，保留账户记录待重新登录

import {
  APIError,
  CloudClient,
  type Entitlements,
  type EntitlementDimension,
  type KdfParams,
  type VaultSummary,
  type EventStreamHandle,
  type DeletedVaultsResponse,
} from './CloudClient';
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
  type ParsedSecretKey,
  sealVaultKey,
  sealVaultMeta,
  srpFinish,
  srpMakeVerifier,
  srpStart,
  unwrapAccountPrivKey,
  verifyServerM2,
  wrapAccountPrivKey,
} from './CloudCrypto';
import {
  clearCloudState,
  loadCloudState,
  saveCloudState,
  type CloudAccountRecord,
  type CloudVaultBinding,
  type CloudItemSyncState,
} from './CloudStorage';
import {
  CloudSyncError,
  resolveConflictLocal,
  resolveConflictRemote,
  runCloudSync,
  type CloudConflict,
  type SyncContext,
} from './CloudSync';
import { fromB64, randomBytes, toB64, utf8, utf8Decode, wipeBytes } from './Crypto';
import { vaultService, type SpaceMutationEvent } from './VaultService';
import { DEFAULT_SPACE_ID, deriveGlyph, type Space } from './Spaces';
import { deleteCloudSecretsKey, openCloudSecrets, sealCloudSecrets } from './CloudSecretsHuks';
import { vaultStore } from '../state/VaultStore';

const PERIODIC_SYNC_MS: number = 90_000;
const NUDGE_DEBOUNCE_MS: number = 2_000;

/** 默认云服务地址（用户无需手动配置；无持久化地址时回退到此）。 */
export const DEFAULT_CLOUD_BASE_URL: string = 'https://zpass-app.zerx.dev';
/** 调试用本地云服务地址（dev 模式在云账户页可一键切换）。 */
export const LOCAL_CLOUD_BASE_URL: string = 'http://localhost:8080';

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

interface CloudSecretsPlain {
  secretKey: string;
  token: string;
}

/** 云保险库数量配额（max_vaults 维度投影）：limit=null 表示不限。 */
interface VaultQuota {
  limit: number | null;
  current: number;
}

/** 单个空间的云同步状态投影（页面 ForEach 渲染用）。 */
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
  /** 解密后的空间名（无 meta / 解密失败为 ''）。 */
  name: string;
  itemCount: number;
  frozen: boolean;
  /** 本地已绑定到的空间 id（'' = 未绑定）。 */
  boundSpaceId: string;
}

@ObservedV2
export class CloudService {
  /* ----- 反应式状态（页面直接绑定） ----- */

  /** 是否已配置云服务地址。 */
  @Trace configured: boolean = false;
  @Trace baseUrl: string = '';
  /** 本地是否存有云账户记录（可能需重新输入主密码恢复会话）。 */
  @Trace hasAccount: boolean = false;
  /** 内存会话是否活跃（账户私钥在内存）。 */
  @Trace signedIn: boolean = false;
  @Trace email: string = '';
  @Trace accountId: string = '';
  /** 是否至少有一个空间已绑定云 vault（控制「立即同步」可用）。 */
  @Trace anyBound: boolean = false;
  /** 每空间云同步状态（页面列表数据源）。 */
  @Trace spaceStates: SpaceCloudStatus[] = [];
  /** 当前套餐名（entitlements.plan）；'' 表示未拉取。 */
  @Trace plan: string = '';
  @Trace syncing: boolean = false;
  @Trace lastSyncAt: number = 0;
  @Trace lastError: string = '';
  /** 各空间冲突（CloudConflict 携 spaceId）。 */
  @Trace conflicts: CloudConflict[] = [];
  /** 注册后一次性展示的 Secret Key（用户备份后应清空）。 */
  @Trace secretKeyBackup: string = '';
  @Trace hydrated: boolean = false;
  /** 登录命中 MFA（TOTP）：UI 显示验证码输入并调用 completeMfa(code)。 */
  @Trace mfaRequired: boolean = false;

  /* ----- 内存会话（非 @Trace；锁定即清） ----- */

  private client: CloudClient | null = null;
  private accountPriv: Uint8Array | null = null;
  private accountPub: Uint8Array | null = null;
  private secretKey: string = '';
  private token: string = '';
  private userId: string = '';
  private tenantId: string = '';
  /** 每空间绑定：spaceId → {spaceId, vaultId, cursor}。cursor 就地推进。 */
  private bindings: Map<string, CloudVaultBinding> = new Map<string, CloudVaultBinding>();
  /** 解封后的 per-vault key（vaultId → 32B，仅内存）。 */
  private vaultKeys: Map<string, Uint8Array> = new Map<string, Uint8Array>();
  /** 每空间 per-item 同步水位：spaceId → (itemId → state)。 */
  private syncStates: Map<string, Map<string, CloudItemSyncState>> = new Map<string, Map<string, CloudItemSyncState>>();
  /** 当前冻结的 vaultId 集合（来自同步推送被拒 / entitlements.frozen_vault_ids）。 */
  private frozenVaultIds: Set<string> = new Set<string>();
  /** 用户显式解绑、不自动镜像的 spaceId 集合。 */
  private detachedSpaces: Set<string> = new Set<string>();
  /** 自动镜像因额度失败的 spaceId 集合（UI 提示「超出套餐」）。 */
  private overQuotaSpaces: Set<string> = new Set<string>();
  /** vault 删除墓碑游标（已处理到的最大 seq；单调推进）。 */
  private tombstoneCursor: number = 0;
  /** 待删除的云 vault id（本端发起删除失败 → reconcile 幂等重试）。 */
  private pendingRemoteDeletes: Set<string> = new Set<string>();

  private periodicTimer: number = -1;
  private nudgeTimer: number = -1;
  /** 解锁主密码 ≠ 云账户密码时，避免每次解锁都白跑一次 Argon2 失败登录；成功手动登录后重置。 */
  private autoRestoreDisabled: boolean = false;
  /** 上次全量对账时刻（周期同步每 6h 升级一次全量）。 */
  private lastFullSyncAt: number = 0;
  /** reconcile 进行中（防并发重复建库）。 */
  private reconciling: boolean = false;
  /** reconcile 进行中又收到触发 → 结束后重跑一次（兜住「上一轮在 vault 锁定期空跑」的竞态）。 */
  private reconcilePending: boolean = false;
  /** 同步进行中收到的触发 → 结束后补跑一次（合并 SSE / 编辑 / 周期）。 */
  private syncPending: boolean = false;
  private pendingFull: boolean = false;
  /** SSE 实时事件流（账户级；绑定/会话变化时重建）。 */
  private eventStream: EventStreamHandle | null = null;
  private realtimeStopped: boolean = true;
  private realtimeBackoff: number = 1000;
  private realtimeTimer: number = -1;
  private realtimeConnectedAt: number = 0;
  /** 去抖期间是否升级为全量（resync 事件触发）。 */
  private nudgeFull: boolean = false;
  /** MFA 待验证上下文（持 auk 跨越验证码输入）；clearMfaPending 时抹除。 */
  private mfaPending: MfaPending | null = null;
  /** HUKS 加密的 secrets blob（base64）；'' 表示明文回退；secretKey/token 变更时刷新。 */
  private secretsBlobB64: string = '';
  /**
   * 本地保险库刚为「首次使用即选云同步」新建（CloudAccount.ensureLocalVault 调 markFreshLocalVault
   * 置位）。其默认空间（id='default'）只是初始化必需的占位符——对标 desktop bootstrapLocalVault：
   * desktop 的 initialize 根本不建默认空间，登录后只镜像云端空间。首次对账下拉到云端空间后，
   * 若该占位默认空间仍空且未绑定即清除（cleanupPlaceholderDefault）。一次性消费。
   */
  private freshLocalVault: boolean = false;
  /** doReconcile 判定「本轮需在切焦点后清除占位默认空间」时置位；cleanupPlaceholderDefault 消费。 */
  private removeDefaultAfterFocus: boolean = false;

  /* ------------------------------------------------------------------------ */
  /* 启动水合                                                                  */
  /* ------------------------------------------------------------------------ */

  /** 冷启动加载持久化的云状态（不建立会话；会话待解锁时恢复）。 */
  async hydrate(): Promise<void> {
    try {
      const st = await loadCloudState();
      if (st.account) {
        this.baseUrl = st.account.baseUrl;
        this.email = st.account.email;
        this.accountId = st.account.accountId;
        this.userId = st.account.userId;
        this.tenantId = st.account.tenantId;
        this.configured = this.baseUrl.length > 0;
        this.hasAccount = true;
        this.client = new CloudClient(this.baseUrl);
        await this.loadSecrets(st.account);
        if (this.token) this.client.setToken(this.token);
      }
      // 默认云服务地址：用户无需手动配置；无持久化地址时回退线上默认（dev 可在云账户页覆盖）。
      if (!this.baseUrl) this.baseUrl = DEFAULT_CLOUD_BASE_URL;
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
      if (st.detached) {
        for (const id of st.detached) this.detachedSpaces.add(id);
      }
      this.tombstoneCursor = st.tombstoneCursor;
      if (st.pendingRemoteDeletes) {
        for (const id of st.pendingRemoteDeletes) this.pendingRemoteDeletes.add(id);
      }
      this.anyBound = this.bindings.size > 0;
    } catch (_e) {
      // 损坏/缺失 → 空状态
    } finally {
      this.hydrated = true;
      vaultStore.registerCloudHooks(
        (mp: string) => { this.onVaultUnlocked(mp); },
        () => { this.onVaultLocked(); },
      );
      vaultService.registerMutationHook(() => { this.nudge(); });
      vaultService.registerSpaceHook((e: SpaceMutationEvent) => { this.handleSpaceMutation(e); });
      await this.refreshSpaceStates();
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 配置                                                                      */
  /* ------------------------------------------------------------------------ */

  /** 设置云服务地址（http(s)://host:port）。 */
  configure(baseUrl: string): void {
    const b = (baseUrl ?? '').trim();
    if (!b) throw new Error('请输入云服务地址');
    this.baseUrl = b;
    if (!this.client) this.client = new CloudClient(b);
    else this.client.setBaseURL(b);
    this.configured = true;
  }

  /**
   * 标记：本地保险库刚为「首次使用即选云同步」新建（由 CloudAccount.ensureLocalVault 在 initialize
   * 后调用）。仅此路径置位——已初始化的本地用户后补登录云端不会置位，其既有空间不受影响。
   * 下一次首登对账（doReconcile）下拉到云端空间后，会清除仍空且未绑定的占位默认空间。
   */
  markFreshLocalVault(): void {
    this.freshLocalVault = true;
  }

  /* ------------------------------------------------------------------------ */
  /* 注册 / 登录                                                               */
  /* ------------------------------------------------------------------------ */

  /** 注册新账户；返回一次性 Secret Key（用户须离线备份）。 */
  async register(email: string, masterPassword: string): Promise<string> {
    this.ensureClient();
    const em = (email ?? '').trim().toLowerCase();
    if (!em || em.indexOf('@') < 0) throw new Error('请输入有效邮箱');
    if (!masterPassword || masterPassword.length < 8) throw new Error('主密码至少 8 位');

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
        alg: CLOUD_KDF_ALG, m: CLOUD_ARGON2_MEM_KIB, t: CLOUD_ARGON2_ITER, p: CLOUD_ARGON2_PAR,
        salt_enc: toB64(saltEnc), sk_version: CLOUD_SK_VERSION,
      };
      const resp = await this.client!.register({
        email: em, srp_salt: toB64(reg.salt), srp_verifier: toB64(reg.verifier), kdf_params: kdf,
      });
      this.applyToken(resp.session_token);
      this.userId = resp.user_id;
      this.tenantId = resp.tenant_id;

      const ks = generateKeyset();
      const wrapped = wrapAccountPrivKey(auk, ks.privateKey);
      await this.client!.putKeyset({
        public_key: toB64(ks.publicKey), encrypted_private_key: toB64(wrapped), algo: 'x25519',
      });

      this.establishSession(em, sk.accountId, secretKey, ks.privateKey, ks.publicKey);
      await this.refreshSecretsBlob();
      await this.persist();
      this.secretKeyBackup = secretKey;
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
    if (!secretKey || !secretKey.trim()) throw new Error('请输入 Secret Key');
    await this.signInInternal((email ?? '').trim().toLowerCase(), masterPassword, secretKey.trim());
  }

  /** 用已保存的邮箱 + Secret Key 重新登录（仅需主密码）。 */
  async restoreSession(masterPassword: string): Promise<void> {
    if (!this.hasAccount || !this.email || !this.secretKey) {
      throw new Error('无已保存的云账户');
    }
    await this.signInInternal(this.email, masterPassword, this.secretKey);
  }

  private async signInInternal(email: string, masterPassword: string, secretKeyStr: string): Promise<void> {
    this.ensureClient();
    if (!email || email.indexOf('@') < 0) throw new Error('请输入有效邮箱');
    if (!masterPassword) throw new Error('请输入主密码');
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
      const ok = await verifyServerM2(start.aPub, proof.m1, proof.k, fromB64(lf.M2));
      if (!ok) {
        throw new Error('服务端身份校验失败（M2 不匹配）—— 地址有误或遭遇中间人');
      }
      auk = await deriveAuk(masterPassword, saltEnc, sk, m, t, p);
      if (lf.mfa_required === true && lf.mfa_token) {
        // SRP 已完成（M2 已验）；session_token 待 TOTP 验证。暂存 auk，转交 completeMfa。
        this.clearMfaPending();
        this.mfaPending = { mfaToken: lf.mfa_token, email, sk, secretKeyStr, auk };
        this.mfaRequired = true;
        transferred = true;
        return;
      }
      if (!lf.session_token) {
        throw new Error('登录失败：邮箱、主密码或 Secret Key 不正确');
      }
      this.applyToken(lf.session_token);
      const sess = await this.recoverKeyset(auk);
      this.establishSession(email, sk.accountId, secretKeyStr, sess.priv, sess.pub);
      await this.refreshSecretsBlob();
      await this.persist();
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
    // best-effort 服务端吊销当前会话（解析自身 token 的 sid → DELETE /v1/sessions/{sid}）
    const sid = this.sessionIdFromToken(this.token);
    if (sid && this.client && this.token) {
      try {
        await this.client.revokeSession(sid);
      } catch (_e) {
        // 离线 / 已失效 → 忽略，本地清理继续
      }
    }
    this.tearDownSession();
    this.clearMfaPending();
    this.conflicts = [];
    this.hasAccount = false;
    this.email = '';
    this.accountId = '';
    this.secretKey = '';
    this.secretsBlobB64 = '';
    this.plan = '';
    this.bindings.clear();
    this.syncStates.clear();
    this.frozenVaultIds.clear();
    this.detachedSpaces.clear();
    this.overQuotaSpaces.clear();
    this.tombstoneCursor = 0;
    this.pendingRemoteDeletes.clear();
    this.anyBound = false;
    this.lastFullSyncAt = 0;
    this.secretKeyBackup = '';
    this.freshLocalVault = false;
    this.removeDefaultAfterFocus = false;
    try {
      await deleteCloudSecretsKey();
    } catch (_e) {
      // 忽略
    }
    await clearCloudState();
    await this.refreshSpaceStates();
  }

  /** 校验输入的 Secret Key 是否与当前云账户一致（清空云端数据前二次确认）。去分隔符/空白 + 大写后比对。 */
  verifySecretKey(input: string): boolean {
    const norm = (s: string): string => (s ?? '').trim().split('-').join('').split(' ').join('').toUpperCase();
    const a = norm(input);
    return a.length > 0 && a === norm(this.secretKey);
  }

  /**
   * 清空云端数据：删除账户下所有可删（owner）的云 vault（写墓碑 → 其它设备据此物理删本地空间），
   * 并清空本地绑定/水位/密钥。账户保持登录（云端变空，可继续使用）。非 owner 的共享 vault 跳过；
   * 网络失败抛错（不清本地绑定，留待重试），调用方据此中止本地清空，避免下次同步把数据拉回。
   */
  async clearAllCloudData(): Promise<void> {
    this.requireSession();
    const resp = await this.client!.listVaults();
    let transientFail = false;
    for (const v of resp.vaults) {
      try {
        await this.client!.deleteVault(v.vault_id);
      } catch (e) {
        if (e instanceof APIError && (e.status === 403 || e.status === 404)) continue; // 非 owner / 已删 → 跳过
        transientFail = true; // 网络 / 500 → 稍后重试
      }
    }
    if (transientFail) throw new Error('部分云保险库删除失败（网络问题），请联网后重试');
    this.bindings.forEach((b) => {
      const k = this.vaultKeys.get(b.vaultId);
      if (k) { wipeBytes(k); this.vaultKeys.delete(b.vaultId); }
    });
    this.bindings.clear();
    this.syncStates.clear();
    this.detachedSpaces.clear();
    this.overQuotaSpaces.clear();
    this.frozenVaultIds.clear();
    this.anyBound = false;
    await this.persist();
    await this.refreshSpaceStates();
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
          vaultId: v.vault_id, name, itemCount: v.item_count, frozen: v.frozen,
          boundSpaceId: boundBy.get(v.vault_id) ?? '',
        });
      }
      return out;
    } catch (e) {
      throw this.friendly(e);
    }
  }

  /** 为某空间新建云 vault（铸新 vault key + 封装空间名 meta 上传），并刷新状态。clearDetached 时取消解绑标记。 */
  async createCloudVault(spaceId: string, name?: string): Promise<void> {
    this.requireSession();
    if (!spaceId) throw new Error('空间 id 为空');
    if (this.bindings.has(spaceId)) return; // 已绑定 → 幂等
    try {
      await this.createVaultForSpace(spaceId, name);
    } catch (e) {
      throw this.friendly(e);
    }
    await this.persist();
    await this.refreshSpaceStates();
    this.restartRealtime();
    await this.runSync(true);
  }

  /** 绑定已有云 vault 到某空间（账户私钥解封 wrapped_vault_key；1:1 校验），并立即首次同步。 */
  async bindCloudVault(spaceId: string, vaultId: string): Promise<void> {
    this.requireSession();
    if (!spaceId) throw new Error('空间 id 为空');
    if (!vaultId) throw new Error('vault id 为空');
    // 1:1 模型校验
    const existing = this.bindings.get(spaceId);
    if (existing) {
      if (existing.vaultId === vaultId) return; // 幂等
      throw new Error('该空间已绑定其它云保险库，请先解绑');
    }
    let conflict = false;
    this.bindings.forEach((b) => { if (b.vaultId === vaultId && b.spaceId !== spaceId) conflict = true; });
    if (conflict) throw new Error('该云保险库已绑定到其它空间');
    try {
      const m = await this.client!.getVaultMemberSelf(vaultId);
      const vk = openVaultKey(this.accountPriv!, fromB64(m.wrapped_vault_key));
      this.vaultKeys.set(vaultId, vk);
      this.bindings.set(spaceId, { spaceId, vaultId, cursor: 0 });
      this.syncStates.set(spaceId, new Map<string, CloudItemSyncState>());
      this.detachedSpaces.delete(spaceId);
      this.overQuotaSpaces.delete(spaceId);
    } catch (e) {
      if (e instanceof APIError && e.isNotFound()) throw new Error('你不是该云保险库的成员');
      throw this.friendly(e);
    }
    await this.persist();
    await this.refreshSpaceStates();
    this.restartRealtime();
    await this.runSync(true);
  }

  /** 解绑某空间的云 vault（仅移除本地绑定与水位，本地数据不动；标记 detached 不再自动镜像）。 */
  async unlinkSpace(spaceId: string): Promise<void> {
    const b = this.bindings.get(spaceId);
    this.bindings.delete(spaceId);
    this.syncStates.delete(spaceId);
    if (b) {
      this.frozenVaultIds.delete(b.vaultId);
      const k = this.vaultKeys.get(b.vaultId);
      if (k) { wipeBytes(k); this.vaultKeys.delete(b.vaultId); }
    }
    this.overQuotaSpaces.delete(spaceId);
    this.detachedSpaces.add(spaceId);
    this.anyBound = this.bindings.size > 0;
    await this.persist();
    await this.refreshSpaceStates();
    this.restartRealtime();
  }

  /** 重新镜像某空间（清除解绑标记并新建云 vault）。 */
  async reuploadSpace(spaceId: string): Promise<void> {
    this.detachedSpaces.delete(spaceId);
    await this.createCloudVault(spaceId);
  }

  /** 查询套餐额度（刷新冻结 vault 集合与套餐名），返回原始 entitlements 供 UI 展示用量。 */
  async entitlements(): Promise<Entitlements> {
    this.requireSession();
    try {
      const ent = await this.client!.getEntitlements();
      this.plan = ent.plan;
      this.frozenVaultIds = new Set<string>();
      if (ent.frozen_vault_ids) for (const id of ent.frozen_vault_ids) this.frozenVaultIds.add(id);
      await this.refreshSpaceStates();
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
    try { await this.entitlements(); } catch (_e) { /* 额度刷新失败不阻塞 */ }
    await this.refreshSpaceStates();
    await this.runSync(true);
  }

  /* ------------------------------------------------------------------------ */
  /* 自动镜像（reconcile）                                                      */
  /* ------------------------------------------------------------------------ */

  /**
   * 三步对账（对标 1Password「登录即见你的保险库」）：
   *   step 1 云 → 本地：账户已有云 vault 但本地缺失 → 按名领养已有空间 / 新建本地空间并绑定
   *     （cloud-only vault 下拉落地）。
   *   step 2 本地 → 云：本地空间云端没有 → 上传新建 vault（账户已有 vault 时空内容空间不上云）。
   * 随后全量同步；首次登录把焦点从空的默认空间切到下拉的真实空间。
   */
  async reconcileSpaces(): Promise<void> {
    if (!this.signedIn) return;
    if (this.reconciling) {
      // 已在对齐中：标记待重跑（覆盖「上一轮在 vault 锁定期空跑」→ 解锁后必有一次完整 doReconcile）
      // + 补一次同步。
      this.reconcilePending = true;
      await this.runSync(true);
      return;
    }
    this.reconciling = true;
    try {
      do {
        this.reconcilePending = false;
        let focusTarget = '';
        try {
          focusTarget = await this.doReconcile();
        } catch (e) {
          // 离线 / 列举失败 → 记一笔（设置页可见），仍尝试同步既有绑定
          this.lastError = this.messageOf(e);
        }
        await this.runSync(true);
        // 同步落地后再切焦点：此时下拉空间的条目已写入本地
        if (focusTarget) await this.maybeFocusPulledSpace(focusTarget);
        // 切焦点后清除「首次使用即选云同步」的占位默认空间（self-guarded by removeDefaultAfterFocus）。
        await this.cleanupPlaceholderDefault();
      } while (this.reconcilePending);
    } finally {
      this.reconciling = false;
    }
  }

  /** fire-and-forget 触发自动镜像（登录后调用，不阻塞 UI）。 */
  private kickReconcile(): void {
    this.reconcileSpaces().then(() => {}).catch(() => {});
  }

  /**
   * 三步对账实现。返回首个「下拉新建」空间 id（仅首次登录时非空），供 reconcileSpaces 在
   * 同步后把焦点从空的默认空间切过去；无下拉或非首次登录返回 ''。
   */
  private async doReconcile(): Promise<string> {
    if (!vaultService.isUnlocked()) return '';
    // ── step 0：删除墓碑传播（先于 listVaults，使下方 remote 反映删除后的状态）+ 重试待删 vault ──
    // 命中本地绑定的「主动删除」墓碑 → 物理删本地空间（与「失去访问」区分：后者仍走 detached 保留）。
    let changed = false;
    if (await this.processDeletionTombstones()) changed = true;
    if (await this.retryPendingRemoteDeletes()) changed = true;
    const snap = await vaultService.listSpaces();
    const spaces = snap.spaces;
    // 首次登录判定（本地尚无任何绑定）—— 仅此时允许切换激活空间，避免后台对账抢焦点。
    const firstSignIn = this.bindings.size === 0;
    // 占位默认空间清除标记：一次性消费 freshLocalVault（仅首登且确有云端下拉时，对账尾部置位）。
    const wasFresh = this.freshLocalVault;
    this.freshLocalVault = false;

    const resp = await this.client!.listVaults();
    const remote = resp.vaults;
    // 账户在本轮对账前是否已有云 vault —— 决定 step 2 是否对空内容空间放行（空账户才播种）。
    const cloudHadRemoteVaults = remote.length > 0;
    const boundVaultIds = new Set<string>();
    this.bindings.forEach((b) => boundVaultIds.add(b.vaultId));

    let firstPulledSpaceId = '';

    // ── step 1：云 → 本地镜像 ──
    // 账户已有的云 vault：同名唯一 → 领养本地空间；本地无同名 → 新建本地空间并绑定（下拉落地）。
    for (const v of remote) {
      const vid = v.vault_id;
      if (boundVaultIds.has(vid)) continue;
      if (this.pendingRemoteDeletes.has(vid)) continue; // 待删 vault 不再下拉（防刚删空间复活）
      let name = await this.decryptRemoteName(v); // 非空即代表 vault key 已解封并缓存
      if (!name) {
        // 无名 vault（无 meta：CLI/e2e 播种、老客户端、desktop name="" 旧流程）。有数据者用
        // **vault id 派生的确定性兜底名**下拉（跨设备同名 → 不重复建空间），空者（疑似垃圾）跳过。
        // 先确认 vault key 可解，否则建了空间也无法同步其条目（密钥不匹配等）。
        if (v.item_count <= 0) continue;
        try { await this.ensureVaultKeyFor(vid); } catch (_e) { continue; }
        name = `云保险库 ${this.shortVaultId(vid)}`;
      }
      // 用户已显式解绑（detached）的同名空间存在 → 不再自动领养/下拉该 vault，尊重解绑意图
      // （harmony 特有：unlinkSpace 会保留云端 vault 并 detach 本地空间；desktop 的 detached
      // 仅用于「云端 vault 已被删除」，故无此分支）。
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
          // cloud-only vault → 新建本地空间（silent：不触发自动建云 vault 回环）后绑定
          const space = await vaultService.createSpace(name, true);
          if (await this.adoptRemoteVault(space.id, vid)) {
            boundVaultIds.add(vid);
            changed = true;
            if (!firstPulledSpaceId) firstPulledSpaceId = space.id;
          }
        }
        // candidates.length > 1：同名歧义 → 跳过（设置页手动绑定）
      } catch (_e) {
        // 单个 vault 镜像失败不影响其余
      }
    }

    // ── step 2：本地 → 云镜像（上传未绑定且未解绑的空间；受套餐额度约束） ──
    // 与 desktop 的差异：唯一**自动创建**的「默认空间」（id='default'）在账户已有云 vault 且其
    // 自身为空时不上云——避免新设备的初始默认空间生成垃圾 vault。用户**显式新建**的空间（id
    // 'sp-…'）不受此限，照常镜像（即便为空，尊重显式意图）；全新 / 空账户也连默认一并播种。
    // 先收集本轮「应自动上云」的候选空间（未绑定、未解绑；空的初始默认空间在账户已有云 vault 时跳过）。
    const toUpload: Space[] = [];
    for (const s of spaces) {
      if (this.bindings.has(s.id) || this.detachedSpaces.has(s.id)) continue;
      if (s.id === DEFAULT_SPACE_ID && cloudHadRemoteVaults) {
        const items = await vaultService.listItemsForSpace(s.id);
        if (items.length === 0) continue; // 空的初始默认空间不上云（占位符，后续 cleanupPlaceholderDefault 清除）
      }
      toUpload.push(s);
    }
    // 重算「超出套餐」集合（每轮对账重新判定：上次超额、本轮额度已释放的空间应可重新上云）。
    this.overQuotaSpaces.clear();
    if (toUpload.length > 0) {
      // 套餐额度预判（云保险库数量 max_vaults）：候选数超过剩余额度时**不自动任选**，全部标记
      // 「超出套餐」，留用户在同步页手动指定要上云的空间（req 2：本地多空间超额 → 手动指定）。
      // 额度不可知（离线 / 老服务端）→ remaining=∞，回退「逐个尝试、撞 403 才停」的旧行为。
      const quota = await this.fetchVaultQuota();
      let remaining = Number.POSITIVE_INFINITY;
      if (quota && quota.limit !== null) {
        remaining = quota.limit - quota.current;
        if (remaining < 0) remaining = 0;
      }
      if (toUpload.length > remaining) {
        for (const s of toUpload) this.overQuotaSpaces.add(s.id);
        this.lastError = '本地空间数超出套餐的云保险库上限，请在同步页手动选择要上云的空间';
      } else {
        let quotaHit = false;
        for (const s of toUpload) {
          if (quotaHit) { this.overQuotaSpaces.add(s.id); continue; }
          try {
            await this.createVaultForSpace(s.id, s.name);
            changed = true;
          } catch (e) {
            if (e instanceof APIError && e.isPlanLimit()) {
              quotaHit = true;
              this.overQuotaSpaces.add(s.id);
              this.lastError = '已达到套餐的云保险库数量上限，部分空间未上云';
            } else {
              // 其它错误：记一笔，继续其余空间
              this.lastError = this.messageOf(e);
            }
          }
        }
      }
    }

    if (changed) {
      await this.persist();
      this.restartRealtime();
      // 空间集发生变化（下拉/领养/新建）→ 立即刷新 store，让空间切换器即时看到，
      // 不依赖随后 runSync 是否恰好 applied>0（空内容空间也能露出）。
      try { await vaultStore.refresh(); } catch (_e) {}
    }
    await this.refreshSpaceStates();
    // 首次使用即选云同步：本轮已下拉到云端空间 → 标记切焦点后清除占位默认空间（req 1）。
    if (wasFresh && firstSignIn && firstPulledSpaceId.length > 0) {
      this.removeDefaultAfterFocus = true;
    }
    return firstSignIn ? firstPulledSpaceId : '';
  }

  /**
   * 首次登录把焦点从「空的默认空间」切到下拉落地的真实空间（对标 1Password 登录后直接看到
   * 你的数据）。仅当当前激活空间无条目时才切，避免抢占用户已有焦点。
   */
  private async maybeFocusPulledSpace(spaceId: string): Promise<void> {
    try {
      if (!vaultService.isUnlocked()) return;
      await vaultStore.refresh(); // 确保下拉的新空间与条目已进入 store
      const exists = vaultStore.spaces.some((s) => s.id === spaceId);
      if (!exists) return;
      const active = vaultStore.activeSpaceId;
      if (active === spaceId) return;
      const activeItems = await vaultService.listItemsForSpace(active);
      if (activeItems.length > 0) return; // 当前空间有数据 → 不抢焦点
      await vaultStore.setActiveSpace(spaceId);
    } catch (_e) {
      // 焦点切换失败不影响同步结果
    }
  }

  /**
   * 清除「首次使用即选云同步」遗留的占位默认空间（req 1：local == cloud，不残留空默认空间）。
   * 仅在 doReconcile 置 removeDefaultAfterFocus（首登 + 确有云端下拉）且切焦点完成后调用。
   * 防御式：默认空间须仍存在、未绑定、为空、非当前激活、且非唯一空间，方才物理删（purgeSpace）。
   * 任一不满足则保留——绝不把用户停在不存在的空间，也绝不删有数据 / 已绑定的默认空间。
   */
  private async cleanupPlaceholderDefault(): Promise<void> {
    if (!this.removeDefaultAfterFocus) return;
    this.removeDefaultAfterFocus = false; // 一次性
    try {
      if (!vaultService.isUnlocked()) return;
      if (this.bindings.has(DEFAULT_SPACE_ID)) return; // 默认空间已被同名云 vault 领养 → 保留
      const snap = await vaultService.listSpaces();
      if (!snap.spaces.some((s) => s.id === DEFAULT_SPACE_ID)) return; // 已不存在
      if (snap.spaces.length <= 1) return; // 必须保留至少一个空间
      if (snap.activeSpaceId === DEFAULT_SPACE_ID) return; // 焦点未切走 → 不删，避免停在不存在的空间
      const items = await vaultService.listItemsForSpace(DEFAULT_SPACE_ID);
      if (items.length > 0) return; // 非空（用户已有数据）→ 保留
      await vaultService.purgeSpace(DEFAULT_SPACE_ID);
      this.detachedSpaces.delete(DEFAULT_SPACE_ID);
      this.overQuotaSpaces.delete(DEFAULT_SPACE_ID);
      await vaultStore.refresh();
      await this.refreshSpaceStates();
    } catch (_e) {
      // best-effort：清除失败不影响同步结果（默认空间保留，用户可手动删）
    }
  }

  /**
   * 远端云保险库数量配额（max_vaults 维度）：{ limit, current }。limit=null 表示不限。
   * 失败 / 无该维度 → 返回 null，调用方回退「逐个尝试、撞 403 才停」的旧行为。
   * 与 UI（CloudSync.vaultUsage）口径一致：优先精确匹配 'max_vaults'，否则取首个含 'vault' 的维度。
   */
  private async fetchVaultQuota(): Promise<VaultQuota | null> {
    try {
      const ent = await this.client!.getEntitlements();
      this.plan = ent.plan;
      let dim: EntitlementDimension | null = null;
      for (const d of ent.dimensions) {
        if (d.dimension === 'max_vaults') { dim = d; break; }
        if (!dim && d.dimension.indexOf('vault') >= 0) dim = d;
      }
      if (!dim) return null;
      return { limit: dim.limit, current: dim.current };
    } catch (_e) {
      return null;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 删除墓碑传播（reconcile step 0；对标 desktop processDeletionTombstones）      */
  /* ------------------------------------------------------------------------ */

  /**
   * 消费 vault 删除墓碑（GET /v1/vaults/deleted，按 seq 单调游标增量）：命中本地绑定的
   * 「主动删除」墓碑 → 物理删本地空间（purgeSpace：删条目 + 删空间）并拆绑定/清水位。
   * 与「失去访问」区分：仅进了墓碑的才自动删；单纯「云端 vault 失踪」由 runSync 的 404 分支
   * 解绑保留。游标只增；拉取失败本轮跳过下轮再试。返回是否有变更（游标推进 / 删空间）。
   */
  private async processDeletionTombstones(): Promise<boolean> {
    if (!this.signedIn || !this.client || !vaultService.isUnlocked()) return false;
    let changed = false;
    let purgedAny = false;
    // 多页时一次抽干（删除少见，通常 0~1 页）；guard 防御异常死循环。
    for (let guard = 0; guard < 100; guard++) {
      let page: DeletedVaultsResponse | null = null;
      try {
        page = await this.client!.listDeletedVaults(this.tombstoneCursor, 0);
      } catch (_e) {
        break; // 拉取失败：本轮跳过，不影响其余对账
      }
      if (!page || page.deleted.length === 0) break;
      for (const d of page.deleted) {
        let spaceId = '';
        this.bindings.forEach((b) => { if (b.vaultId === d.vault_id) spaceId = b.spaceId; });
        if (!spaceId) continue; // 本地无此 vault 绑定 → 忽略（从未同步过）
        try {
          // 先拆绑定（停止同步死 vault）+ 清水位/key，再物理删空间及其条目。
          const b = this.bindings.get(spaceId);
          this.bindings.delete(spaceId);
          this.syncStates.delete(spaceId);
          if (b) {
            const k = this.vaultKeys.get(b.vaultId);
            if (k) { wipeBytes(k); this.vaultKeys.delete(b.vaultId); }
          }
          this.detachedSpaces.delete(spaceId);
          this.overQuotaSpaces.delete(spaceId);
          await vaultService.purgeSpace(spaceId);
          purgedAny = true;
          changed = true;
        } catch (_e) {
          // 单个 purge 失败：vault 已删，继续推进游标避免反复重拉
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
      try { await vaultStore.refresh(); } catch (_e) {} // 让 UI 立即丢弃被删空间的条目
    }
    return changed;
  }

  /** 重试待删的云 vault（删除必达兜底；幂等）。403/404=终态（非 owner / 已删）清出队列；其余保留下轮再试。 */
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
          this.pendingRemoteDeletes.delete(vid); // 终态：重试无意义
          changed = true;
        }
        // 其余（网络 / 500）：保留，下轮再试
      }
    }
    return changed;
  }

  /** 删除某云 vault（写服务端墓碑）。403/404 视作已达终态忽略；其余失败入待删队列幂等重试。 */
  private async deleteRemoteVaultBestEffort(vaultId: string): Promise<void> {
    try {
      await this.client!.deleteVault(vaultId);
    } catch (e) {
      if (e instanceof APIError && (e.status === 403 || e.status === 404)) return; // 非 owner / 已删
      this.pendingRemoteDeletes.add(vaultId);
      await this.persist();
    }
  }

  /** 领养一个已有远端 vault 到某空间（解封 key、建绑定与空状态）。失败返回 false。 */
  private async adoptRemoteVault(spaceId: string, vaultId: string): Promise<boolean> {
    try {
      const vk = await this.ensureVaultKeyFor(vaultId);
      if (!vk) return false;
      this.bindings.set(spaceId, { spaceId, vaultId, cursor: 0 });
      if (!this.syncStates.has(spaceId)) this.syncStates.set(spaceId, new Map<string, CloudItemSyncState>());
      this.overQuotaSpaces.delete(spaceId);
      this.anyBound = true;
      return true;
    } catch (_e) {
      return false;
    }
  }

  /** 内部：为空间铸新 vault key + 封装空间名 meta 上传 + 记录绑定（不触发同步）。 */
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

  /**
   * 核心同步：遍历所有空间绑定，逐空间 full=true 全量重建（登录/绑定/手动/resync/6h）或增量 delta。
   * syncing 守护防重入；进行中收到的触发记为 pending，结束后补跑一次。
   */
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
    this.lastError = '';
    let applied = 0;
    try {
      const list: CloudVaultBinding[] = [];
      this.bindings.forEach((b) => list.push(b));
      for (const b of list) {
        // 循环中可能因「非成员」删除了绑定 → 跳过已失效项
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
          if (!(await this.handlePerBindingError(e, b))) break; // 致命（会话失效）→ 终止整轮
        }
      }
      this.lastSyncAt = Date.now();
      if (full) this.lastFullSyncAt = this.lastSyncAt;
      await this.persist();
      await this.refreshSpaceStates();
      if (applied > 0) await vaultStore.refresh();
    } finally {
      this.syncing = false;
    }
    if (this.syncPending) {
      const f = this.pendingFull;
      this.syncPending = false;
      this.pendingFull = false;
      await this.runSync(f);
    }
  }

  /**
   * 逐绑定错误处理（对应 desktop runSync per-binding switch）。
   * 返回 false 表示致命错误，应终止整轮；true 表示已处理，继续下一个空间。
   */
  private async handlePerBindingError(e: Object, b: CloudVaultBinding): Promise<boolean> {
    if ((e instanceof CloudSyncError && e.code === 'unauthorized') || (e instanceof APIError && e.isUnauthorized())) {
      this.tearDownSession();
      this.lastError = '云会话已失效，请重新登录';
      return false;
    }
    if (e instanceof APIError && e.isNotFound()) {
      // 404：vault 不存在 / 非成员。先消费删除墓碑以区分「主动删除」与「失去访问」：
      //   - 有墓碑（owner 主动删）→ processDeletionTombstones 已物理删该空间（绑定消失）→ 收尾返回。
      //   - 无墓碑（被移出 / 瞬时不可见）→ 解绑并标记 detached 保留本地数据（防 step 2 复活）。
      await this.processDeletionTombstones();
      if (!this.bindings.has(b.spaceId)) return true; // 已被墓碑物理删
      this.bindings.delete(b.spaceId);
      this.syncStates.delete(b.spaceId);
      const k = this.vaultKeys.get(b.vaultId);
      if (k) { wipeBytes(k); this.vaultKeys.delete(b.vaultId); }
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
  }

  /** 本地编辑后的去抖增量同步触发。 */
  nudge(): void {
    this.scheduleNudge(false);
  }

  /** 去抖同步：合并 2s 内多次触发；期间任一 full 请求则整体升级为全量。 */
  private scheduleNudge(full: boolean): void {
    if (!this.signedIn || this.bindings.size === 0) return;
    if (full) this.nudgeFull = true;
    if (this.nudgeTimer >= 0) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = -1;
      const f = this.nudgeFull;
      this.nudgeFull = false;
      this.runSync(f);
    }, NUDGE_DEBOUNCE_MS);
  }

  /** 解决一条冲突（'local' 采用本端 / 'remote' 采用对端）。 */
  async resolveConflict(localId: string, choice: string): Promise<void> {
    const conflict = this.conflicts.find((c) => c.localId === localId);
    if (!conflict) return;
    const b = this.bindings.get(conflict.spaceId);
    if (!b) {
      // 空间已解绑 → 无处可推，直接清掉该冲突
      this.conflicts = this.conflicts.filter((c) => c.localId !== localId);
      return;
    }
    try {
      const vk = await this.ensureVaultKeyFor(b.vaultId);
      const ctx: SyncContext = { client: this.client!, vaultId: b.vaultId, spaceId: b.spaceId, vaultKey: vk };
      const st = this.stateFor(b.spaceId);
      if (choice === 'remote') {
        await resolveConflictRemote(conflict, st);
      } else {
        await resolveConflictLocal(ctx, conflict, st);
      }
      this.conflicts = this.conflicts.filter((c) => c.localId !== localId);
      await this.persist();
      await vaultStore.refresh();
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
      if (e.kind === 'delete') {
        // 被删空间的条目已由 deleteSpace 重指派到 fallback。解绑被删空间，并删除其云 vault
        // （写墓碑 → 其它设备据此物理删同名空间，对标 1Password「删除即跨端生效」）；删除失败入
        // 待删队列由 reconcile 幂等重试。
        let deletedVaultId = '';
        if (this.bindings.has(e.spaceId)) {
          const b = this.bindings.get(e.spaceId);
          deletedVaultId = b ? b.vaultId : '';
          this.bindings.delete(e.spaceId);
          this.syncStates.delete(e.spaceId);
          if (b) {
            const k = this.vaultKeys.get(b.vaultId);
            if (k) { wipeBytes(k); this.vaultKeys.delete(b.vaultId); }
          }
          this.anyBound = this.bindings.size > 0;
          await this.persist();
        }
        this.detachedSpaces.delete(e.spaceId);
        this.overQuotaSpaces.delete(e.spaceId);
        await this.refreshSpaceStates();
        await this.runSync(false); // 先把重指派到 fallback 的条目推到其 vault（删 vault 前先保命）
        if (deletedVaultId) await this.deleteRemoteVaultBestEffort(deletedVaultId);
      } else if (e.kind === 'create') {
        await this.reconcileSpaces(); // 自动镜像新空间
      } else if (e.kind === 'rename') {
        await this.updateSpaceMeta(e.spaceId); // 重封 vault meta（新空间名）
        await this.refreshSpaceStates();
      }
    } catch (_e) {
      // best-effort：钩子失败不影响本地空间操作
    }
  }

  /** 重封某空间 vault 的 meta（空间名变更后，让其它设备可按新名匹配）。 */
  private async updateSpaceMeta(spaceId: string): Promise<void> {
    const b = this.bindings.get(spaceId);
    if (!b) return;
    const vk = await this.ensureVaultKeyFor(b.vaultId);
    const space = await this.resolveSpace(spaceId);
    const metaBlob = toB64(sealVaultMeta(vk, { name: space.name, glyph: deriveGlyph(space.name) }));
    await this.client!.updateVaultMeta(b.vaultId, { encrypted_meta: metaBlob });
  }

  /* ------------------------------------------------------------------------ */
  /* vault 锁定/解锁钩子（由 VaultStore 调用）                                  */
  /* ------------------------------------------------------------------------ */

  /** 解锁 vault 后自动恢复云会话、自动镜像并同步（用同一主密码，无需单独云登录）。 */
  async onVaultUnlocked(masterPassword: string): Promise<void> {
    if (!this.configured || !this.hasAccount || this.signedIn || this.autoRestoreDisabled || !masterPassword) {
      return;
    }
    try {
      await this.restoreSession(masterPassword);
      if (this.mfaRequired) {
        // MFA 账户无法静默自动恢复（每次都需 TOTP）→ 取消并禁用本会话自动恢复，用户手动登录
        this.cancelMfa();
        this.autoRestoreDisabled = true;
        return;
      }
      // restoreSession 成功（establishSession → kickReconcile）已触发自动镜像与同步，此处无需重复。
    } catch (_e) {
      // 解锁主密码与云账户密码可能不一致：静默禁用本次自动恢复（不打扰用户），
      // 用户可在「云账户」手动登录；成功登录会经 establishSession 重新启用。
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
    if (this.nudgeTimer >= 0) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = -1;
    }
    this.refreshSpaceStates();
  }

  /* ------------------------------------------------------------------------ */
  /* 内部                                                                      */
  /* ------------------------------------------------------------------------ */

  private ensureClient(): void {
    if (!this.client) {
      if (!this.baseUrl) throw new Error('云服务地址未配置');
      this.client = new CloudClient(this.baseUrl);
    }
  }

  private requireSession(): void {
    if (!this.signedIn || !this.accountPriv || !this.accountPub) {
      throw new Error('请先登录云账户');
    }
  }

  /** 取某空间的水位 Map（不存在则建空）。 */
  private stateFor(spaceId: string): Map<string, CloudItemSyncState> {
    let m = this.syncStates.get(spaceId);
    if (!m) {
      m = new Map<string, CloudItemSyncState>();
      this.syncStates.set(spaceId, m);
    }
    return m;
  }

  /** 取/解封某 vault 的 per-vault key（缓存优先）。 */
  private async ensureVaultKeyFor(vaultId: string): Promise<Uint8Array> {
    const cached = this.vaultKeys.get(vaultId);
    if (cached) return cached;
    if (!this.accountPriv) throw new Error('云会话未建立，请重新登录');
    const m = await this.client!.getVaultMemberSelf(vaultId);
    const vk = openVaultKey(this.accountPriv, fromB64(m.wrapped_vault_key));
    this.vaultKeys.set(vaultId, vk);
    return vk;
  }

  /** 解密某远端 vault 的 meta 名（无 meta / 非成员 / 解密失败 → ''）。 */
  private async decryptRemoteName(v: VaultSummary): Promise<string> {
    if (!v.encrypted_meta) return '';
    try {
      const vk = await this.ensureVaultKeyFor(v.vault_id);
      const meta = openVaultMeta(vk, fromB64(v.encrypted_meta));
      return meta.name;
    } catch (_e) {
      return '';
    }
  }

  /** vault id 的短前缀（无名 vault 的确定性兜底空间名用；跨设备一致）。 */
  private shortVaultId(id: string): string {
    return id.length > 8 ? id.slice(0, 8) : id;
  }

  /** 取某空间快照（用于名称/建库）。已删空间返回占位。 */
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

  /** 由本地空间 + 绑定 + 冻结/解绑/超额集合投影 spaceStates（页面数据源）。 */
  private async refreshSpaceStates(): Promise<void> {
    let spaces: Space[] = [];
    try {
      const snap = await vaultService.listSpaces();
      spaces = snap.spaces;
    } catch (_e) {
      this.spaceStates = [];
      this.anyBound = false;
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
        vaultId: bound ? b!.vaultId : '',
        bound,
        frozen: bound ? this.frozenVaultIds.has(b!.vaultId) : false,
        detached: this.detachedSpaces.has(s.id),
        overQuota: this.overQuotaSpaces.has(s.id),
      });
    }
    this.spaceStates = out;
    this.anyBound = anyBound;
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
    priv: Uint8Array,
    pub: Uint8Array,
  ): void {
    this.wipeSessionKeys();
    this.clearMfaPending();
    this.accountPriv = priv;
    this.accountPub = pub;
    this.email = email;
    this.accountId = accountId;
    this.secretKey = secretKey;
    this.signedIn = true;
    this.hasAccount = true;
    this.autoRestoreDisabled = false;
    this.startPeriodic();
    this.startRealtime();
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
    this.token = '';
    if (this.client) this.client.clearToken();
    this.stopPeriodic();
    this.stopRealtime();
    this.clearMfaPending();
  }

  private handleSyncError(e: Object): void {
    if (e instanceof CloudSyncError && e.code === 'unauthorized') {
      this.tearDownSession();
      this.lastError = '云会话已失效，请重新登录';
      return;
    }
    if (e instanceof APIError && e.isUnauthorized()) {
      this.tearDownSession();
      this.lastError = '云会话已失效，请重新登录';
      return;
    }
    this.lastError = this.messageOf(e);
  }

  private async persist(): Promise<void> {
    const useHuks = this.secretsBlobB64.length > 0;
    const account: CloudAccountRecord = {
      baseUrl: this.baseUrl,
      email: this.email,
      accountId: this.accountId,
      secretKey: useHuks ? '' : this.secretKey,
      token: useHuks ? '' : this.token,
      userId: this.userId,
      tenantId: this.tenantId,
      secrets: this.secretsBlobB64,
    };
    const vaults: CloudVaultBinding[] = [];
    this.bindings.forEach((b) => vaults.push({ spaceId: b.spaceId, vaultId: b.vaultId, cursor: b.cursor }));
    const syncState: Record<string, Record<string, CloudItemSyncState>> =
      JSON.parse('{}') as Record<string, Record<string, CloudItemSyncState>>;
    this.syncStates.forEach((m, spaceId) => {
      const inner: Record<string, CloudItemSyncState> = JSON.parse('{}') as Record<string, CloudItemSyncState>;
      m.forEach((st, id) => { inner[id] = st; });
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
    } catch (_e) {
      // 持久化失败不阻塞主流程（数据可经重新登录恢复）
    }
  }

  /** 完成 MFA（TOTP）二次验证并建立会话。 */
  async completeMfa(code: string): Promise<void> {
    const p = this.mfaPending;
    if (!p) throw new Error('无待验证的 MFA 流程');
    if (!code || !code.trim()) throw new Error('请输入验证码');
    try {
      const resp = await this.client!.loginMfa({ mfa_token: p.mfaToken, code: code.trim() });
      this.applyToken(resp.session_token);
      const sess = await this.recoverKeyset(p.auk);
      this.establishSession(p.email, p.sk.accountId, p.secretKeyStr, sess.priv, sess.pub);
      await this.refreshSecretsBlob();
      await this.persist();
      this.kickReconcile();
    } catch (e) {
      if (e instanceof APIError) {
        if (e.isGone()) {
          this.clearMfaPending();
          throw new Error('验证已超时，请重新登录');
        }
        if (e.isUnauthorized()) throw new Error('验证码错误，请重试');
        if (e.status === 429) throw new Error('尝试过于频繁，请稍后再试');
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
          public_key: toB64(gen.publicKey), encrypted_private_key: toB64(wrapped), algo: 'x25519',
        });
        return { pub: gen.publicKey, priv: gen.privateKey };
      }
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  /** 重算 HUKS 加密的 secrets blob（secretKey/token 变更后）；HUKS 不可用则退化为明文。 */
  private async refreshSecretsBlob(): Promise<void> {
    try {
      const plainObj: CloudSecretsPlain = { secretKey: this.secretKey, token: this.token };
      const blob = await sealCloudSecrets(utf8(JSON.stringify(plainObj)));
      this.secretsBlobB64 = toB64(blob);
      return;
    } catch (_e) {
      // HUKS 不可用 → 明文回退
    }
    this.secretsBlobB64 = '';
  }

  /** 从持久化账户记录恢复 secretKey/token（HUKS 解密或明文回退）。 */
  private async loadSecrets(account: CloudAccountRecord): Promise<void> {
    if (account.secrets) {
      this.secretsBlobB64 = account.secrets;
      try {
        const plain = await openCloudSecrets(fromB64(account.secrets));
        const j = JSON.parse(utf8Decode(plain)) as CloudSecretsPlain;
        this.secretKey = typeof j.secretKey === 'string' ? j.secretKey : '';
        this.token = typeof j.token === 'string' ? j.token : '';
      } catch (_e) {
        this.secretKey = '';
        this.token = '';
      }
    } else {
      this.secretKey = account.secretKey;
      this.token = account.token;
      this.secretsBlobB64 = '';
    }
  }

  /** 解码自身 JWT 的 sid（不验签，仅读 payload 段）。失败返回 ''。 */
  private sessionIdFromToken(token: string): string {
    try {
      const parts = token.split('.');
      if (parts.length < 2) return '';
      let seg = parts[1].replace(new RegExp('-', 'g'), '+').replace(new RegExp('_', 'g'), '/');
      while (seg.length % 4 !== 0) seg += '=';
      const obj = JSON.parse(utf8Decode(fromB64(seg))) as Record<string, Object>;
      const sid = obj.sid;
      return typeof sid === 'string' ? sid : '';
    } catch (_e) {
      return '';
    }
  }

  private startPeriodic(): void {
    this.stopPeriodic();
    this.periodicTimer = setInterval(() => {
      if (this.signedIn && this.bindings.size > 0 && vaultService.isUnlocked()) {
        const full = this.lastFullSyncAt === 0 || Date.now() - this.lastFullSyncAt >= 6 * 60 * 60 * 1000;
        this.runSync(full);
      }
    }, PERIODIC_SYNC_MS);
  }

  private stopPeriodic(): void {
    if (this.periodicTimer >= 0) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = -1;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 实时事件流 (SSE)                                                          */
  /* ------------------------------------------------------------------------ */

  /** 启动实时事件流（幂等）。 */
  private startRealtime(): void {
    if (!this.realtimeStopped) return;
    if (!this.signedIn || !this.client) return;
    this.realtimeStopped = false;
    this.realtimeBackoff = 1000;
    this.connectRealtime();
  }

  /** 停止实时事件流（幂等，不触发重连）。 */
  private stopRealtime(): void {
    this.realtimeStopped = true;
    if (this.realtimeTimer >= 0) {
      clearTimeout(this.realtimeTimer);
      this.realtimeTimer = -1;
    }
    if (this.eventStream) {
      this.eventStream.close();
      this.eventStream = null;
    }
  }

  /** 重建实时流（绑定/解绑后刷新服务端 vault 过滤快照）。 */
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
    if (name === 'revoked') {
      this.tearDownSession();
      this.lastError = '云会话已被吊销，请重新登录';
      this.refreshSpaceStates();
      return;
    }
    if (name === 'resync') {
      this.scheduleNudge(true); // delta 可能有洞 → 去抖全量
      return;
    }
    if (name === 'vault_deleted') {
      // 某设备主动删除了一个 vault → 触发对账，step 0 消费墓碑物理删本地空间（实时跨端生效）。
      this.kickReconcile();
      return;
    }
    if (name === 'change') {
      this.scheduleNudge(false); // 多 vault：命中即增量遍历所有绑定（seq 仅提示，未用）
    }
    // 未知事件忽略
  }

  private onRealtimeClosed(err: APIError | null): void {
    this.eventStream = null;
    if (this.realtimeStopped) return;
    if (err && err.isUnauthorized()) {
      this.tearDownSession(); // 401 重连只会一直 401 → 视为会话失效
      this.lastError = '云会话已失效，请重新登录';
      this.refreshSpaceStates();
      return;
    }
    const healthy = Date.now() - this.realtimeConnectedAt >= 30_000;
    if (healthy) this.realtimeBackoff = 1000;
    const delay = this.realtimeBackoff + Math.floor(Math.random() * (this.realtimeBackoff / 2));
    this.realtimeBackoff = Math.min(this.realtimeBackoff * 2, 120_000);
    if (this.realtimeTimer >= 0) clearTimeout(this.realtimeTimer);
    this.realtimeTimer = setTimeout(() => {
      this.realtimeTimer = -1;
      this.connectRealtime();
    }, delay);
  }

  private friendly(e: Object): Error {
    if (e instanceof APIError) {
      if (e.isConflict()) return new Error('该邮箱已注册');
      if (e.isUnauthorized()) return new Error('认证失败：邮箱、主密码或 Secret Key 不正确');
      if (e.isPlanLimit()) return new Error('已达到套餐的云保险库数量上限，请升级套餐或解绑其它空间');
      if (e.isVaultFrozen()) return new Error('云保险库已冻结（套餐降级），无法写入');
      if (e.isNetwork()) return new Error(`网络错误：${e.message}`);
      return new Error(e.message);
    }
    if (e instanceof Error) return e;
    return new Error(String(e));
  }

  private messageOf(e: Object): string {
    if (e instanceof Error) return e.message;
    return String(e);
  }
}

/** 进程内单例。 */
export const cloudService = new CloudService();
