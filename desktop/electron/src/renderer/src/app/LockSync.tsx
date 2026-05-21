import { useEffect } from "react";
import { useLockStore } from "@/stores/lock";
import { useVaultStore } from "@/stores/vault";
import { vaultApi } from "@/lib/vault-api";

/**
 * 锁定状态启动同步组件
 * ---------------------------------------------------------------------------
 * 职责：在应用挂载（含 webview 刷新）时，向后端查询 vault 的真实状态，
 * 如果后端仍持有 DEK（即 `s.dek != nil` → `Status().Unlocked === true`），
 * 立即把前端 `useLockStore.locked` 翻成 `false` 并预加载条目列表，
 * 让用户跳过解锁页直接回到主界面。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这个组件：
 *
 * `useLockStore` 默认初始值为 `locked: true` 且**不持久化**（见
 * src/stores/lock.ts 头部注释）—— 这是为了防止攻击者篡改 localStorage
 * 把"已解锁"标志写死从而绕过主密码验证。代价是：
 *
 *   - Wails dev 刷新 webview / 关闭再开窗口（Go 进程不重启） →
 *     后端 `s.dek` 仍然在内存里，但前端 store 重置为 `locked: true`，
 *     LockGuard 把用户重定向到 /unlock 让其再输一次主密码 —— 这就是
 *     用户反馈的"设置永不锁定但刷新仍要输密码"现象。
 *
 *   - 真正需要锁定的场景（lockTimeout 触发 / 用户主动锁定 / 进程
 *     重启抹零 DEK）后端 `s.dek` 会真的为 nil，`Status().Unlocked`
 *     也会返回 `false`，本组件不会误同步成解锁态。
 *
 * 安全承诺不变：
 *   - 真源仍是后端 Go 进程内存中的 `s.dek`，前端只是「读」一次
 *   - 攻击者改不了后端进程内存，也无法伪造 IPC 响应（Wails runtime
 *     是同进程直连，不经过网络）
 *   - 整个 app 重启 → Go 进程重启 → `s.dek` 自动丢失 →
 *     `Status().Unlocked === false` → 用户仍需输主密码
 *
 * ---------------------------------------------------------------------------
 * 为什么挂在 App.tsx 顶层（与 ThemeSync / Shortcuts 平级）而不是塞进
 * UnlockPage 的 status 探测分支：
 *
 *   1. UnlockPage 只在路由命中 /unlock 时挂载，而 LockGuard 重定向
 *      会先经过一次 <Navigate to="/unlock" />，UI 上能看到一闪解锁屏。
 *      在 App 顶层做同步可以让 LockGuard 在首次渲染前就拿到正确的
 *      `locked` 值，**完全不出现解锁页闪屏**。
 *
 *   2. 解耦：UnlockPage 负责"让用户输主密码完成解锁"，本组件负责
 *      "把后端真实状态映射到前端"，职责单一，避免 UnlockPage 越来越
 *      臃肿。
 *
 *   3. 与现有"副作用组件不渲染 DOM"模式一致（参考 ThemeSync /
 *      Shortcuts），符合代码库约定。
 *
 * ---------------------------------------------------------------------------
 * 调用顺序契约（启动流程双阶段）：
 *
 *   阶段 A —— 信任设备自动解锁（重启 app 后免输主密码）：
 *     1. await vaultApi.tryUnlockWithTrustedDevice()
 *        - true：后端已用 DPAPI/Keychain 还原 DEK 进入解锁态
 *        - false：未启用 / OS 凭据已变化 / 平台不支持，落到阶段 B
 *
 *   阶段 B —— 后端 DEK 残留同步（webview 刷新场景，Go 进程未重启）：
 *     1. await vaultApi.status()
 *        - status.unlocked=true：后端 s.dek 仍在内存（只是前端 store
 *          重置成 locked=true），同步翻 false 跳过解锁页
 *        - status.unlocked=false：后端真的锁了，让用户走 UnlockPage
 *
 *   两个阶段成功后的共同收尾（与 UnlockPage.onSubmit 保持一致）：
 *     2. useLockStore.unlock()      ← 翻前端 locked=false 放行 LockGuard
 *     3. await useVaultStore.load() ← 预加载条目避免 /vault 首屏闪空
 *
 * 第 3 步失败不回滚 locked=true：load 失败通常是数据库 IO 异常，
 * 此时把用户卡在锁定页也无济于事；让 VaultPage 自己处理空列表 +
 * 错误 toast 反馈更合理。
 *
 * ---------------------------------------------------------------------------
 * 为什么阶段 A 在阶段 B 之前：
 *
 * 重启场景下后端 s.dek 是 nil（进程刚启动），status.unlocked 一定是
 * false，必须先经过 trusted-device 解封才能让 status 反映出"已解锁"。
 * 反过来 webview 刷新场景下 trusted-device 未启用时返回 false，再走
 * status 探测兜底。两个阶段分别处理两类场景，不会互相干扰。
 *
 * tryUnlockWithTrustedDevice 内部已经做了「已解锁直接返回 true」的幂等
 * 守卫（见 vaultservice.go），所以即便 webview 刷新场景下 vault_trusted
 * _device 表有行也不会重复做 OS API 调用 —— 直接走幂等捷径返回。
 *
 * ---------------------------------------------------------------------------
 * 不做的事：
 *   - 不订阅后端状态变化（没有这种事件流）—— 仅在挂载时同步一次
 *   - 不处理超时锁定（那是未来 LockTimer 组件的职责，按 prefs.lockTimeout
 *     启动 idle 计时器，到期后调 useLockStore.lock()）
 *   - 不在已经 locked=false 时反复探测（避免无谓 IPC）
 */
export function LockSync() {
	useEffect(() => {
		// 用闭包内 cancelled 标志规避「组件卸载后 setState」警告 ——
		// 严格模式下 React 18+ 会双调用 effect，没有 cancelled 守卫
		// 第一次的 unlock() 会作用在已被卸载的 store subscriber 上
		// （实际不会 crash 但会在 dev 控制台噪声）。
		let cancelled = false;

		// 共同收尾流程：翻前端标志位 + 预加载条目
		// 抽出独立函数让阶段 A / 阶段 B 共用，避免重复代码。
		const finishUnlock = async () => {
			// 启动时如果前端 store 已经是 unlocked（极罕见，理论不发生
			// 因为默认 locked=true）直接退出避免重复 load。
			if (!useLockStore.getState().locked) return;

			useLockStore.getState().unlock();

			try {
				await useVaultStore.getState().load();
			} catch (err) {
				console.error("[LockSync] preload vault failed:", err);
			}
		};

		(async () => {
			// ─── 阶段 A：信任设备自动解锁 ───────────────────────────
			// 优先尝试用 OS 设备绑定密钥还原 DEK（DPAPI / Keychain）。
			// 这是「重启 app 后免输主密码」的核心路径。
			//
			// 后端 TryUnlockWithTrustedDevice 已经做了完整的失败兜底：
			//   - 未启用 / OS 凭据已变化 / blob 与当前 vault 不匹配
			//     等所有异常情况一律返回 false（并静默清掉过期 blob 行）
			//   - 真实异常（DB I/O 失败等）才返回 error
			//
			// 因此本层只在抛 error 时打日志，false 是正常路径不报警。
			try {
				const trusted = await vaultApi.tryUnlockWithTrustedDevice();
				if (cancelled) return;
				if (trusted) {
					await finishUnlock();
					return;
				}
			} catch (err) {
				if (cancelled) return;
				// 真异常（DB 损坏等）—— 不阻塞阶段 B，让 status 探测再
				// 试一次。即便 status 也失败，UnlockPage 还会做第三道
				// 兜底（默认进解锁模式让用户输密码）。
				console.error("[LockSync] trusted-device unlock failed:", err);
			}

			// ─── 阶段 B：后端 DEK 残留同步（webview 刷新场景）───────
			// 走到这里意味着 trusted-device 没启用 / 失败 / 平台不支持。
			// 检查后端 vault 是否仍持有 DEK（Wails dev 刷新 webview 时
			// Go 进程不重启，s.dek 仍在内存）。
			try {
				const status = await vaultApi.status();
				if (cancelled) return;

				// 仅当「已初始化 + 后端持有 DEK」时同步成解锁态
				// initialized=false：vault 都没建，没什么可解锁的
				// unlocked=false：后端确实是锁定态，让用户走正常解锁流程
				if (!status.initialized || !status.unlocked) return;

				await finishUnlock();
			} catch (err) {
				// status 探测失败：保守起见保持 locked=true，让用户走
				// UnlockPage 的正常流程（UnlockPage 内部也有 status
				// 探测兜底逻辑，会落到 unlock 模式让用户输密码）。
				if (cancelled) return;
				console.error("[LockSync] status probe failed:", err);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, []);

	// 纯副作用组件，不渲染任何 DOM
	return null;
}

export default LockSync;
