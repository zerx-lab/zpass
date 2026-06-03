import { useEffect, useRef } from "react";
import { vaultApi } from "@/lib/vault-api";
import { useLockStore } from "@/stores/lock";
import { useSpacesStore } from "@/stores/spaces";
import { useVaultStore } from "@/stores/vault";

/**
 * 空间隔离同步组件
 * ---------------------------------------------------------------------------
 * 职责：把前端「当前激活空间」(useSpacesStore.activeSpaceId) 与后端会话态
 * (VaultService.currentSpaceID) 保持一致，并在切换空间 / 解锁时重载 vault 列表。
 *
 * 空间隔离（方案 B）的前端枢纽 —— 后端所有面向用户的读写（列表/CRUD/passkey/
 * TOTP/导出/SSH agent/autofill）都作用于 currentSpaceID，必须由前端推送。
 *
 * ---------------------------------------------------------------------------
 * 为什么订阅 (activeSpaceId, locked) 两个信号、且设计成「自纠正」：
 *
 * 1. spaces store 走 Tauri 配置文件**异步** hydrate —— 挂载瞬间 activeSpaceId
 *    可能还是 ""，hydrate 完成后才变成真实 id。订阅 activeSpaceId 让本组件
 *    在 hydrate 落定时自然触发一次，无需手动等 onFinishHydration。
 *
 * 2. 解锁是另一条独立时间线（LockSync 信任设备自动解锁 / UnlockPage 输密码）。
 *    claimOrphanItems 与列表加载都需要已解锁，故同时订阅 locked：locked 由
 *    true→false 时再触发一次 claim + reload。
 *
 * 3. 自纠正 + epoch 守卫：LockSync/UnlockPage 解锁收尾仍会各自调一次
 *    useVaultStore.load()，可能在 currentSpaceID 尚未推送时返回空列表。本组件
 *    随后 setActiveSpace + reloadForSpace 重新加载；vault store 的 spaceEpoch
 *    守卫保证「飞行中的旧 load」结果被丢弃，不会盖回新空间的数据。因此无需
 *    侵入式改造 LockSync/UnlockPage 的加载时序。
 *
 * ---------------------------------------------------------------------------
 * 历史数据认领（产品决策 Q1：历史数据 → 当前激活空间）：
 *   v5 之前的条目在后端迁移后 space_id='' (orphan)。首次解锁后调一次
 *   claimOrphanItems(activeSpaceId) 把它们归到当前空间，并置 hasClaimedLegacyItems
 *   防重复。幂等：新用户无 orphan，认领返回 0。
 *
 * 纯副作用组件，不渲染 DOM。与 LockSync / VaultEventSync 平级挂在 App 顶层。
 */
export function SpaceSync() {
	const activeSpaceId = useSpacesStore((s) => s.activeSpaceId);
	const locked = useLockStore((s) => s.locked);
	// 记录上一次已同步的 (空间|锁定态)，避免无变化时重复推送 / 重载
	const syncedKeyRef = useRef<string>("");

	useEffect(() => {
		// 未 onboarding（无空间）/ spaces store 尚未 hydrate → 等下一次触发
		if (!activeSpaceId) return;

		const key = `${activeSpaceId}|${locked ? "L" : "U"}`;
		if (syncedKeyRef.current === key) return;
		syncedKeyRef.current = key;

		let cancelled = false;
		void (async () => {
			// 1. 始终把当前空间推给后端 —— SetActiveSpace 不要求已解锁，且后端
			//    currentSpaceID 跨锁定保留，提前推送可让后续任何 load 拿到正确空间。
			try {
				await vaultApi.setActiveSpace(activeSpaceId);
			} catch (err) {
				console.error("[SpaceSync] setActiveSpace failed:", err);
			}
			if (cancelled || locked) return;

			// 2. 已解锁：首次认领历史 orphan 到当前空间（幂等 + 标记防重复）
			const spaces = useSpacesStore.getState();
			if (!spaces.hasClaimedLegacyItems) {
				try {
					await vaultApi.claimOrphanItems(activeSpaceId);
					spaces.markLegacyClaimed();
				} catch (err) {
					console.error("[SpaceSync] claimOrphanItems failed:", err);
				}
				if (cancelled) return;
			}

			// 3. 重载当前空间的列表视图（清缓存 + epoch 守卫防竞态）
			try {
				await useVaultStore.getState().reloadForSpace();
			} catch (err) {
				console.error("[SpaceSync] reloadForSpace failed:", err);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [activeSpaceId, locked]);

	// 纯副作用组件，不渲染任何 DOM
	return null;
}

export default SpaceSync;
