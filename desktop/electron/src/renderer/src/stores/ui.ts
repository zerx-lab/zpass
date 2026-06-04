// UI 临时态 store —— 不做持久化，仅保存会话内的瞬时状态
// 对标 ZPassDesign/src/app.jsx 中 useState 的 cmdk / section 等本地 state
//
// 设计考虑：
//   - 持久化偏好（theme/lang/scale/...）放在 prefs.ts
//   - 锁屏状态（locked）放在 lock.ts
//   - 这里只管"窗口关了就重置"的瞬时态：命令面板开合、Tweaks 面板开合、Toast 队列等

import { create } from "zustand";

/** Toast 消息项 */
export interface ToastItem {
	id: string;
	text: string;
	/** 可选图标名（对应 lucide-react 图标），由渲染层自行映射 */
	icon?: string;
	/** 持续毫秒，默认 1600 */
	duration?: number;
	/**
	 * 可选操作按钮 —— 渲染在文本右侧。常用于「打开目录 / 撤销 / 复制」
	 * 等需要让用户立刻接续操作的反馈。
	 *
	 * 点击 onClick 后会自动 dismiss 当前 toast（默认行为，便于让"按钮已
	 * 用完"的状态立即消失）；如果业务需要保留 toast，可在 onClick 内
	 * 自己再 pushToast 一条新的。
	 */
	action?: {
		label: string;
		onClick: () => void;
	};
}

export interface UIState {
	/** ⌘K 命令面板是否打开 */
	cmdkOpen: boolean;
	/** 右下角 Tweaks 浮层是否打开 */
	tweaksOpen: boolean;
	/** Toast 队列（FIFO） */
	toasts: ToastItem[];
	/**
	 * "请求打开新建条目对话框"的单调计数器
	 *
	 * 用计数器而不是布尔的原因：
	 *   - Topbar 的 "New" 按钮可能被连续点击多次；如果用 boolean，
	 *     第二次点击时 store 已经是 true，订阅方（VaultPage）的
	 *     useEffect 不会重新触发，对话框无法重新打开
	 *   - 计数器每次 ++，订阅方比较"上次看到的值 ≠ 当前值"即触发
	 *
	 * 业务流：
	 *   1. 用户在 Topbar 点 "New" → requestNewItem() → 计数器 ++
	 *   2. 当前路由不是 /vault → Topbar 自身先 navigate("/vault")
	 *   3. VaultPage 挂载/已挂载 → 订阅 newItemRequest 变化 → 打开对话框
	 *
	 * 不在 store 里直接放"对话框 open/close" 状态：那是 VaultPage
	 * 的本地 UI 状态，store 只负责"跨组件信号传递"。
	 */
	newItemRequest: number;

	/**
	 * "请求打开编辑对话框（指定 itemId）" 的信号
	 *
	 * 与 newItemRequest 同样的"单调计数器 + 业务字段"模式：每次调用
	 * requestEditItem(id) 都把 counter 递增并写下目标 id；订阅方
	 * （VaultPage）的 useEffect 比较 counter 变化即触发 openEditDialog。
	 *
	 * 业务流：
	 *   1. 用户在 TotpPage / 其他列表页点条目的"编辑"按钮
	 *      → requestEditItem(id) + navigate("/vault?filter=<type>")
	 *   2. VaultPage 挂载/已挂载 → 订阅 editItemRequest counter 变化
	 *      → selectItem(id) + 等 fetchItem 完成 → setDialogMode("edit")
	 *
	 * 用 { id, counter } 一起放在 store：避免"id 变了但 counter 没变"
	 * 或"counter 变了但 id 还停留在上一次"的竞态。
	 */
	editItemRequest: { id: string; counter: number } | null;

	openCmdk: () => void;
	closeCmdk: () => void;
	toggleCmdk: () => void;

	openTweaks: () => void;
	closeTweaks: () => void;
	toggleTweaks: () => void;

	/** 触发"打开新建条目对话框"的全局信号 */
	requestNewItem: () => void;

	/**
	 * 消费并清零"新建"信号 —— VaultPage 打开对话框后调用，把计数器复位回 0。
	 *
	 * 必须清零的原因：newItemRequest 是常驻 store 的计数器，VaultPage 是其唯一
	 * 订阅方且会随路由切换卸载/重挂。若不清零，残留的 >0 计数器会在 VaultPage
	 * 下次挂载时被"挂载即跑一次"的 useEffect 当成有效信号，凭空弹出新建对话框
	 * （切走侧边栏菜单再切回"所有条目"即复现）。清零后信号变成一次性脉冲，
	 * 重挂载读到 0 → 不再误触发。
	 */
	clearNewItemRequest: () => void;

	/** 触发"打开指定条目编辑对话框"的全局信号 */
	requestEditItem: (id: string) => void;

	/** 消费并清零"编辑"信号 —— 同 clearNewItemRequest，VaultPage 打开编辑
	 * 对话框后置 null，避免残留信号在重挂载时凭空弹出编辑对话框。 */
	clearEditItemRequest: () => void;

	/** 推入一条 Toast；返回该 toast 的 id 便于外部手动 dismiss */
	pushToast: (toast: Omit<ToastItem, "id"> & { id?: string }) => string;
	/** 按 id 移除某条 Toast */
	dismissToast: (id: string) => void;
	/** 清空全部 Toast */
	clearToasts: () => void;
}

function genId(): string {
	// 短随机 id，够用即可；Toast 同时并存量很小，不需要 uuid
	return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export const useUIStore = create<UIState>((set) => ({
	cmdkOpen: false,
	tweaksOpen: false,
	toasts: [],
	newItemRequest: 0,
	editItemRequest: null,

	openCmdk: () => set({ cmdkOpen: true }),
	closeCmdk: () => set({ cmdkOpen: false }),
	toggleCmdk: () => set((s) => ({ cmdkOpen: !s.cmdkOpen })),

	openTweaks: () => set({ tweaksOpen: true }),
	closeTweaks: () => set({ tweaksOpen: false }),
	toggleTweaks: () => set((s) => ({ tweaksOpen: !s.tweaksOpen })),

	requestNewItem: () => set((s) => ({ newItemRequest: s.newItemRequest + 1 })),

	clearNewItemRequest: () => set({ newItemRequest: 0 }),

	requestEditItem: (id) =>
		set((s) => ({
			editItemRequest: {
				id,
				counter: (s.editItemRequest?.counter ?? 0) + 1,
			},
		})),

	clearEditItemRequest: () => set({ editItemRequest: null }),

	pushToast: (toast) => {
		const id = toast.id ?? genId();
		set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
		return id;
	},
	dismissToast: (id) =>
		set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
	clearToasts: () => set({ toasts: [] }),
}));
