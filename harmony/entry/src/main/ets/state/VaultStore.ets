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
  type ItemPayload,
  type UpdateItemPatch,
  type VaultItemType,
  type VaultStatus,
} from '../lib/VaultService';
import type { Space } from '../lib/Spaces';
import { clearBreachCache } from '../lib/Breach';

/* ----------------------------------------------------------------------------
 * 过滤选项 —— 与 phone/(tabs)/vault.tsx 顶部筛选条对齐
 * -------------------------------------------------------------------------- */

export type VaultFilterType = VaultItemType | 'all';

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
      if (t !== 'all' && it.type !== t) return false;
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
}

/* ----------------------------------------------------------------------------
 * 进程级单例
 * -------------------------------------------------------------------------- */

export const vaultStore = new VaultStore();
