// 云同步事件桥 —— 订阅后端 cloud:* 事件，驱动 useCloudStore 状态更新
//
// 与 VaultEventSync 平级挂在 App 顶层（App.tsx），mount-once、无 DOM 输出。
// 订阅模式沿用 VaultEventSync 的 ("data" in event && event.data ? event.data : event)
// unwrap 惯用法，保证 Wails v2 与 v3 事件负载结构兼容。
//
// 事件列表（后端 CloudService 推送）：
//   cloud:sync:progress  — 同步进度更新 → applyProgress
//   cloud:sync:done      — 同步完成     → progress done + refresh + setConflictCount
//   cloud:sync:conflict  — 新增冲突     → 拉取冲突列表 + setConflictCount
//   cloud:auth:changed   — 认证状态变化 → applyAuthChanged（内部 refresh）
//   cloud:auth:revoked   — 会话被远端吊销 → setRevoked + refresh（提示重新登录）
//   cloud:sync:error     — 同步出错     → applyProgress({ stage: "error", ... })
//   cloud:realtime:state — 实时通道状态 → setRealtime
//
// 另订阅两个“半开信号”来源（网络恢复 / 系统挂起恢复），唤醒后端实时通道：
//   window "online"          — 浏览器网络恢复
//   preload onSystemResumed  — powerMonitor resume / unlock-screen

import { Events } from "@wailsio/runtime";
import { useEffect } from "react";
import {
  type CloudRealtimeState,
  listCloudConflicts,
  pokeCloudRealtime,
} from "@/lib/cloud-api";
import { useCloudStore } from "@/stores/cloud";
import { initCloudMirror, reconcileCloudSpaces } from "@/stores/cloud-mirror";

interface ProgressPayload {
  stage?: string;
  processed?: number;
  total?: number;
  error?: string;
}

interface DonePayload {
  conflicts?: number;
}

interface ErrorPayload {
  message?: string;
}

interface RealtimePayload {
  state?: string;
}

/** 从 Wails 事件对象中提取 data 载荷（兼容 v2/v3 结构差异） */
function unwrap<T>(event: { data?: T } | T): T {
  return (
    "data" in (event as object) && (event as { data?: T }).data != null
      ? (event as { data?: T }).data
      : event
  ) as T;
}

export function CloudEventSync() {
  useEffect(() => {
    const store = useCloudStore.getState();

    // 启动时初始化：配置 baseUrl + 拉取后端状态
    void store.init();

    // 空间自动镜像:订阅 spaces store,登录态下新建/重命名/删除空间时同步云端
    initCloudMirror();

    // cloud:sync:progress —— 同步进度
    const offProgress = Events.On(
      "cloud:sync:progress",
      (event: { data?: ProgressPayload } | ProgressPayload) => {
        const p = unwrap<ProgressPayload>(event);
        useCloudStore.getState().applyProgress({
          stage:
            (p.stage as import("@/stores/cloud").CloudSyncProgress["stage"]) ??
            "idle",
          processed: p.processed ?? 0,
          total: p.total ?? 0,
          error: p.error,
        });
      },
    );

    // cloud:sync:done —— 同步完成；从 payload 中读取 conflict 数量
    const offDone = Events.On(
      "cloud:sync:done",
      (event: { data?: DonePayload } | DonePayload) => {
        const p = unwrap<DonePayload>(event);
        useCloudStore.getState().applyProgress({ stage: "done" });
        useCloudStore.getState().setConflictCount(p.conflicts ?? 0);
        void useCloudStore.getState().refresh();
      },
    );

    // cloud:sync:conflict —— 服务端检测到新冲突；拉取完整列表以刷新计数
    const offConflict = Events.On("cloud:sync:conflict", () => {
      void listCloudConflicts()
        .then((list) => {
          useCloudStore.getState().setConflictCount(list.length);
        })
        .catch(() => {
          // 拉取失败不崩溃；保持上次计数，等下次刷新
        });
      void useCloudStore.getState().refresh();
    });

    // cloud:auth:changed —— 登录 / 登出事件；触发状态刷新
    const offAuth = Events.On("cloud:auth:changed", () => {
      useCloudStore.getState().applyAuthChanged();
    });

    // cloud:auth:revoked —— 会话被远端吊销（SaaS 侧“退出全部设备” /
    // 修改主密码）。后端已主动登出并发 cloud:auth:changed(signedIn=false)；
    // 这里置位 revoked 标记，让 UI 明确提示“已被远端登出，请重新登录”。
    const offRevoked = Events.On("cloud:auth:revoked", () => {
      useCloudStore.getState().setRevoked(true);
      useCloudStore.getState().applyProgress({ stage: "idle" });
      void useCloudStore.getState().refresh();
    });

    // cloud:auth:expired —— 旧事件名（后端已改发 cloud:auth:revoked）；保留订阅
    // 作向后兼容，语义等同 revoked。
    const offExpired = Events.On("cloud:auth:expired", () => {
      useCloudStore.getState().setRevoked(true);
      void useCloudStore.getState().refresh();
    });

    // cloud:sync:error —— 同步出错
    const offError = Events.On(
      "cloud:sync:error",
      (event: { data?: ErrorPayload } | ErrorPayload) => {
        const p = unwrap<ErrorPayload>(event);
        useCloudStore.getState().applyProgress({
          stage: "error",
          error: p.message ?? "unknown error",
        });
      },
    );

    // cloud:realtime:state —— SSE 实时通道连接状态
    const offRealtime = Events.On(
      "cloud:realtime:state",
      (event: { data?: RealtimePayload } | RealtimePayload) => {
        const p = unwrap<RealtimePayload>(event);
        useCloudStore
          .getState()
          .setRealtime((p.state as CloudRealtimeState) ?? "offline");
      },
    );

    // 网络恢复 / 系统挂起恢复 —— SSE 长连接大概率已半开，poke 后端
    // 杀掉旧流立即重连并触发一次补偿同步。两个来源可能几乎同时触发
    // （解锁后网络栈紧跟着上线），用时间戳做 ~2s 节流避免重复 IPC。
    let lastPokeAt = 0;
    const pokeRealtime = () => {
      const now = Date.now();
      if (now - lastPokeAt < 2000) return;
      lastPokeAt = now;
      // 幂等且廉价；失败静默（后端自身的重连退避兜底）
      void pokeCloudRealtime().catch(() => {});
    };

    // window online —— 浏览器网络状态恢复
    window.addEventListener("online", pokeRealtime);

    // 窗口聚焦 —— 顺手对账一次空间镜像(限 60s 一次)。web 端新建的 vault
    // 不在实时通道覆盖范围内(SSE 只订阅已绑定 vault),靠"用户切回窗口"
    // 这个天然时机发现并自动镜像,而不是等用户进设置页。
    let lastReconcileAt = 0;
    const reconcileOnFocus = () => {
      if (!useCloudStore.getState().status?.signedIn) return;
      const now = Date.now();
      if (now - lastReconcileAt < 60_000) return;
      lastReconcileAt = now;
      void reconcileCloudSpaces();
    };
    window.addEventListener("focus", reconcileOnFocus);

    // preload 桥 —— powerMonitor resume / unlock-screen；preload 未就绪
    // 时（dev 热重启窗口期）window.desktop 可能短暂为空，可选链降级跳过
    const offSystemResumed =
      window.desktop?.app?.onSystemResumed?.(pokeRealtime);

    return () => {
      // 卸载时注销所有订阅（Events.On 返回注销函数）
      if (typeof offProgress === "function") offProgress();
      if (typeof offDone === "function") offDone();
      if (typeof offConflict === "function") offConflict();
      if (typeof offAuth === "function") offAuth();
      if (typeof offRevoked === "function") offRevoked();
      if (typeof offExpired === "function") offExpired();
      if (typeof offError === "function") offError();
      if (typeof offRealtime === "function") offRealtime();
      window.removeEventListener("online", pokeRealtime);
      window.removeEventListener("focus", reconcileOnFocus);
      offSystemResumed?.();
    };
  }, []);

  return null;
}

export default CloudEventSync;
