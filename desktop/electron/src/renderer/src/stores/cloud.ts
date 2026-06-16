// 云同步状态 store —— 非敏感运行时状态 + 持久化的设备标识
//
// 持久化范围（zpass.cloud.json）：仅 deviceId（非敏感）。
// server 地址不再持久化也不再由用户输入 —— 启动时由 lib/cloud-env.ts 解析
// （默认正式环境，zpass.env.json 可手动切测试环境）。
// session token 走 OS 钥匙串（后端 secretstore），账户身份走 zpass.account；
// 本 store 不持久化任何敏感物。
//
// 运行时状态（不持久化）：后端 CloudStatus 快照、最近一次同步进度、待解决
// 冲突数 —— 由 cloud:* SSE 事件与显式 refresh() 更新。

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  type CloudRealtimeState,
  type CloudStatus,
  configureCloud,
  getCloudStatus,
} from "@/lib/cloud-api";
import { resolveCloudBaseUrl } from "@/lib/cloud-env";
import { createWailsConfigStorage } from "@/lib/config-storage";

/** 空间自动镜像(1Password 模型)的运行时状态。 */
export interface CloudMirrorState {
  /** reconcile 正在运行。 */
  running: boolean;
  /** 自动上云被套餐限额(max_vaults)挡住 —— 多余空间保持本地,UI 提示。 */
  limitBlocked: boolean;
  /**
   * 降级冻结的本地空间 id:套餐被调低后超出活跃配额的已同步空间。
   * 服务端保留数据、放行读取,本地照常可编辑,只是推送被挡(改动积压,
   * 解冻后自动补推)。用户可在设置页换选活跃空间。
   */
  frozenSpaceIds: string[];
  /** 套餐空间数上限(null/undefined = 不限或未知,来自 /v1/entitlements)。 */
  spaceLimit?: number | null;
  /** 当前云端空间用量(来自 /v1/entitlements)。 */
  spaceUsed?: number;
  /** 最近一次 reconcile 的错误原文(英文,展示点再翻译)。 */
  error?: string;
}

export interface CloudSyncProgress {
  stage: "idle" | "pushing" | "pulling" | "conflict" | "done" | "error";
  processed: number;
  total: number;
  error?: string;
  updatedAt: number;
}

interface CloudState {
  /** 云端 server origin（运行时，init 时由 cloud-env 解析填入；仅供展示）。 */
  baseUrl: string;
  /** 设备稳定标识（持久化，生成后固定）。 */
  deviceId: string;

  /** 后端状态快照（运行时）。 */
  status: CloudStatus | null;
  /** 最近一次同步进度（运行时）。 */
  progress: CloudSyncProgress;
  /** 待解决冲突数（运行时）。 */
  conflictCount: number;
  /** 实时通道状态（运行时），由 cloud:realtime:state 事件与 refresh() 更新；不持久化。 */
  realtime: CloudRealtimeState;
  /**
   * 会话被远端吊销标记（运行时，不持久化）。由 cloud:auth:revoked 置位——
   * 管理员在 SaaS 侧“退出全部设备”或修改主密码会吊销本设备 session，后端据此
   * 主动登出并置此标记，UI 展示“已被远端登出，请重新登录”，而非静默同步失败。
   * 下一次成功登录（applyAuthChanged 见到 signedIn）时清除。
   */
  revoked: boolean;

  /** 空间自动镜像运行时状态(不持久化)。 */
  mirror: CloudMirrorState;
  /**
   * 云端 vault 删除失败(非 owner / 服务端拒绝删最后一个)后被本地忽略的
   * vaultId(持久化)。reconcile 不会把它们再镜像回本地,避免"删了又复活"。
   */
  ignoredVaultIds: string[];
  /**
   * 与云端"分离"的本地空间 id(持久化)。云端 vault 被其他设备删除时,
   * 本地空间与数据保留但标记 detached —— reconcile 不会自动把它重新上传,
   * 重新启用同步必须用户显式操作(防止删除在设备间来回复活)。
   */
  detachedSpaceIds: string[];
  /**
   * 每账户的 vault 删除墓碑游标(持久化,按 accountId 区分)。值 = 已处理到的最大
   * deletion_seq;reconcile 据此增量拉 GET /v1/vaults/deleted。
   * 必须按账户区分 —— 服务端 deletion_seq 是跨租户全局序列,共用游标会漏处理
   * 另一账户 seq 较小的墓碑。
   */
  tombstoneCursors: Record<string, number>;
  /**
   * 待重试删除的云端 vaultId(持久化)。删除空间时若 deleteRemoteVault 失败
   * (离线/瞬时错误),记入此处,reconcile 持续幂等重试直至成功 —— 取代旧的
   * "失败即 ignoredVaultIds 永久忽略",确保删除必达服务端、墓碑能传到其他设备。
   */
  pendingRemoteDeletes: string[];

  /** 用解析出的环境地址初始化后端并拉取状态（应用启动时调用）。 */
  init: () => Promise<void>;
  /** 重新拉取后端状态。 */
  refresh: () => Promise<void>;
  /** 应用 cloud:sync:progress 事件载荷。 */
  applyProgress: (p: Partial<CloudSyncProgress>) => void;
  /** 应用 cloud:auth:changed 事件（触发状态刷新）。 */
  applyAuthChanged: () => void;
  /** 设置待解决冲突数。 */
  setConflictCount: (n: number) => void;
  /** 设置实时通道状态。 */
  setRealtime: (s: CloudRealtimeState) => void;
  /** 设置“会话被远端吊销”标记（cloud:auth:revoked 事件）。 */
  setRevoked: (v: boolean) => void;
  /** 合并更新自动镜像状态。 */
  setMirror: (p: Partial<CloudMirrorState>) => void;
  /** 记录一个删除失败而被忽略的云端 vault。 */
  addIgnoredVault: (vaultId: string) => void;
  /** 移除忽略标记(用户手动重新绑定时)。 */
  removeIgnoredVault: (vaultId: string) => void;
  /** 标记/取消本地空间与云端分离。 */
  setSpaceDetached: (spaceId: string, detached: boolean) => void;
  /** 推进某账户的删除墓碑游标(只增不减)。 */
  setTombstoneCursor: (accountId: string, seq: number) => void;
  /** 记录一个待重试删除的云端 vault。 */
  addPendingRemoteDelete: (vaultId: string) => void;
  /** 移除待删记录(删除成功 / 已不存在 / 非本人 owner)。 */
  clearPendingRemoteDelete: (vaultId: string) => void;
}

function genDeviceId(): string {
  // 16 字节随机 → d_<hex>；仅作非敏感设备标识，不参与密码学。
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `d_${hex}`;
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
      realtime: "offline",
      revoked: false,
      mirror: { running: false, limitBlocked: false, frozenSpaceIds: [] },
      ignoredVaultIds: [],
      detachedSpaceIds: [],
      tombstoneCursors: {},
      pendingRemoteDeletes: [],

      init: async () => {
        // 首次运行补一个设备 id。
        if (!get().deviceId) set({ deviceId: genDeviceId() });
        const url = await resolveCloudBaseUrl();
        set({ baseUrl: url });
        try {
          await configureCloud(url);
        } catch {
          // 配置失败不阻塞启动；状态刷新会反映 configured=false。
        }
        await get().refresh();
      },

      refresh: async () => {
        const wasSignedIn = get().status?.signedIn ?? false;
        try {
          const status = await getCloudStatus();
          set({
            status,
            realtime: (status.realtime as CloudRealtimeState) ?? "offline",
          });
          // 登录态从无到有(启动恢复会话 / 登录页登录)→ 触发一次空间自动
          // 镜像。动态 import 打断 cloud-mirror ↔ cloud 的模块环。
          if (!wasSignedIn && status.signedIn) {
            void import("@/stores/cloud-mirror").then((m) => m.reconcileCloudSpaces());
          }
        } catch {
          set({ status: null, realtime: "offline" });
        }
      },

      applyProgress: (p) =>
        set((s) => ({
          progress: {
            ...s.progress,
            ...p,
            updatedAt: p.updatedAt ?? Date.now(),
          } as CloudSyncProgress,
        })),

      applyAuthChanged: () => {
        void get()
          .refresh()
          .then(() => {
            // 一旦重新登录成功，清除远端吊销标记。
            if (get().status?.signedIn) set({ revoked: false });
          });
      },

      setConflictCount: (n) => set({ conflictCount: n }),

      setRealtime: (r) => set({ realtime: r }),

      setRevoked: (v) => set({ revoked: v }),

      setMirror: (p) => set((s) => ({ mirror: { ...s.mirror, ...p } })),

      addIgnoredVault: (vaultId) =>
        set((s) =>
          s.ignoredVaultIds.includes(vaultId)
            ? s
            : { ignoredVaultIds: [...s.ignoredVaultIds, vaultId] },
        ),

      removeIgnoredVault: (vaultId) =>
        set((s) => ({
          ignoredVaultIds: s.ignoredVaultIds.filter((v) => v !== vaultId),
        })),

      setSpaceDetached: (spaceId, detached) =>
        set((s) => ({
          detachedSpaceIds: detached
            ? s.detachedSpaceIds.includes(spaceId)
              ? s.detachedSpaceIds
              : [...s.detachedSpaceIds, spaceId]
            : s.detachedSpaceIds.filter((v) => v !== spaceId),
        })),

      setTombstoneCursor: (accountId, seq) =>
        set((s) => ({
          tombstoneCursors: {
            ...s.tombstoneCursors,
            // 只增不减:并发 reconcile 或乱序回包不应回退游标。
            [accountId]: Math.max(seq, s.tombstoneCursors[accountId] ?? 0),
          },
        })),

      addPendingRemoteDelete: (vaultId) =>
        set((s) =>
          s.pendingRemoteDeletes.includes(vaultId)
            ? s
            : { pendingRemoteDeletes: [...s.pendingRemoteDeletes, vaultId] },
        ),

      clearPendingRemoteDelete: (vaultId) =>
        set((s) => ({
          pendingRemoteDeletes: s.pendingRemoteDeletes.filter((v) => v !== vaultId),
        })),
    }),
    {
      name: "zpass.cloud",
      version: 1,
      storage: createWailsConfigStorage<Partial<CloudState>>(),
      // 只持久化设备标识；server 地址由 cloud-env 解析，运行时状态不落盘。
      // 旧版文件里残留的 baseUrl 字段会被忽略（init 时以解析值覆盖）。
      partialize: (state) => ({
        deviceId: state.deviceId,
        ignoredVaultIds: state.ignoredVaultIds,
        detachedSpaceIds: state.detachedSpaceIds,
        tombstoneCursors: state.tombstoneCursors,
        pendingRemoteDeletes: state.pendingRemoteDeletes,
      }),
      // 持久化是异步的（配置文件读写）；rehydrate 完成后把解析出的环境地址
      // 下发给 Go 后端并拉取状态 —— 避免刚启动时误显示“未配置”。
      onRehydrateStorage: () => () => {
        void resolveCloudBaseUrl().then((url) => {
          useCloudStore.setState({ baseUrl: url });
          return configureCloud(url)
            .then(() => useCloudStore.getState().refresh())
            .catch(() => {
              /* 配置失败不阻塞；状态刷新会反映 configured=false */
            });
        });
      },
    },
  ),
);

/** 是否已登录云账户（派生自 status）。 */
export function useCloudSignedIn(): boolean {
  return useCloudStore((s) => s.status?.signedIn ?? false);
}
