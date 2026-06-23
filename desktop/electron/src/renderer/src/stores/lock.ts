// 锁定状态 store
// ---------------------------------------------------------------------------
// 独立于 usePrefsStore 单独抽出，理由：
//   1. 锁定状态变化频率远高于偏好（超时自动锁、手动锁、解锁），单独切片可避免
//      prefs 的 localStorage persist 被频繁触发写入。
//   2. 未来需要接入空闲超时（idle timeout）、系统休眠锁定、失败计数等扩展逻辑，
//      独立 slice 更干净。
//   3. 严格来说"是否锁定"属于运行时安全状态，不应被持久化到磁盘 —— 应用重启默认
//      即为锁定，由 UnlockPage 强制验证主密码后才能进入。
//
// 对标 ZPassDesign/src/app.jsx 中的 locked 状态。
//
// ---------------------------------------------------------------------------
// 关键安全约定（2026-04 修订）：lock() 必须同步后端 vault
//
// 早期实现里 useLockStore.lock() 只翻前端 locked 标志位，**不**调后端
// vaultApi.lock()。这埋了个严重安全漏洞链：
//
//   1. 用户 Initialize 后，后端 s.dek 持有 DEK
//   2. 用户从 Sidebar / CmdK / ⌘L 快捷键中**任意一个**入口"锁定"
//      → 前端 locked=true，但后端 s.dek 仍然 != nil
//   3. 路由守卫把用户送回 /unlock
//   4. 用户输入**任何**密码（包括空 / 错的）
//   5. 旧版 vaultservice.Unlock 看到 s.dek != nil 走幂等捷径直接返回 nil
//   6. 前端以为解锁成功 → 攻击者用空密码即可绕过所有保护
//
// 后端那条幂等捷径已经被移除（见 vaultservice.go Unlock 头部注释 +
// TestUnlock_AlreadyUnlockedWrongPassword_RejectsAndPreservesSession 用例
// 锁死），但前端这一层"defense in depth"也要补：lock() 内部 fire-and-forget
// 调 vaultApi.lock()，让所有四个锁定入口（VaultPage 按钮 / Sidebar 按钮 /
// CmdK 命令面板 / ⌘L 快捷键）都自动同步到后端 vault。
//
// 为什么用 fire-and-forget 而不 await：
//   - useLockStore.lock 是同步 zustand action（签名 () => void），改成 async
//     会让所有调用方需要 `await store.lock()`，散落在多个组件里成本高
//   - 后端 vaultApi.lock 失败概率极低（只是抹零内存切片），即便失败前端
//     仍然翻 locked=true 让用户看到"已锁定"反馈是合理的；后端那份 dek
//     最差就是不被显式抹零，但下次 Unlock 现在已经会做完整验证（不走
//     幂等捷径），错密码进不来 —— 双层防御都失效才会出问题
//   - vaultApi.lock 内部已经做了 try/catch + console.error，错误不会
//     冒泡到 React 树打断渲染
//
// import vaultApi 不引入循环依赖：lib/vault-api → bindings → 不依赖 stores

import { create } from "zustand";
import { cancelClipboardClear } from "@/lib/clipboard";
import { lockCloudSession } from "@/lib/cloud-api";
import { vaultApi } from "@/lib/vault-api";

export interface LockState {
	/** 保险库是否锁定（true = 锁定，需要主密码解锁） */
	locked: boolean;
	/** 上次解锁时间戳（毫秒），用于计算空闲超时 */
	lastUnlockedAt: number | null;
	/** 连续解锁失败次数 —— 达到阈值后可触发冷却或擦除策略 */
	failedAttempts: number;

	/**
	 * 解锁 —— 设置 locked=false，记录解锁时间，重置失败计数
	 *
	 * 注意：此方法**不**调后端 vaultApi.unlock —— 解锁需要主密码作参数，
	 * 由 UnlockPage 表单提交时显式调用 vaultApi.unlock(password) 完成。
	 * 本方法只负责把后端解锁成功后的"前端 locked 标志位"翻成 false。
	 *
	 * 调用顺序契约（见 UnlockPage.tsx 的 onSubmit）：
	 *   await vaultApi.unlock(password)   ← 后端解密 verifier
	 *   useLockStore.unlock()              ← 翻前端标志
	 *   await useVaultStore.load()         ← 拉条目列表
	 *   navigate("/vault")                 ← 进入主界面
	 */
	unlock: () => void;

	/**
	 * 锁定 —— 设置 locked=true，清空 lastUnlockedAt，**并 fire-and-forget
	 * 调后端 vaultApi.lock() 抹零内存中的 DEK**
	 *
	 * 调用方可以是任何"用户主动锁定"的入口（按钮 / 快捷键 / 命令面板 /
	 * 未来的空闲超时定时器），都不需要关心后端同步细节。
	 *
	 * 关键：必须同时锁后端，否则后端 dek 残留 + 前端某些异常路径可能
	 * 让用户绕过密码验证。详见本文件头部"关键安全约定"。
	 */
	lock: () => void;

	/**
	 * 切换锁定状态（⌘L 快捷键使用）
	 *
	 * 锁定分支同样会 fire-and-forget 调后端 vaultApi.lock()。
	 * 解锁分支只翻前端标志位 —— 因为没有主密码无法真正在后端解锁，这种
	 * 路径下用户会被路由守卫送到 /unlock 页重新输密码。
	 */
	toggleLock: () => void;

	/** 记录一次解锁失败 */
	recordFailedAttempt: () => void;
	/** 重置失败计数（解锁成功 / 管理员手动清零时调用） */
	resetFailedAttempts: () => void;
}

/**
 * fire-and-forget 调后端锁定 + 同步抹掉前端剪贴板痕迹
 *
 * 抽成独立函数让 lock() / toggleLock() 共用，避免重复写 .catch 兜底。
 * vaultApi.lock 内部已经吞掉 IPC 错误并写 console.error，这里只是再
 * 兜一层防御 —— 即便绑定层未来变更行为意外抛 unhandled rejection，
 * 也不让它冒到 window.onunhandledrejection 触发整个应用的错误 boundary。
 *
 * 不在 store 外部 await：见文件头部"为什么用 fire-and-forget"注释。
 * 真要"等后端确认锁定"的场景由调用方显式 `await vaultApi.lock()` 后
 * 再调 store.lock()，本路径覆盖"调用方不在乎确认"的多数情况。
 *
 * ---------------------------------------------------------------------------
 * 同步取消 clipboard 自动清空定时器
 *
 * lib/clipboard.ts 维护一个全局 setTimeout：用户复制密码后 30s 自动清空
 * 剪贴板。锁定保险库时如果不取消这个定时器：
 *   - 锁定 → 5s 后定时器仍然 fire → 尝试 readText() 比对 lastWritten
 *   - 此时 lib/clipboard 内的 lastWritten（明文密码副本）还在
 *     —— 已经超出"vault 解锁态"的安全边界
 *   - 即便这是个内存对比用的字符串、不是写到磁盘，把它在锁定后继续保留
 *     违背"锁定即抹零内存敏感态"的承诺
 *
 * 解法：lock() 时一并 cancelClipboardClear()。这会：
 *   1. clearTimeout 排队的清空动作（不再做 readText 对比）
 *   2. 把 lastWritten 立刻置 null（释放明文密码 string 引用）
 *
 * 副作用上的取舍：
 *   - 用户在锁定前 5 秒复制了密码、还没来得及粘贴 → 锁定后剪贴板里仍有
 *     该密码（OS 层），但 30s 自动清空机制失效。这是接受的损失：
 *     锁定意图比"清空剪贴板"优先级高，实际上多数用户锁定后会立刻离开
 *     键盘，30s 后剪贴板里残留的密码风险小于"前端 store 内残留密码副本"。
 *   - 想做"锁定时也强制清空 OS 剪贴板"需要异步 await readText/writeText，
 *     和 fire-and-forget 风格冲突；且 OS 层清空可能被其它 app 占用焦点
 *     导致权限错误。当前不实现。
 */
function fireBackendLock(): void {
	void vaultApi.lock().catch(() => {
		// vaultApi.lock 内部已经 console.error，这里静默防御性兜底
	});
	// 同等抹零云会话的内存密钥(账户私钥 + vault keys)。与本地 DEK 同周期清理:
	// 锁定后云会话密钥不应继续驻留。fire-and-forget,无活动会话时后端 no-op。
	void lockCloudSession().catch(() => {
		// callCloud 内部已记录;静默兜底防 unhandled rejection。
	});
	// 取消任何 pending 的 clipboard 清空定时器，并抹掉 lastWritten 副本
	cancelClipboardClear();
}

/**
 * 默认初始状态 —— 应用启动即为锁定。
 *
 * 注意：**不要**对该 store 启用 persist 中间件。运行时锁定状态属于内存
 * 敏感状态，持久化到 localStorage 会让攻击者读取到"已解锁"标记后绕过
 * 主密码验证（即使加密数据本身仍然安全，UX 层面也会绕开）。
 */
export const useLockStore = create<LockState>((set) => ({
	locked: true,
	lastUnlockedAt: null,
	failedAttempts: 0,

	unlock: () =>
		set({
			locked: false,
			lastUnlockedAt: Date.now(),
			failedAttempts: 0,
		}),

	lock: () => {
		// 先发出后端锁定请求（fire-and-forget），再翻前端标志
		// 顺序无关紧要 —— 两侧异步进行，最终用户看到的"锁定"是前端
		// 标志驱动的路由守卫重定向，后端抹零是后台动作
		fireBackendLock();
		set({
			locked: true,
			lastUnlockedAt: null,
		});
	},

	toggleLock: () =>
		set((s) => {
			if (s.locked) {
				// 当前锁定 → 切换到解锁。注意：仅翻前端标志位，无法真正在
				// 后端解锁（缺主密码）。用户实际仍会被 LockGuard 送到 /unlock
				// 页输密码。这条路径主要是 UI 状态切换的一致性。
				return {
					locked: false,
					lastUnlockedAt: Date.now(),
					failedAttempts: 0,
				};
			}
			// 当前解锁 → 切换到锁定。fire-and-forget 调后端抹零 DEK。
			fireBackendLock();
			return {
				locked: true,
				lastUnlockedAt: null,
			};
		}),

	recordFailedAttempt: () =>
		set((s) => ({ failedAttempts: s.failedAttempts + 1 })),

	resetFailedAttempts: () => set({ failedAttempts: 0 }),
}));
