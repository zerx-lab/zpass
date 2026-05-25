// 保险库状态中心 —— phone 端的单一数据源
//
// 与 desktop 对齐：
//   - 双层密钥（Argon2id KEK → XChaCha20-Poly1305 包装 DEK）
//   - vault 状态三态：未初始化 / 已初始化未解锁 / 已解锁
//   - 真实加密落地，由 `lib/vault-service` 统一管理
//
// 本 context 是 vaultService 的 React 适配层：
//   - 拉取/展示已解锁状态下的 items 列表，自动在锁定时清空
//   - 把 service 异步 API 投影为对 UI 友好的命令式动作
//   - 不再维护任何 mock / breaches / activity / mode

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { VaultItem, VaultItemType } from "@/data/vault";
import {
  vaultService,
  VaultError,
  type ItemPayload,
} from "@/lib/vault-service";

/* ----------------------------------------------------------------------------
 * 类型
 * -------------------------------------------------------------------------- */

/** 分配律 Omit —— 在联合类型每个成员上分别 Omit */
type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

/** 新建条目时的草稿：不含 id / modified（由 service 补全） */
export type ItemDraft = DistributiveOmit<VaultItem, "id" | "modified">;

/** 更新补丁 */
export type ItemPatch = DistributiveOmit<Partial<VaultItem>, never>;

/** 操作结果 —— 异步且可能失败的入口统一用这个形状 */
export type ActionResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

interface VaultContextValue {
  items: VaultItem[];
  locked: boolean;
  /** vault 是否已经设置过主密码 */
  initialized: boolean;
  /** 首次状态探测是否完成（避免渲染期间闪烁 onboarding） */
  hydrated: boolean;

  getItem: (id: string) => VaultItem | undefined;
  addItem: (draft: ItemDraft) => Promise<VaultItem | null>;
  updateItem: (id: string, patch: ItemPatch) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  /** 批量导入（重新分配 id），返回成功导入数量 */
  importItems: (incoming: VaultItem[]) => Promise<number>;
  /** 清空所有条目（保留 vault meta，不需要重新设置主密码） */
  clearAll: () => Promise<void>;
  /** 彻底重置：删除 vault 文件并回到 onboarding */
  reset: () => Promise<void>;

  initialize: (password: string) => Promise<ActionResult>;
  unlock: (password: string) => Promise<ActionResult>;
  lock: () => void;
  changeMasterPassword: (
    oldPwd: string,
    newPwd: string,
  ) => Promise<ActionResult>;
}

const VaultContext = createContext<VaultContextValue | null>(null);

/* ----------------------------------------------------------------------------
 * Provider
 * -------------------------------------------------------------------------- */

export function VaultProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<VaultItem[]>([]);
  const [locked, setLocked] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // 启动时探测一次 vault 状态
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const st = await vaultService.status();
        if (!alive) return;
        setInitialized(st.initialized);
        setLocked(!st.unlocked);
      } catch {
        // 文件不存在 / 解析失败：当作未初始化
        if (!alive) return;
        setInitialized(false);
        setLocked(true);
      } finally {
        if (alive) setHydrated(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 解锁后自动加载 items；锁定后清空
  const refresh = useCallback(async () => {
    if (!vaultService.isUnlocked()) {
      setItems([]);
      return;
    }
    const payloads = await vaultService.listItems();
    setItems(payloads.map(toVaultItem));
  }, []);

  useEffect(() => {
    if (!locked) refresh();
    else setItems([]);
  }, [locked, refresh]);

  /* ---------------------------- CRUD ---------------------------- */

  const getItem = useCallback(
    (id: string) => items.find((i) => i.id === id),
    [items],
  );

  const addItem = useCallback(
    async (draft: ItemDraft): Promise<VaultItem | null> => {
      const { type, name, fields } = fromDraft(draft);
      try {
        const created = await vaultService.createItem(type, name, fields);
        const item = toVaultItem(created);
        setItems((prev) => [item, ...prev]);
        return item;
      } catch (e) {
        console.warn("addItem failed", e);
        return null;
      }
    },
    [],
  );

  const updateItem = useCallback(
    async (id: string, patch: ItemPatch): Promise<void> => {
      const cur = items.find((i) => i.id === id);
      if (!cur) return;
      const merged = { ...cur, ...patch, id } as VaultItem;
      const { type, name, fields } = fromDraft(merged as ItemDraft);
      try {
        const updated = await vaultService.updateItem(id, {
          type,
          name,
          fields,
        });
        const next = toVaultItem(updated);
        setItems((prev) => prev.map((i) => (i.id === id ? next : i)));
      } catch (e) {
        console.warn("updateItem failed", e);
      }
    },
    [items],
  );

  const deleteItem = useCallback(async (id: string): Promise<void> => {
    try {
      await vaultService.deleteItem(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e) {
      console.warn("deleteItem failed", e);
    }
  }, []);

  const toggleFavorite = useCallback(
    async (id: string): Promise<void> => {
      const cur = items.find((i) => i.id === id);
      if (!cur) return;
      await updateItem(id, { favorite: !cur.favorite } as ItemPatch);
    },
    [items, updateItem],
  );

  const importItems = useCallback(
    async (incoming: VaultItem[]): Promise<number> => {
      if (incoming.length === 0) return 0;
      const drafts = incoming.map((it) => {
        // 用导入数据的 type/name/fields，丢弃原 id（由 service 重新分配）
        const { type, name, fields } = fromDraft(it as ItemDraft);
        return { type, name, fields };
      });
      try {
        const n = await vaultService.importItems(drafts);
        await refresh();
        return n;
      } catch (e) {
        console.warn("importItems failed", e);
        return 0;
      }
    },
    [refresh],
  );

  const clearAll = useCallback(async (): Promise<void> => {
    try {
      await vaultService.clearAllItems();
      setItems([]);
    } catch (e) {
      console.warn("clearAll failed", e);
    }
  }, []);

  const reset = useCallback(async (): Promise<void> => {
    await vaultService.reset();
    setItems([]);
    setLocked(true);
    setInitialized(false);
  }, []);

  /* ---------------------- 初始化 / 锁定 / 改密 ---------------------- */

  const initialize = useCallback(
    async (password: string): Promise<ActionResult> => {
      try {
        await vaultService.initialize(password);
        setInitialized(true);
        setLocked(false);
        return { ok: true };
      } catch (e) {
        return toActionError(e);
      }
    },
    [],
  );

  const unlock = useCallback(
    async (password: string): Promise<ActionResult> => {
      try {
        await vaultService.unlock(password);
        setLocked(false);
        return { ok: true };
      } catch (e) {
        return toActionError(e);
      }
    },
    [],
  );

  const lock = useCallback(() => {
    vaultService.lock();
    setLocked(true);
    setItems([]);
  }, []);

  const changeMasterPassword = useCallback(
    async (oldPwd: string, newPwd: string): Promise<ActionResult> => {
      try {
        await vaultService.changeMasterPassword(oldPwd, newPwd);
        return { ok: true };
      } catch (e) {
        return toActionError(e);
      }
    },
    [],
  );

  const value = useMemo<VaultContextValue>(
    () => ({
      items,
      locked,
      initialized,
      hydrated,
      getItem,
      addItem,
      updateItem,
      deleteItem,
      toggleFavorite,
      importItems,
      clearAll,
      reset,
      initialize,
      unlock,
      lock,
      changeMasterPassword,
    }),
    [
      items,
      locked,
      initialized,
      hydrated,
      getItem,
      addItem,
      updateItem,
      deleteItem,
      toggleFavorite,
      importItems,
      clearAll,
      reset,
      initialize,
      unlock,
      lock,
      changeMasterPassword,
    ],
  );

  return (
    <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
  );
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("useVault must be used within <VaultProvider>");
  return ctx;
}

/* ----------------------------------------------------------------------------
 * 模型互转：ItemPayload(后端) ↔ VaultItem(前端展示)
 *
 * 后端只持有 id / type / name / fields；前端 VaultItem 把 fields 摊平到各字段
 * 同时把 updatedAt 投影到 modified、favorite 等元字段一并放进 fields。
 * -------------------------------------------------------------------------- */

function toVaultItem(p: ItemPayload): VaultItem {
  const f = p.fields ?? {};
  const base: BaseShape = {
    id: p.id,
    name: p.name,
    modified: p.updatedAt,
  };
  if (typeof f.folder === "string") base.folder = f.folder;
  if (Array.isArray(f.tags)) base.tags = f.tags.filter((t) => typeof t === "string");
  if (typeof f.notes === "string") base.notes = f.notes;
  if (typeof f.favorite === "boolean") base.favorite = f.favorite;

  switch (p.type) {
    case "login":
      return {
        ...base,
        type: "login",
        username: str(f.username),
        password: str(f.password),
        url: optStr(f.url),
        totp: optStr(f.totp),
        strength: optNum(f.strength),
        breached: optBool(f.breached),
        reused: optBool(f.reused),
        weak: optBool(f.weak),
      } as VaultItem;
    case "card":
      return {
        ...base,
        type: "card",
        cardholder: str(f.cardholder),
        number: str(f.number),
        exp: str(f.exp),
        cvv: str(f.cvv),
        pin: optStr(f.pin),
        brand: str(f.brand) || "Card",
      } as VaultItem;
    case "note":
      return { ...base, type: "note", note: str(f.note) } as VaultItem;
    case "identity":
      return {
        ...base,
        type: "identity",
        first: str(f.first),
        last: str(f.last),
        email: str(f.email),
        phone: str(f.phone),
        address: str(f.address),
        dob: str(f.dob),
        passport: str(f.passport),
      } as VaultItem;
    case "ssh":
      return {
        ...base,
        type: "ssh",
        username: optStr(f.username),
        keyType: optStr(f.keyType),
        fingerprint: optStr(f.fingerprint),
        publicKey: optStr(f.publicKey),
        apiKey: optStr(f.apiKey),
      } as VaultItem;
    case "passkey":
      return {
        ...base,
        type: "passkey",
        rpId: str(f.rpId),
        userName: optStr(f.userName),
        credentialId: str(f.credentialId),
      } as VaultItem;
    case "totp":
      return {
        ...base,
        type: "totp",
        secret: str(f.secret) || str(f.totp),
        issuer: optStr(f.issuer),
        account: optStr(f.account),
      } as VaultItem;
  }
}

interface BaseShape {
  id: string;
  name: string;
  modified: number;
  folder?: string;
  tags?: string[];
  notes?: string;
  favorite?: boolean;
}

function fromDraft(draft: ItemDraft): {
  type: VaultItemType;
  name: string;
  fields: Record<string, unknown>;
} {
  const { type, name, ...rest } = draft as { type: VaultItemType; name: string } & Record<
    string,
    unknown
  >;
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (k === "id" || k === "modified") continue;
    if (v === undefined || v === null || v === "") continue;
    // 独立 totp 条目把 secret 持久化到 fields["totp"] —— 与 desktop
    // ItemTypeTOTP 字段约定一致（fields["totp"] 同时覆盖 login.totp 与
    // 独立 totp 两类来源），保证两端 JSON 导出可直接互导。
    if (type === "totp" && k === "secret") {
      fields["totp"] = v;
      continue;
    }
    fields[k] = v;
  }
  return { type, name, fields };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
function optNum(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function optBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function toActionError(e: unknown): ActionResult {
  if (e instanceof VaultError) {
    return { ok: false, code: e.code, message: e.message };
  }
  if (e instanceof Error) {
    return { ok: false, code: "io", message: e.message };
  }
  return { ok: false, code: "io", message: String(e) };
}
