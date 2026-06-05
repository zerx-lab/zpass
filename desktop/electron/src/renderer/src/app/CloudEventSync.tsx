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
//   cloud:sync:error     — 同步出错     → applyProgress({ stage: "error", ... })

import { Events } from "@wailsio/runtime";
import { useEffect } from "react";
import { listCloudConflicts } from "@/lib/cloud-api";
import { useCloudStore } from "@/stores/cloud";

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

/** 从 Wails 事件对象中提取 data 载荷（兼容 v2/v3 结构差异） */
function unwrap<T>(event: { data?: T } | T): T {
	return ("data" in (event as object) && (event as { data?: T }).data != null
		? (event as { data?: T }).data
		: event) as T;
}

export function CloudEventSync() {
	useEffect(() => {
		const store = useCloudStore.getState();

		// 启动时初始化：配置 baseUrl + 拉取后端状态
		void store.init();

		// cloud:sync:progress —— 同步进度
		const offProgress = Events.On(
			"cloud:sync:progress",
			(event: { data?: ProgressPayload } | ProgressPayload) => {
				const p = unwrap<ProgressPayload>(event);
				useCloudStore.getState().applyProgress({
					stage: (p.stage as import("@/stores/cloud").CloudSyncProgress["stage"]) ?? "idle",
					processed: p.processed ?? 0,
					total: p.total ?? 0,
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

		// cloud:auth:expired —— session JWT 过期 / 被吊销；刷新状态让 UI 反映
		// 需重新登录（后台同步在此情况下静默停摆，直到用户重新 SignIn）。
		const offExpired = Events.On("cloud:auth:expired", () => {
			useCloudStore.getState().applyProgress({ stage: "error", error: "session expired" });
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

		return () => {
			// 卸载时注销所有订阅（Events.On 返回注销函数）
			if (typeof offProgress === "function") offProgress();
			if (typeof offDone === "function") offDone();
			if (typeof offConflict === "function") offConflict();
			if (typeof offAuth === "function") offAuth();
			if (typeof offExpired === "function") offExpired();
			if (typeof offError === "function") offError();
		};
	}, []);

	return null;
}

export default CloudEventSync;
