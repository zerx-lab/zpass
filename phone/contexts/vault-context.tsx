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
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { VaultItem, VaultItemType } from "@/data/vault";
import {
  vaultService,
  VaultError,
  type ItemPayload,
} from "@/lib/vault-service";
import {
  CUSTOM_FIELDS_KEY,
  parseCustomFields,
  serializeCustomFields,
  type CustomField,
} from "@/lib/custom-fields";
import { DEFAULT_SPACE_ID, type Space } from "@/lib/spaces";
import {
  batchCheckBreaches,
  clearBreachCache,
  type BreachResult,
} from "@/lib/breach";

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
  /** 当前激活空间下的条目（已按 spaceId 过滤） */
  items: VaultItem[];
  /** 所有空间合并的全量条目（用于跨空间统计、调试等场景） */
  allItems: VaultItem[];
  locked: boolean;
  /** vault 是否已经设置过主密码 */
  initialized: boolean;
  /** 首次状态探测是否完成（避免渲染期间闪烁 onboarding） */
  hydrated: boolean;

  /** 当前平台是否支持「信任设备」自动解锁（与 desktop 同名 selector） */
  trustedDeviceSupported: boolean;
  /** 当前 vault 是否已经在此设备启用了自动解锁 */
  trustedDeviceEnabled: boolean;
  /** 是否正在自动解锁中（启动一次性尝试） */
  trustedDeviceTrying: boolean;
  enableTrustedDevice: (confirmPassword: string) => Promise<ActionResult>;
  disableTrustedDevice: () => Promise<ActionResult>;
  /** 锁屏页"使用设备解锁"按钮调用；返回是否成功解锁 */
  tryUnlockWithTrustedDevice: () => Promise<boolean>;

  /** 空间列表（按 order 升序） */
  spaces: Space[];
  /** 当前激活空间 id；首次启动尚未创建任何空间时为 null */
  activeSpaceId: string | null;
  /**
   * 当前激活空间对象（便捷 selector）。未初始化 / 找不到时为 null。
   * 头像 / 标题等纯展示场景用它比每次自己 find 更省事。
   */
  activeSpace: Space | null;
  setActiveSpace: (id: string) => Promise<void>;
  createSpace: (name: string) => Promise<Space | null>;
  renameSpace: (id: string, name: string) => Promise<ActionResult>;
  deleteSpace: (id: string) => Promise<ActionResult>;

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

  /** 上次 HIBP 泄露扫描结果；null = 从未扫描 */
  breachResults: BreachResult[] | null;
  /** 当前是否正在扫描 */
  breachScanning: boolean;
  /** 上次全量扫描完成时间（Unix 毫秒），null = 从未扫描 */
  breachLastScanAt: number | null;
  /** 触发一次全量泄露扫描；force=true 时先清缓存再扫 */
  runBreachScan: (force?: boolean) => Promise<void>;
}

const VaultContext = createContext<VaultContextValue | null>(null);

/* ----------------------------------------------------------------------------
 * Provider
 * -------------------------------------------------------------------------- */

export function VaultProvider({ children }: { children: ReactNode }) {
  const [allItems, setAllItems] = useState<VaultItem[]>([]);
  const [locked, setLocked] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [activeSpaceId, setActiveSpaceIdState] = useState<string | null>(null);

  // HIBP 泄露扫描状态：null = 从未扫描
  const [breachResults, setBreachResults] = useState<BreachResult[] | null>(
    null,
  );
  const [breachScanning, setBreachScanning] = useState(false);
  const [breachLastScanAt, setBreachLastScanAt] = useState<number | null>(null);

  // 信任设备状态：supported 是平台能力（OS 探测），enabled 是当前 vault 是否
  // 启用（vault 文件里有 trustedDevice 行）。两个独立维度。
  const [trustedDeviceSupported, setTrustedDeviceSupported] = useState(false);
  const [trustedDeviceEnabled, setTrustedDeviceEnabled] = useState(false);
  const [trustedDeviceTrying, setTrustedDeviceTrying] = useState(false);

  // 扫描代际 token：lock / reset 时递增，扫描完成对比 token 不一致就丢弃结果。
  // 防止"用户扫描中途按锁屏 → 扫描完成后又把含明文条目名的 results 回写到 state"。
  const breachGenerationRef = useRef(0);
  // allItems 镜像 —— runBreachScan 通过 ref 读最新条目列表，
  // 这样 useCallback deps 可以为空，回调引用稳定。
  const allItemsRef = useRef<VaultItem[]>([]);

  // 启动时探测一次 vault 状态；若已 initialized，顺便把 plaintext 的 spaces
  // 拉一遍 —— 锁屏页 / 我的页头像要展示"当前空间名首字符"，spaces 是
  // plaintext，不需要解锁就能读（参见 vault-service.listSpaces 的注释）。
  //
  // 信任设备：若启用了且 vault 未解锁，**不**在 hydrate 里自动调
  // tryUnlockWithTrustedDevice —— 直接调会立即弹生物识别，对用户来说像
  // 是应用启动就劫持。改由 LockOverlay 渲染后由用户点按钮触发（也可在
  // overlay mount 时用一次性 effect 自动触发，决策见 LockOverlay）。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const st = await vaultService.status();
        if (!alive) return;
        setInitialized(st.initialized);
        setLocked(!st.unlocked);
        if (st.initialized) {
          try {
            const snap = await vaultService.listSpaces();
            if (!alive) return;
            setSpaces(snap.spaces);
            setActiveSpaceIdState(snap.activeSpaceId);
          } catch {
            // plaintext 读取失败不致命 —— 头像走 fallback "Z"
          }
          // 信任设备能力 + 是否启用 —— 锁定态下也能查
          try {
            const [supported, enabled] = await Promise.all([
              vaultService.isTrustedDeviceSupported(),
              vaultService.isTrustedDeviceEnabled(),
            ]);
            if (!alive) return;
            setTrustedDeviceSupported(supported);
            setTrustedDeviceEnabled(enabled);
          } catch {
            // 探测失败按"不可用"处理 —— 与 desktop ErrTrustedDeviceUnsupported 等价
          }
        }
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

  // 解锁后加载 items + 刷新 spaces；锁定后只清 items，spaces 保留
  // （plaintext，锁屏头像依赖）
  const refresh = useCallback(async () => {
    if (!vaultService.isUnlocked()) {
      setAllItems([]);
      return;
    }
    const [payloads, spaceSnap] = await Promise.all([
      vaultService.listItems(),
      vaultService.listSpaces(),
    ]);
    setAllItems(payloads.map(toVaultItem));
    setSpaces(spaceSnap.spaces);
    setActiveSpaceIdState(spaceSnap.activeSpaceId);
  }, []);

  useEffect(() => {
    if (!locked) {
      refresh();
    } else {
      // 锁定时只清 items；spaces / activeSpaceId 是 plaintext，保留下来
      // 给锁屏页与"我的"页的空间头像使用
      setAllItems([]);
    }
  }, [locked, refresh]);

  // 把最新 allItems 同步到 ref —— 让 runBreachScan 无需把 allItems 放进
  // useCallback deps（条目每变一次回调引用就重建，会污染消费者 useEffect deps）
  useEffect(() => {
    allItemsRef.current = allItems;
  }, [allItems]);

  // 当前空间下的 items（按 spaceId 过滤；缺省 spaceId 视为默认空间）
  const items = useMemo(() => {
    if (!activeSpaceId) return [];
    return allItems.filter((it) => {
      const sid = it.spaceId ?? DEFAULT_SPACE_ID;
      return sid === activeSpaceId;
    });
  }, [allItems, activeSpaceId]);

  // 当前激活空间对象（便捷 selector）—— 头像 / 标题展示用
  const activeSpace = useMemo<Space | null>(() => {
    if (!activeSpaceId) return null;
    return spaces.find((s) => s.id === activeSpaceId) ?? null;
  }, [spaces, activeSpaceId]);

  /* ---------------------------- CRUD ---------------------------- */

  // getItem 走 allItems（详情页要能在跨空间深链时也能查到）
  const getItem = useCallback(
    (id: string) => allItems.find((i) => i.id === id),
    [allItems],
  );

  const addItem = useCallback(
    async (draft: ItemDraft): Promise<VaultItem | null> => {
      const { type, name, fields } = fromDraft(draft);
      try {
        const created = await vaultService.createItem(type, name, fields);
        const item = toVaultItem(created);
        setAllItems((prev) => [item, ...prev]);
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
      const cur = allItems.find((i) => i.id === id);
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
        setAllItems((prev) => prev.map((i) => (i.id === id ? next : i)));
      } catch (e) {
        console.warn("updateItem failed", e);
      }
    },
    [allItems],
  );

  const deleteItem = useCallback(async (id: string): Promise<void> => {
    try {
      await vaultService.deleteItem(id);
      setAllItems((prev) => prev.filter((i) => i.id !== id));
      // 删除条目时把对应 breach 结果一并移除，避免列表里出现幽灵条目
      setBreachResults((prev) =>
        prev ? prev.filter((r) => r.itemId !== id) : prev,
      );
    } catch (e) {
      console.warn("deleteItem failed", e);
    }
  }, []);

  const toggleFavorite = useCallback(
    async (id: string): Promise<void> => {
      const cur = allItems.find((i) => i.id === id);
      if (!cur) return;
      await updateItem(id, { favorite: !cur.favorite } as ItemPatch);
    },
    [allItems, updateItem],
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
      setAllItems([]);
    } catch (e) {
      console.warn("clearAll failed", e);
    }
  }, []);

  const reset = useCallback(async (): Promise<void> => {
    await vaultService.reset();
    setAllItems([]);
    setSpaces([]);
    setActiveSpaceIdState(null);
    setLocked(true);
    setInitialized(false);
    // reset 已经在 service 层删了 SecureStore WrapKey 与 trustedDevice 行
    setTrustedDeviceEnabled(false);
    breachGenerationRef.current += 1;
    clearBreachCache();
    setBreachResults(null);
    setBreachLastScanAt(null);
    setBreachScanning(false);
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
    setAllItems([]);
    // 锁定即清空 breach 状态：保留扫描结果会让锁屏后仍能看到条目名，违反
    // "锁定即清空内存视图" 约定。下次解锁需要手动重新扫描。
    // 递增 generation：进行中的扫描完成时会发现 token 不一致，自动丢弃结果，
    // 避免锁屏后扫描完成把含明文条目名的 results 又写回 state。
    breachGenerationRef.current += 1;
    clearBreachCache();
    setBreachResults(null);
    setBreachLastScanAt(null);
    setBreachScanning(false);
    // 不清 spaces / activeSpaceId：plaintext 数据，锁屏页头像要用
  }, []);

  /* ---------------------- 空间操作 ---------------------- */

  const setActiveSpace = useCallback(
    async (id: string): Promise<void> => {
      try {
        await vaultService.setActiveSpace(id);
        setActiveSpaceIdState(id);
      } catch (e) {
        console.warn("setActiveSpace failed", e);
      }
    },
    [],
  );

  const createSpace = useCallback(
    async (name: string): Promise<Space | null> => {
      try {
        const sp = await vaultService.createSpace(name);
        setSpaces((prev) => [...prev, sp]);
        return sp;
      } catch (e) {
        console.warn("createSpace failed", e);
        return null;
      }
    },
    [],
  );

  const renameSpace = useCallback(
    async (id: string, name: string): Promise<ActionResult> => {
      try {
        await vaultService.renameSpace(id, name);
        setSpaces((prev) =>
          prev.map((s) => (s.id === id ? { ...s, name: name.trim() } : s)),
        );
        return { ok: true };
      } catch (e) {
        return toActionError(e);
      }
    },
    [],
  );

  const deleteSpace = useCallback(
    async (id: string): Promise<ActionResult> => {
      try {
        await vaultService.deleteSpace(id);
        // 删除后会把 item.spaceId 改写为 fallback —— refresh 拉取最新快照
        await refresh();
        return { ok: true };
      } catch (e) {
        return toActionError(e);
      }
    },
    [refresh],
  );

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

  /* ---------------------- 信任设备 ---------------------- */

  const enableTrustedDevice = useCallback(
    async (confirmPassword: string): Promise<ActionResult> => {
      try {
        await vaultService.enableTrustedDevice(confirmPassword);
        setTrustedDeviceEnabled(true);
        return { ok: true };
      } catch (e) {
        return toActionError(e);
      }
    },
    [],
  );

  const disableTrustedDevice = useCallback(async (): Promise<ActionResult> => {
    try {
      await vaultService.disableTrustedDevice();
      setTrustedDeviceEnabled(false);
      return { ok: true };
    } catch (e) {
      return toActionError(e);
    }
  }, []);

  // 防重入：LockOverlay 的 mount-effect + 用户点按钮可能并发触发
  const trustedTryInflightRef = useRef(false);

  const tryUnlockWithTrustedDevice = useCallback(async (): Promise<boolean> => {
    if (trustedTryInflightRef.current) return false;
    trustedTryInflightRef.current = true;
    setTrustedDeviceTrying(true);
    try {
      const ok = await vaultService.tryUnlockWithTrustedDevice();
      if (ok) {
        setLocked(false);
      } else {
        // service 内部失败时已清行 —— 同步前端状态，避免锁屏页继续显示按钮
        setTrustedDeviceEnabled(false);
      }
      return ok;
    } catch {
      return false;
    } finally {
      setTrustedDeviceTrying(false);
      trustedTryInflightRef.current = false;
    }
  }, []);

  /* ---------------------- HIBP 泄露扫描 ---------------------- */

  // 用 ref 防重入：同时多次点扫描按钮时只有第一次会真正发请求
  const breachScanInflightRef = useRef(false);

  const runBreachScan = useCallback(
    async (force = false): Promise<void> => {
      if (breachScanInflightRef.current) return;
      // 捕获本次扫描的代际 token，扫描完成时对比；中途 lock/reset 会让 token 失配
      const myGeneration = breachGenerationRef.current;
      // 通过 ref 读最新条目快照 —— useCallback deps 因此可以为空
      // （否则每次条目变化都会重建 runBreachScan 引用）
      // 跨空间扫描整个 vault 的 login 条目，与 desktop 行为一致
      const loginsToScan = allItemsRef.current
        .filter((i): i is Extract<VaultItem, { type: "login" }> => i.type === "login")
        .map((i) => ({ id: i.id, name: i.name, password: i.password }));

      breachScanInflightRef.current = true;
      setBreachScanning(true);
      try {
        const results = await batchCheckBreaches(loginsToScan, { force });
        // 代际不一致 = 扫描期间用户锁屏/重置，丢弃结果（含明文条目名）
        if (breachGenerationRef.current !== myGeneration) return;
        setBreachResults(results);
        setBreachLastScanAt(Date.now());
      } catch (e) {
        console.warn("runBreachScan failed", e);
      } finally {
        // 同样校验代际：lock 已经把 breachScanning 置 false，这里别再覆盖
        if (breachGenerationRef.current === myGeneration) {
          setBreachScanning(false);
        }
        breachScanInflightRef.current = false;
      }
    },
    [],
  );

  const value = useMemo<VaultContextValue>(
    () => ({
      items,
      allItems,
      locked,
      initialized,
      hydrated,
      spaces,
      activeSpaceId,
      activeSpace,
      setActiveSpace,
      createSpace,
      renameSpace,
      deleteSpace,
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
      trustedDeviceSupported,
      trustedDeviceEnabled,
      trustedDeviceTrying,
      enableTrustedDevice,
      disableTrustedDevice,
      tryUnlockWithTrustedDevice,
      breachResults,
      breachScanning,
      breachLastScanAt,
      runBreachScan,
    }),
    [
      items,
      allItems,
      locked,
      initialized,
      hydrated,
      spaces,
      activeSpaceId,
      activeSpace,
      setActiveSpace,
      createSpace,
      renameSpace,
      deleteSpace,
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
      trustedDeviceSupported,
      trustedDeviceEnabled,
      trustedDeviceTrying,
      enableTrustedDevice,
      disableTrustedDevice,
      tryUnlockWithTrustedDevice,
      breachResults,
      breachScanning,
      breachLastScanAt,
      runBreachScan,
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
  if (typeof f.spaceId === "string" && f.spaceId) base.spaceId = f.spaceId;
  const cf = parseCustomFields(f as Record<string, unknown>);
  if (cf.length > 0) base.customFields = cf;

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
  customFields?: CustomField[];
  spaceId?: string;
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
    // 自定义字段单独序列化到保留键，避免被原生字段路径覆盖
    if (k === "customFields") continue;
    // 独立 totp 条目把 secret 持久化到 fields["totp"] —— 与 desktop
    // ItemTypeTOTP 字段约定一致（fields["totp"] 同时覆盖 login.totp 与
    // 独立 totp 两类来源），保证两端 JSON 导出可直接互导。
    if (type === "totp" && k === "secret") {
      fields["totp"] = v;
      continue;
    }
    fields[k] = v;
  }
  const cf = (draft as { customFields?: CustomField[] }).customFields;
  if (Array.isArray(cf) && cf.length > 0) {
    const arr = serializeCustomFields(cf);
    if (arr.length > 0) fields[CUSTOM_FIELDS_KEY] = arr;
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
