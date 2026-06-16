// ZPass HarmonyOS —— 全局 vault 状态
//
// 角色与 phone/contexts/vault-context.tsx 对应：vault 业务层之上的、
// 给 UI 用的反应式状态容器。
//
// ArkUI V2 状态范型：
//   @ObservedV2 标注的类 + @Trace 标注的字段 = 字段变更触发依赖该字段的
//   组件重渲染。比 React useContext + useState 粒度更细。
//
// 进程内单例：vaultStore；任何页面用 @Local store: VaultStore = vaultStore
// 取引用即可。

import {
  vaultService,
  itemHasTotp,
  type ItemPayload,
  type UpdateItemPatch,
  type VaultItemType,
  type VaultStatus,
} from '../lib/VaultService';
import { DEFAULT_SPACE_ID, type Space } from '../lib/Spaces';
import { clearBreachCache } from '../lib/Breach';

/* ----------------------------------------------------------------------------
 * 过滤选项 —— 与 phone/(tabs)/vault.tsx 顶部筛选条对齐
 * -------------------------------------------------------------------------- */

export type VaultFilterType = VaultItemType | 'all';

/**
 * 仪表盘首页各入口的归类维度。一个 scope 一个谓词(matchesScope)，
 * 计数(countScope)与列表(scopedItems)共用同一谓词，避免计数与内容口径不一致。
 *   - 'all'   全部条目
 *   - 'fav'   收藏
 *   - 'totp'  验证器(独立 totp + 携带 totp 的 login)
 *   - 'type'  指定 VaultItemType(value = 类型名)
 *   - 'space' 指定空间(value = spaceId)
 */
export type ScopeKind = 'all' | 'fav' | 'totp' | 'type' | 'space';

/* ----------------------------------------------------------------------------
 * VaultStore
 * -------------------------------------------------------------------------- */

@ObservedV2
export class VaultStore {
  /* ----- vault 生命周期 ----- */

  /** vault 文件状态 */
  @Trace status: VaultStatus = { initialized: false, unlocked: false, itemCount: 0 };

  /** 上次 refreshStatus 失败的错误信息（UI 顶部提示用） */
  @Trace lastError: string = '';

  /** 解锁中 / 初始化中标志 —— UI 进度条 / 防双击 */
  @Trace busy: boolean = false;

  /** 首次 refresh 完成（status 已水合）—— Index 启动闪屏守卫，避免冷启动闪错屏 */
  @Trace hydrated: boolean = false;

  /* ----- 数据 ----- */

  /** 当前 active space 的解密 item 集合（不含 tombstone） */
  @Trace items: ItemPayload[] = [];

  /** 所有空间列表 */
  @Trace spaces: Space[] = [];

  /** 当前激活空间 id */
  @Trace activeSpaceId: string = '';

  /* ----- UI 过滤 / 搜索（不持久化） ----- */

  @Trace query: string = '';
  @Trace filterType: VaultFilterType = 'all';
  @Trace onlyFavorites: boolean = false;

  /* ----- 信任设备能力 / 启用态（由 refresh 填充，给 MeTab toggle 用） ----- */

  @Trace trustedSupported: boolean = false;
  @Trace trustedEnabled: boolean = false;

  /* ----- 云同步钩子（由 CloudService.hydrate 注册；VaultStore 不反向 import CloudService，避免环） ----- */

  /** 解锁成功后回调（传主密码，用于自动恢复云会话并同步）。 */
  private cloudOnUnlocked: ((masterPassword: string) => void) | null = null;
  /** 锁定时回调（清除云会话内存密钥、停周期同步）。 */
  private cloudOnLocked: (() => void) | null = null;

  /* ------------------------------------------------------------------------ */
  /* 状态查询                                                                  */
  /* ------------------------------------------------------------------------ */

  isUnlocked(): boolean {
    return this.status.unlocked;
  }

  isInitialized(): boolean {
    return this.status.initialized;
  }

  /** 应用过滤器后的 item 列表 —— 供 vault list 直接 ForEach */
  get filteredItems(): ItemPayload[] {
    const q = this.query.trim().toLowerCase();
    const t = this.filterType;
    const fav = this.onlyFavorites;
    const space = this.activeSpaceId;
    return this.items.filter((it) => {
      if (t === 'totp') {
        // 「验证码」tab：纳入独立 totp 条目 + 携带 totp 的 login(2FA/MFA)
        if (!itemHasTotp(it)) return false;
      } else if (t !== 'all' && it.type !== t) {
        return false;
      }
      const itemSpace = (it.fields.spaceId as string | undefined) ?? '';
      if (space && itemSpace && itemSpace !== space) return false;
      if (fav) {
        const f = it.fields.favorite;
        if (f !== true) return false;
      }
      if (q) {
        // 简化搜索：name + 常见字段 (username/email/url/rpId/issuer/account)。
        // 完整 itemSearchText 需要 VaultItem 形状，这里凑起来不划算。
        const parts: string[] = [it.name];
        const fields = it.fields;
        const candidates: string[] = ['username', 'email', 'url', 'rpId', 'issuer', 'account', 'first', 'last'];
        for (const k of candidates) {
          const v = fields[k];
          if (typeof v === 'string') parts.push(v);
        }
        if (Array.isArray(fields.tags)) {
          for (const tag of fields.tags as string[]) parts.push(tag);
        }
        if (!parts.join(' ').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }

  /* ------------------------------------------------------------------------ */
  /* 仪表盘 scope —— 谓词 / 计数 / 列表(三者共用同一谓词)                       */
  /* ------------------------------------------------------------------------ */

  /** item 归属空间：无 spaceId 一律视为默认空间，保证文件夹计数 sum == 总数 */
  private static effectiveSpaceId(it: ItemPayload): string {
    const s = it.fields.spaceId;
    return typeof s === 'string' && s.length > 0 ? s : DEFAULT_SPACE_ID;
  }

  /** 单一 scope 谓词 —— 计数与列表共用 */
  matchesScope(it: ItemPayload, kind: ScopeKind, value: string): boolean {
    if (kind === 'fav') return it.fields.favorite === true;
    if (kind === 'totp') return itemHasTotp(it);
    if (kind === 'type') return it.type === value;
    if (kind === 'space') return VaultStore.effectiveSpaceId(it) === value;
    return true; // 'all'
  }

  /** scope 计数(全量，跨空间) */
  countScope(kind: ScopeKind, value: string): number {
    let n = 0;
    for (const it of this.items) {
      if (this.matchesScope(it, kind, value)) n++;
    }
    return n;
  }

  /** scope + 搜索 过滤后的条目 —— VaultList 直接 ForEach */
  scopedItems(kind: ScopeKind, value: string, query: string): ItemPayload[] {
    const q = query.trim().toLowerCase();
    return this.items.filter((it) => {
      if (!this.matchesScope(it, kind, value)) return false;
      if (q.length > 0 && !this.itemMatchesQuery(it, q)) return false;
      return true;
    });
  }

  /** 与 filteredItems 同口径的简化搜索匹配 */
  private itemMatchesQuery(it: ItemPayload, q: string): boolean {
    const parts: string[] = [it.name];
    const fields = it.fields;
    const candidates: string[] = ['username', 'email', 'url', 'rpId', 'issuer', 'account', 'first', 'last'];
    for (const k of candidates) {
      const v = fields[k];
      if (typeof v === 'string') parts.push(v);
    }
    if (Array.isArray(fields.tags)) {
      for (const tag of fields.tags as string[]) parts.push(tag);
    }
    return parts.join(' ').toLowerCase().includes(q);
  }

  /* ------------------------------------------------------------------------ */
  /* 生命周期动作                                                              */
  /* ------------------------------------------------------------------------ */

  /** 启动 / 解锁后调用，刷新 status + items + spaces + 信任设备态 */
  async refresh(): Promise<void> {
    try {
      this.status = await vaultService.status();
      if (this.status.unlocked) {
        await this.refreshSpaces();
        await this.refreshItems();
      } else {
        this.items = [];
      }
      await this.refreshTrustedState();
      this.lastError = '';
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.hydrated = true;
    }
  }

  /** 单独刷新信任设备能力 + 启用态（refresh 内部会调；MeTab 也独立调） */
  async refreshTrustedState(): Promise<void> {
    try {
      this.trustedSupported = await vaultService.isTrustedDeviceSupported();
    } catch (_e) {
      this.trustedSupported = false;
    }
    try {
      this.trustedEnabled = await vaultService.isTrustedDeviceEnabled();
    } catch (_e) {
      this.trustedEnabled = false;
    }
  }

  async refreshSpaces(): Promise<void> {
    const snap = await vaultService.listSpaces();
    this.spaces = snap.spaces;
    this.activeSpaceId = snap.activeSpaceId;
  }

  async refreshItems(): Promise<void> {
    this.items = await vaultService.listItems();
  }

  async initialize(password: string): Promise<void> {
    this.busy = true;
    try {
      await vaultService.initialize(password);
      await this.refresh();
    } finally {
      this.busy = false;
    }
  }

  async unlock(password: string): Promise<void> {
    this.busy = true;
    try {
      await vaultService.unlock(password);
      await this.refresh();
      if (this.cloudOnUnlocked) this.cloudOnUnlocked(password);
    } finally {
      this.busy = false;
    }
  }

  async tryAutoUnlock(): Promise<boolean> {
    this.busy = true;
    try {
      const ok = await vaultService.tryUnlockWithTrustedDevice();
      if (ok) await this.refresh();
      return ok;
    } finally {
      this.busy = false;
    }
  }

  lock(): void {
    vaultService.lock();
    this.items = [];
    this.status = { initialized: this.status.initialized, unlocked: false, itemCount: 0 };
    // 清空 HIBP 扫描缓存 —— 与 phone 锁定时清空 breach cache 行为一致
    clearBreachCache();
    if (this.cloudOnLocked) this.cloudOnLocked();
  }

  /** 注册云同步生命周期钩子（CloudService 在 hydrate 时调用一次）。 */
  registerCloudHooks(onUnlocked: (masterPassword: string) => void, onLocked: () => void): void {
    this.cloudOnUnlocked = onUnlocked;
    this.cloudOnLocked = onLocked;
  }

  async changeMasterPassword(oldPw: string, newPw: string): Promise<void> {
    this.busy = true;
    try {
      await vaultService.changeMasterPassword(oldPw, newPw);
    } finally {
      this.busy = false;
    }
  }

  async reset(): Promise<void> {
    this.busy = true;
    try {
      await vaultService.reset();
      this.items = [];
      this.spaces = [];
      this.activeSpaceId = '';
      this.status = { initialized: false, unlocked: false, itemCount: 0 };
      this.trustedEnabled = false;
    } finally {
      this.busy = false;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 信任设备启用 / 禁用                                                       */
  /* ------------------------------------------------------------------------ */

  async enableTrustedDevice(confirmPassword: string): Promise<void> {
    this.busy = true;
    try {
      await vaultService.enableTrustedDevice(confirmPassword);
      await this.refreshTrustedState();
    } finally {
      this.busy = false;
    }
  }

  async disableTrustedDevice(): Promise<void> {
    this.busy = true;
    try {
      await vaultService.disableTrustedDevice();
      await this.refreshTrustedState();
    } finally {
      this.busy = false;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 空间                                                                      */
  /* ------------------------------------------------------------------------ */

  async setActiveSpace(id: string): Promise<void> {
    await vaultService.setActiveSpace(id);
    this.activeSpaceId = id;
  }

  async createSpace(name: string): Promise<Space> {
    const s = await vaultService.createSpace(name);
    await this.refreshSpaces();
    return s;
  }

  async renameSpace(id: string, name: string): Promise<void> {
    await vaultService.renameSpace(id, name);
    await this.refreshSpaces();
  }

  async deleteSpace(id: string): Promise<void> {
    await vaultService.deleteSpace(id);
    await this.refreshSpaces();
    await this.refreshItems();
  }

  /* ------------------------------------------------------------------------ */
  /* item CRUD                                                                 */
  /* ------------------------------------------------------------------------ */

  async createItem(
    type: VaultItemType,
    name: string,
    fields: Record<string, Object>,
  ): Promise<ItemPayload> {
    const created = await vaultService.createItem(type, name, fields);
    await this.refreshItems();
    return created;
  }

  async updateItem(
    id: string,
    patch: UpdateItemPatch,
  ): Promise<ItemPayload> {
    const out = await vaultService.updateItem(id, patch);
    await this.refreshItems();
    return out;
  }

  async deleteItem(id: string): Promise<void> {
    await vaultService.deleteItem(id);
    await this.refreshItems();
  }

  async toggleFavorite(id: string): Promise<void> {
    await vaultService.toggleFavorite(id);
    await this.refreshItems();
  }

  async getItem(id: string): Promise<ItemPayload | null> {
    return vaultService.getItem(id);
  }

  /**
   * 同步从内存中已解密的 items 取条目（当前激活空间内）。
   * 供编辑页首帧预填，避免 async 解密造成表单首次构建为空。
   * 未命中（如跨空间）返回 null，调用方应回退到异步 getItem。
   */
  peekItem(id: string): ItemPayload | null {
    if (!id) return null;
    return this.items.find((it) => it.id === id) ?? null;
  }

  /* ------------------------------------------------------------------------ */
  /* 回收站                                                                    */
  /* ------------------------------------------------------------------------ */

  /** 列出回收站条目（软删除 tombstone） */
  async listDeleted(): Promise<ItemPayload[]> {
    return vaultService.listDeleted();
  }

  /** 从回收站恢复，刷新活跃条目使首页计数同步 */
  async restoreItem(id: string): Promise<void> {
    await vaultService.restoreItem(id);
    await this.refreshItems();
  }
}

/* ----------------------------------------------------------------------------
 * 进程级单例
 * -------------------------------------------------------------------------- */

export const vaultStore = new VaultStore();
