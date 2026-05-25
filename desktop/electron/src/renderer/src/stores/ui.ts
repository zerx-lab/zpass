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

	openCmdk: () => void;
	closeCmdk: () => void;
	toggleCmdk: () => void;

	openTweaks: () => void;
	closeTweaks: () => void;
	toggleTweaks: () => void;

	/** 触发"打开新建条目对话框"的全局信号 */
	requestNewItem: () => void;

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

	openCmdk: () => set({ cmdkOpen: true }),
	closeCmdk: () => set({ cmdkOpen: false }),
	toggleCmdk: () => set((s) => ({ cmdkOpen: !s.cmdkOpen })),

	openTweaks: () => set({ tweaksOpen: true }),
	closeTweaks: () => set({ tweaksOpen: false }),
	toggleTweaks: () => set((s) => ({ tweaksOpen: !s.tweaksOpen })),

	requestNewItem: () => set((s) => ({ newItemRequest: s.newItemRequest + 1 })),

	pushToast: (toast) => {
		const id = toast.id ?? genId();
		set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
		return id;
	},
	dismissToast: (id) =>
		set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
	clearToasts: () => set({ toasts: [] }),
}));
