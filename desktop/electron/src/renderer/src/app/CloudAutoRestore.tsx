import { useEffect, useRef } from "react";
import { restoreCloudSession } from "@/lib/cloud-api";
import { useCloudStore } from "@/stores/cloud";
import { useLockStore } from "@/stores/lock";

/**
 * 云会话自动恢复 —— 信任设备免主密码启动时重建云会话
 * ---------------------------------------------------------------------------
 * 背景：零知识约束下账户私钥不落盘，每次启动必须重新派生云会话。
 * UnlockPage 的手动解锁路径会用用户刚输入的主密码调 restoreCloudSession(pw)
 * 重建会话；但「信任此设备」自动解锁（LockSync 阶段 A）走的是 DPAPI/Keychain
 * 还原 DEK，用户**根本不输入主密码**，那条路径此前从不恢复云会话 —— 于是免密
 * 启动后云端永远显示「未登录」。
 *
 * 后端 RestoreSession 本就支持无主密码恢复：本地 vault 解锁后，用 DEK 解开上次
 * 登录时存进钥匙串的 DEK 包裹云密码（pw- 凭据），无需再次输入主密码即可重建会话。
 * 本组件把这条恢复逻辑做成「响应式」触发，规避时序竞态：
 *
 *   - 解锁（LockSync 信任设备 / UnlockPage 手动）与云端 Configure
 *     （CloudEventSync.init → configureCloud，设置 baseURL）是两条独立异步链。
 *     若在 finishUnlock 里直接命令式调用，可能在 Configure 落地前触发，
 *     此时 baseURL 为空 → RestoreSession 静默 no-op，bug 依旧。
 *   - 改用 effect 监听「本地已解锁 + 云端已配置 + 尚未登录 + 有缓存 token」
 *     四个条件，无论两条链谁先到达，条件齐备时恰好触发一次。
 *
 * 与 UnlockPage 已有的 restoreCloudSession(pw) 调用天然幂等：两者都经 RestoreSession
 * 的 sess!=nil 早退守卫（且 opMu 串行化），先到者建立会话，后到者直接早退，
 * 不会重复登录。空密码会回落到 DEK 包裹的 pw- 凭据；无 pw- 凭据的旧登录无法
 * 免密恢复（需手动重新登录一次），属可接受降级。
 *
 * 纯副作用组件，不渲染 DOM。与 LockSync / CloudEventSync 平级挂在 App 顶层。
 */
export function CloudAutoRestore() {
	const locked = useLockStore((s) => s.locked);
	const status = useCloudStore((s) => s.status);

	// 每个「解锁周期」只尝试一次：避免 status 刷新导致的重复触发，也避免
	// 恢复失败时在 effect 里无限重试。重新锁定时复位，让下次解锁可再试。
	const attempted = useRef(false);

	useEffect(() => {
		if (locked) {
			attempted.current = false;
			return;
		}
		if (attempted.current) return;

		// 仅当：本地已解锁 + 云端已配置 + 尚未登录 + 本机有缓存 token
		// （说明此前在该 server 登录过、凭据大概率仍在钥匙串里）。
		if (!status?.configured || status.signedIn || !status.hasCachedToken) return;

		attempted.current = true;
		// 空密码 —— 后端回落到 DEK 包裹的 pw- 凭据完成恢复。fire-and-forget：
		// 无凭据返回 signedIn:false、密码不一致抛错，两种情况都静默，绝不阻塞。
		// 成功后后端会 emit cloud:auth:changed，CloudEventSync 据此刷新状态。
		void restoreCloudSession("")
			.then((res) => {
				if (res.signedIn) void useCloudStore.getState().refresh();
			})
			.catch(() => {
				/* 未存凭据 / 云密码不一致 —— 静默，保持本地可用 */
			});
	}, [locked, status]);

	return null;
}

export default CloudAutoRestore;
