// ZPass HarmonyOS —— 云同步服务（@ObservedV2 单例，服务 + 反应式状态合一）
//
// 角色对应 desktop internal/services/cloudservice.go + 渲染层 stores/cloud.ts：
// 账户注册 / SRP-6a 登录 / keyset 收发 / 云 vault 创建·绑定 / 同步触发 / 冲突管理。
// 与 SyncServer.ets 同范式：@Trace 字段直接给页面绑定，方法驱动业务。
//
// 零知识：主密码只作方法入参瞬时使用，绝不落盘；账户私钥 / per-vault key 仅内存
// （vault 锁定即清除）；持久化只存 token + Secret Key + 绑定信息（见 CloudStorage）。
//
// 会话生命周期与 vault 解锁对齐：
//   - 解锁（输入主密码）→ onVaultUnlocked(mp) 自动恢复云会话并同步（无需单独云登录）
//   - 锁定 → onVaultLocked() 清除内存密钥、停周期同步
//   - 401（会话失效）→ tearDownSession，保留账户记录待重新登录

import {
  APIError,
  CloudClient,
  type KdfParams,
  type VaultSummary,
  type EventStreamHandle,
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
  parseSecretKey,
  type ParsedSecretKey,
  sealVaultKey,
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
import { vaultService } from './VaultService';
import { deleteCloudSecretsKey, openCloudSecrets, sealCloudSecrets } from './CloudSecretsHuks';
import { vaultStore } from '../state/VaultStore';

const PERIODIC_SYNC_MS: number = 90_000;
const NUDGE_DEBOUNCE_MS: number = 2_000;

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
  /** 是否已绑定云 vault。 */
  @Trace vaultBound: boolean = false;
  @Trace vaultId: string = '';
  @Trace syncing: boolean = false;
  @Trace lastSyncAt: number = 0;
  @Trace lastError: string = '';
  /** vault 因套餐降级冻结（拉取放行、推送被拒）。 */
  @Trace frozen: boolean = false;
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
  private vaultKey: Uint8Array | null = null;
  private secretKey: string = '';
  private token: string = '';
  private userId: string = '';
  private tenantId: string = '';
  private cursor: number = 0;
  private periodicTimer: number = -1;
  private nudgeTimer: number = -1;
  /** 解锁主密码 ≠ 云账户密码时，避免每次解锁都白跑一次 Argon2 失败登录；成功手动登录后重置。 */
  private autoRestoreDisabled: boolean = false;
  /** per-item 同步水位（增量用）；持久化到 CloudStorage.syncState。 */
  private syncState: Map<string, CloudItemSyncState> = new Map<string, CloudItemSyncState>();
  /** 上次全量对账时刻（周期同步每 6h 升级一次全量）。 */
  private lastFullSyncAt: number = 0;
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
      if (st.vault) {
        this.vaultId = st.vault.vaultId;
        this.cursor = st.vault.cursor;
        this.vaultBound = true;
      }
      if (st.syncState) {
        for (const id of Object.keys(st.syncState)) this.syncState.set(id, st.syncState[id]);
      }
    } catch (_e) {
      // 损坏/缺失 → 空状态
    } finally {
      this.hydrated = true;
      vaultStore.registerCloudHooks(
        (mp: string) => { this.onVaultUnlocked(mp); },
        () => { this.onVaultLocked(); },
      );
      vaultService.registerMutationHook(() => { this.nudge(); });
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
    this.vaultBound = false;
    this.vaultId = '';
    this.email = '';
    this.accountId = '';
    this.secretKey = '';
    this.secretsBlobB64 = '';
    this.cursor = 0;
    this.syncState.clear();
    this.lastFullSyncAt = 0;
    this.secretKeyBackup = '';
    try {
      await deleteCloudSecretsKey();
    } catch (_e) {
      // 忽略
    }
    await clearCloudState();
  }

  /* ------------------------------------------------------------------------ */
  /* 云 vault 创建 / 绑定                                                       */
  /* ------------------------------------------------------------------------ */

  /** 列出账户下的云 vault（供绑定选择）。 */
  async listRemoteVaults(): Promise<VaultSummary[]> {
    this.requireSession();
    try {
      const resp = await this.client!.listVaults();
      return resp.vaults;
    } catch (e) {
      throw this.friendly(e);
    }
  }

  /** 新建云 vault（铸新 vault key、用账户公钥封装上传），并立即首次同步。 */
  async createCloudVault(): Promise<void> {
    this.requireSession();
    try {
      const vk = generateVaultKey();
      const wrapped = sealVaultKey(this.accountPub!, vk);
      const resp = await this.client!.createVault({ wrapped_vault_key: toB64(wrapped) });
      if (this.vaultKey) wipeBytes(this.vaultKey);
      this.vaultKey = vk;
      this.vaultId = resp.vault_id;
      this.cursor = 0;
      this.syncState.clear();
      this.lastFullSyncAt = 0;
      this.vaultBound = true;
      await this.persist();
    } catch (e) {
      throw this.friendly(e);
    }
    await this.runSync(true);
    this.restartRealtime();
  }

  /** 绑定已有云 vault（用账户私钥解封 wrapped_vault_key），并立即首次同步。 */
  async bindCloudVault(vaultId: string): Promise<void> {
    this.requireSession();
    if (!vaultId) throw new Error('vault id 为空');
    try {
      const m = await this.client!.getVaultMemberSelf(vaultId);
      if (this.vaultKey) wipeBytes(this.vaultKey);
      this.vaultKey = openVaultKey(this.accountPriv!, fromB64(m.wrapped_vault_key));
      this.vaultId = vaultId;
      this.cursor = 0;
      this.syncState.clear();
      this.lastFullSyncAt = 0;
      this.vaultBound = true;
      await this.persist();
    } catch (e) {
      throw this.friendly(e);
    }
    await this.runSync(true);
    this.restartRealtime();
  }

  /* ------------------------------------------------------------------------ */
  /* 同步                                                                      */
  /* ------------------------------------------------------------------------ */

  /** 手动「立即同步」—— 全量对账。 */
  async syncNow(): Promise<void> {
    await this.runSync(true);
  }

  /**
   * 核心同步：full=true 全量重建（登录/绑定/手动/resync/6h），否则增量 delta。
   * syncing 守护防重入；进行中收到的触发记为 pending，结束后补跑一次。
   */
  async runSync(full: boolean): Promise<void> {
    if (!this.signedIn || !this.vaultBound) return;
    if (!vaultService.isUnlocked()) return;
    if (this.syncing) {
      this.syncPending = true;
      if (full) this.pendingFull = true;
      return;
    }
    this.syncing = true;
    this.lastError = '';
    try {
      await this.ensureVaultKey();
      const ctx: SyncContext = { client: this.client!, vaultId: this.vaultId, vaultKey: this.vaultKey! };
      const outcome = await runCloudSync(ctx, full, this.syncState, this.cursor);
      this.cursor = outcome.newCursor;
      this.frozen = outcome.frozen;
      this.conflicts = full ? outcome.conflicts : this.mergeConflicts(outcome.conflicts);
      this.lastSyncAt = Date.now();
      if (full) this.lastFullSyncAt = this.lastSyncAt;
      await this.persist();
      if (outcome.applied > 0) await vaultStore.refresh();
    } catch (e) {
      this.handleSyncError(e);
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

  /** 增量冲突合并：保留未解决的旧冲突，按 localId upsert 新冲突。 */
  private mergeConflicts(incoming: CloudConflict[]): CloudConflict[] {
    if (incoming.length === 0) return this.conflicts;
    const byId = new Map<string, CloudConflict>();
    for (const c of this.conflicts) byId.set(c.localId, c);
    for (const c of incoming) byId.set(c.localId, c);
    const out: CloudConflict[] = [];
    byId.forEach((c) => out.push(c));
    return out;
  }

  /** 本地编辑后的去抖增量同步触发。 */
  nudge(): void {
    this.scheduleNudge(false);
  }

  /** 去抖同步：合并 2s 内多次触发；期间任一 full 请求则整体升级为全量。 */
  private scheduleNudge(full: boolean): void {
    if (!this.signedIn || !this.vaultBound) return;
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
    try {
      await this.ensureVaultKey();
      const ctx: SyncContext = { client: this.client!, vaultId: this.vaultId, vaultKey: this.vaultKey! };
      if (choice === 'remote') {
        await resolveConflictRemote(conflict, this.syncState);
      } else {
        await resolveConflictLocal(ctx, conflict, this.syncState);
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
  /* vault 锁定/解锁钩子（由 VaultStore 调用）                                  */
  /* ------------------------------------------------------------------------ */

  /** 解锁 vault 后自动恢复云会话并同步（用同一主密码，无需单独云登录）。 */
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
      if (this.vaultBound) await this.runSync(true);
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
    this.frozen = false;
    this.clearMfaPending();
    this.stopPeriodic();
    this.stopRealtime();
    if (this.nudgeTimer >= 0) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = -1;
    }
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
    this.vaultKey = null;
    this.email = email;
    this.accountId = accountId;
    this.secretKey = secretKey;
    this.signedIn = true;
    this.hasAccount = true;
    this.frozen = false;
    this.autoRestoreDisabled = false;
    this.startPeriodic();
    this.startRealtime();
  }

  /** 绑定态下若内存无 vault key（如解锁后恢复），用账户私钥重新解封。 */
  private async ensureVaultKey(): Promise<void> {
    if (this.vaultKey) return;
    if (!this.vaultBound || !this.vaultId) throw new Error('未绑定云 vault');
    if (!this.accountPriv) throw new Error('云会话未建立，请重新登录');
    const m = await this.client!.getVaultMemberSelf(this.vaultId);
    this.vaultKey = openVaultKey(this.accountPriv, fromB64(m.wrapped_vault_key));
  }

  private wipeSessionKeys(): void {
    if (this.accountPriv) wipeBytes(this.accountPriv);
    if (this.vaultKey) wipeBytes(this.vaultKey);
    this.accountPriv = null;
    this.accountPub = null;
    this.vaultKey = null;
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
    const vault: CloudVaultBinding | null =
      this.vaultBound && this.vaultId ? { vaultId: this.vaultId, cursor: this.cursor } : null;
    const syncState: Record<string, CloudItemSyncState> = JSON.parse('{}') as Record<string, CloudItemSyncState>;
    this.syncState.forEach((st, id) => { syncState[id] = st; });
    try {
      await saveCloudState({ account, vault, syncState });
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
      if (this.signedIn && this.vaultBound && vaultService.isUnlocked()) {
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

  /** 重建实时流（绑定新 vault 后刷新服务端 vault 过滤快照）。 */
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
      return;
    }
    if (name === 'resync') {
      this.scheduleNudge(true); // delta 可能有洞 → 去抖全量
      return;
    }
    if (name === 'change') {
      this.scheduleNudge(false); // 本端单 vault：命中即增量（seq 仅提示，未用）
    }
    // 未知事件忽略
  }

  private onRealtimeClosed(err: APIError | null): void {
    this.eventStream = null;
    if (this.realtimeStopped) return;
    if (err && err.isUnauthorized()) {
      this.tearDownSession(); // 401 重连只会一直 401 → 视为会话失效
      this.lastError = '云会话已失效，请重新登录';
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
      if (e.isVaultFrozen()) return new Error('vault 已冻结（套餐降级），无法写入');
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
