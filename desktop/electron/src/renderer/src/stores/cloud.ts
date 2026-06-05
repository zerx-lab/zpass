// 云同步状态 store —— 非敏感运行时状态 + 持久化的 server 配置
//
// 持久化范围（zpass.cloud.json）：仅 baseUrl + deviceId（非敏感）。
// session token 走 OS 钥匙串（后端 secretstore），账户身份走 zpass.account；
// 本 store 不持久化任何敏感物。
//
// 运行时状态（不持久化）：后端 CloudStatus 快照、最近一次同步进度、待解决
// 冲突数 —— 由 cloud:* SSE 事件与显式 refresh() 更新。

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { type CloudStatus, configureCloud, getCloudStatus } from "@/lib/cloud-api";
import { createWailsConfigStorage } from "@/lib/config-storage";

export interface CloudSyncProgress {
  stage: "idle" | "pushing" | "pulling" | "conflict" | "done" | "error";
  processed: number;
  total: number;
  error?: string;
  updatedAt: number;
}

interface CloudState {
  /** 云端 server origin（持久化）。空串 = 未配置。 */
  baseUrl: string;
  /** 设备稳定标识（持久化，生成后固定）。 */
  deviceId: string;

  /** 后端状态快照（运行时）。 */
  status: CloudStatus | null;
  /** 最近一次同步进度（运行时）。 */
  progress: CloudSyncProgress;
  /** 待解决冲突数（运行时）。 */
  conflictCount: number;

  /** 设置并应用 server origin（持久化 + 通知后端 Configure + 刷新状态）。 */
  setBaseUrl: (baseUrl: string) => Promise<void>;
  /** 用配置的 baseUrl 初始化后端并拉取状态（应用启动时调用）。 */
  init: () => Promise<void>;
  /** 重新拉取后端状态。 */
  refresh: () => Promise<void>;
  /** 应用 cloud:sync:progress 事件载荷。 */
  applyProgress: (p: Partial<CloudSyncProgress>) => void;
  /** 应用 cloud:auth:changed 事件（触发状态刷新）。 */
  applyAuthChanged: () => void;
  /** 设置待解决冲突数。 */
  setConflictCount: (n: number) => void;
}

function genDeviceId(): string {
  // 16 字节随机 → d_<hex>；仅作非敏感设备标识，不参与密码学。
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `d_${hex}`;
}

/**
 * 云端同步服务默认地址。
 *
 * 现在为空（用户在设置/登录页填写一次后持久化到 zpass.cloud.json）。后续上线
 * 时把这里改成固定的生产地址（例如 "https://sync.zpass.app"），并把
 * CLOUD_BASE_URL_LOCKED 置为 true —— UI 会隐藏地址输入框、强制使用此地址，
 * 用户不可改。改这一处即可，无需动其它代码。
 */
export const DEFAULT_CLOUD_BASE_URL = "";

/** true 时强制使用 DEFAULT_CLOUD_BASE_URL，隐藏并禁用地址输入。 */
export const CLOUD_BASE_URL_LOCKED = false;

/** 解析“当前应使用的地址”：锁定时恒为默认地址，否则用持久化值（空则回落默认）。 */
export function resolveCloudBaseUrl(persisted: string): string {
  if (CLOUD_BASE_URL_LOCKED) return DEFAULT_CLOUD_BASE_URL;
  return (persisted || DEFAULT_CLOUD_BASE_URL).trim().replace(/\/+$/, "");
}

const idleProgress: CloudSyncProgress = {
  stage: "idle",
  processed: 0,
  total: 0,
  updatedAt: 0,
};

export const useCloudStore = create<CloudState>()(
  persist(
    (set, get) => ({
      baseUrl: "",
      deviceId: "",
      status: null,
      progress: idleProgress,
      conflictCount: 0,

      setBaseUrl: async (baseUrl) => {
        const trimmed = baseUrl.trim().replace(/\/+$/, "");
        set({ baseUrl: trimmed });
        if (trimmed) {
          await configureCloud(trimmed);
        }
        await get().refresh();
      },

      init: async () => {
        // 首次运行补一个设备 id。
        if (!get().deviceId) set({ deviceId: genDeviceId() });
        const url = resolveCloudBaseUrl(get().baseUrl);
        if (url) {
          if (url !== get().baseUrl) set({ baseUrl: url });
          try {
            await configureCloud(url);
          } catch {
            // 配置失败不阻塞启动；状态刷新会反映 configured=false。
          }
        }
        await get().refresh();
      },

      refresh: async () => {
        try {
          const status = await getCloudStatus();
          set({ status });
        } catch {
          set({ status: null });
        }
      },

      applyProgress: (p) =>
        set((s) => ({
          progress: { ...s.progress, ...p, updatedAt: p.updatedAt ?? Date.now() } as CloudSyncProgress,
        })),

      applyAuthChanged: () => {
        void get().refresh();
      },

      setConflictCount: (n) => set({ conflictCount: n }),
    }),
    {
      name: "zpass.cloud",
      version: 1,
      storage: createWailsConfigStorage<Partial<CloudState>>(),
      // 只持久化非敏感配置；运行时状态（status/progress/conflictCount）不落盘。
      partialize: (state) => ({ baseUrl: state.baseUrl, deviceId: state.deviceId }),
      // 持久化是异步的（配置文件读写）；rehydrate 完成后再把持久化的地址下发给
      // Go 后端并拉取状态 —— 避免 init() 在 rehydrate 之前读到空地址，导致刚启动
      // 误显示“未配置”。
      onRehydrateStorage: () => (state) => {
        const url = resolveCloudBaseUrl(state?.baseUrl ?? "");
        if (!url) return;
        useCloudStore.setState({ baseUrl: url });
        void configureCloud(url)
          .then(() => useCloudStore.getState().refresh())
          .catch(() => {
            /* 配置失败不阻塞；状态刷新会反映 configured=false */
          });
      },
    },
  ),
);

/** 是否已登录云账户（派生自 status）。 */
export function useCloudSignedIn(): boolean {
  return useCloudStore((s) => s.status?.signedIn ?? false);
}
