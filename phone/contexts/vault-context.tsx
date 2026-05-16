// 保险库状态中心 —— phone 端的单一数据源。
//
// 对齐 desktop 的 stores/vault.ts：持有条目列表 + 泄露情报 + 锁定状态，
// 提供增删改查 / 收藏 / 锁定等动作。条目通过 AsyncStorage 本地持久化，
// 在接入真实加密后端前作为可用的离线存储。

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  SEED_ACTIVITY,
  SEED_BREACHES,
  SEED_ITEMS,
  type ActivityEntry,
  type Breach,
  type VaultItem,
} from "@/data/vault";

const STORAGE_KEY = "zpass.vault.items.v1";

/** 分配律 Omit —— 在联合类型每个成员上分别 Omit，避免退化为公共字段 */
type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

/** 新建条目时的草稿：不含 id / modified（由 store 补全） */
export type ItemDraft = DistributiveOmit<VaultItem, "id" | "modified">;

/** 更新补丁：联合各成员的 Partial */
export type ItemPatch = DistributiveOmit<Partial<VaultItem>, never>;

interface VaultContextValue {
  items: VaultItem[];
  breaches: Breach[];
  activity: ActivityEntry[];
  locked: boolean;
  /** 数据是否已从持久化存储完成首次加载 */
  hydrated: boolean;

  getItem: (id: string) => VaultItem | undefined;
  addItem: (draft: ItemDraft) => VaultItem;
  updateItem: (id: string, patch: ItemPatch) => void;
  deleteItem: (id: string) => void;
  toggleFavorite: (id: string) => void;

  lock: () => void;
  unlock: () => void;
}

const VaultContext = createContext<VaultContextValue | null>(null);

function genId(): string {
  return "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<VaultItem[]>(SEED_ITEMS);
  const [breaches] = useState<Breach[]>(SEED_BREACHES);
  const [activity] = useState<ActivityEntry[]>(SEED_ACTIVITY);
  const [locked, setLocked] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // 首次挂载：从持久化存储恢复条目
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (alive && raw) {
          const parsed = JSON.parse(raw) as VaultItem[];
          if (Array.isArray(parsed) && parsed.length > 0) setItems(parsed);
        }
      } catch {
        // 解析失败时保留种子数据
      } finally {
        if (alive) setHydrated(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 条目变化后写回持久化存储（首次加载完成前不写，避免覆盖）
  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items)).catch(() => {});
  }, [items, hydrated]);

  const getItem = useCallback(
    (id: string) => items.find((i) => i.id === id),
    [items],
  );

  const addItem = useCallback((draft: ItemDraft) => {
    const created = {
      ...draft,
      id: genId(),
      modified: Date.now(),
    } as VaultItem;
    setItems((prev) => [created, ...prev]);
    return created;
  }, []);

  const updateItem = useCallback((id: string, patch: ItemPatch) => {
    setItems((prev) =>
      prev.map((i) =>
        i.id === id
          ? ({ ...i, ...patch, id: i.id, modified: Date.now() } as VaultItem)
          : i,
      ),
    );
  }, []);

  const deleteItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const toggleFavorite = useCallback((id: string) => {
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, favorite: !i.favorite } : i)),
    );
  }, []);

  const lock = useCallback(() => setLocked(true), []);
  const unlock = useCallback(() => setLocked(false), []);

  const value = useMemo<VaultContextValue>(
    () => ({
      items,
      breaches,
      activity,
      locked,
      hydrated,
      getItem,
      addItem,
      updateItem,
      deleteItem,
      toggleFavorite,
      lock,
      unlock,
    }),
    [
      items,
      breaches,
      activity,
      locked,
      hydrated,
      getItem,
      addItem,
      updateItem,
      deleteItem,
      toggleFavorite,
      lock,
      unlock,
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
