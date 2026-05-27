// 全局 Toast 容器
// ---------------------------------------------------------------------------
// 订阅 `useUIStore.toasts` 并在视口右下角渲染最多 N 条同时出现的轻量
// 通知。给"复制成功 / 密码已生成 / 已锁定 / 操作失败"等瞬时反馈一个
// 统一出口，避免每个组件各自实现"我点了按钮要不要给反馈、给多久、放
// 哪里"。
//
// ---------------------------------------------------------------------------
// 设计权衡
//
// 1. 单挂载点
//    本组件应在 router 顶层（RootLayout）挂载一次。所有页面（Welcome /
//    Unlock / Vault / Generator / ...）共享同一个 Toast 栈。组件本身不
//    渲染任何"占位"DOM —— toasts 为空时返回 null，对布局零影响。
//
// 2. 入栈：useUIStore.pushToast()
//    任何业务逻辑都通过 store 推送 toast，而不是直接调用本组件的 API：
//      pushToast({ text: "Password copied", icon: "check", duration: 2000 })
//    这样：
//      - 调用方不需要拿到 Toast 组件的引用
//      - 多 Toast 时序由 store 保证一致
//      - 测试时可以直接断言 store.toasts 而不是去 query DOM
//
// 3. 自动消失
//    每条 toast 入栈后由本组件起一个 setTimeout（按 toast.duration 或默认
//    1800ms）调 dismissToast(id) 把它从 store 里弹掉。定时器 handle 用
//    Map<id, number> 维护：
//      - toast 被外部主动 dismiss → 取消该 id 的定时器
//      - 组件卸载 → 取消所有定时器
//    避免"卸载后定时器仍然 fire 然后 setState"的 React warning。
//
// 4. 视觉
//    - 黑白高级感配色：bg-(--bg-elev-2) + border-(--line) + text-(--text)
//    - 不做"成功/错误/警告"色差区分（与 ZPass 整体克制风格一致）
//      若调用方真的需要语义色，传 icon="alert" / icon="x" 让前缀图标自身
//      用 --danger 着色即可，文字始终保持 --text 中性
//    - 圆角 7px（design tokens 中 --radius），阴影 sm，避免漂浮感
//    - 进出动画：transform translateY + opacity，180ms ease-out
//      用 framer-motion 太重，本场景纯 CSS transition 完全够用；
//      用 data-state 属性切换让 transition 自动跑
//
// 5. 入场顺序
//    新 toast 追加到栈底，但视觉上从下往上累积（最新在最下方贴近视口
//    底部）。为什么不"最新在最上"：
//      - 最新事件最近发生 → 用户视线最自然落在最近一次操作之后弹起
//        的位置（右下角）
//      - 上方的旧 toast 即将消失，视觉权重应该比下方新 toast 低
//    对应实现：渲染顺序按 toasts 数组正向排（旧 → 新），flex-col 让
//    新的自然出现在数组末尾，配合容器 flex-col 的常规堆叠就能得到
//    "新的在下方"的视觉。
//
// 6. 可访问性
//    - 容器 role="region" + aria-label，让屏幕阅读器知道这是一个独立
//      区域而不是裸 div
//    - 单条 role="status" + aria-live="polite"：通知性内容用 polite
//      （非 assertive）—— 不打断用户当前朗读流程，等读完再播报，符合
//      "复制成功"这类非紧急消息的语义
//
// ---------------------------------------------------------------------------
// 与 ZPassDesign 原型的关系
//
// 原型 ZPassDesign/src/ui.jsx 里的 ToastProvider 是个 context 实现，
// 同一时间只显示一条。这里改成 store 驱动的栈结构，原因：
//   - 复制 username + 复制 password 连续点 → 两条都该显示
//   - 异步操作（生成 + 保存）可能并行触发多条
//   - context 单例模式不便于在 zustand 主导的状态架构里调用

import { Check, Copy, Info, Lock, X } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { useEffect, useRef } from "react";
import { useUIStore } from "@/stores/ui";

type IconComp = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

/**
 * icon 字符串 → Lucide 组件 映射
 *
 * 调用方传字符串而不是组件，是为了让 toast 数据结构在 store 里完全
 * 可序列化（虽然 zustand 内存 store 不强求，但保持 plain object 让
 * 未来"通过 IPC 推送系统通知"等扩展更顺）。
 *
 * 未在表里的 icon 名走 fallback（Info），不抛错。
 */
const ICON_MAP: Record<string, IconComp> = {
	check: Check,
	copy: Copy,
	lock: Lock,
	info: Info,
	x: X,
};

/**
 * 默认每条 toast 自动消失时长（ms）
 *
 * 1800ms 是工程经验值：
 *   - 太短（< 1500ms）—— 用户视线还没扫到通知它就消失，等于没显示
 *   - 太长（> 3000ms）—— 多次操作会堆叠出永久驻留感，干扰主任务
 *   - 1800ms 刚好覆盖"扫一眼 + 读完一行短文"
 */
const DEFAULT_DURATION_MS = 1800;

/**
 * 单条 Toast 视觉
 * ---------------------------------------------------------------------------
 * 不接收"is closing"状态 —— 我们采用"消失即移除 DOM"的简化模型。
 * 入场动画通过 CSS @keyframes（在 globals.css 里另行定义可选；这里直接
 * 用一个内联 style + transition 兜底，无 keyframes 依赖也能优雅出现）。
 *
 * 为什么不直接用 framer-motion：
 *   - 本组件已经被 router 顶层挂载，每帧都在；引入 motion 会让首屏
 *     动画运行时多 ~30KB
 *   - Toast 仅有"出现"一次的瞬时动画，没有交互态，CSS transition 足够
 */
function ToastItemView({
	text,
	icon,
	action,
}: {
	text: string;
	icon?: string;
	action?: { label: string; onClick: () => void };
}) {
	const Icon = icon ? (ICON_MAP[icon] ?? Info) : null;

	return (
		<div
			role="status"
			aria-live="polite"
			className="
				toast-item pointer-events-auto
				flex items-start gap-2.5
				min-w-[200px] max-w-[380px]
				rounded-(--radius-lg)
				zpass-toast
				px-3.5 py-2.5
				text-[12.5px] text-(--text)
			"
			style={{
				// 入场动画：从下方 8px + 透明 → 原位 + 不透明
				// keyframes 来自 globals.css（统一管理，避免重复注入）
				animation: "zpass-toast-in 180ms ease-out",
			}}
		>
			{Icon && (
				<Icon
					size={13}
					strokeWidth={1.6}
					className="mt-0.5 shrink-0 text-(--text-2)"
				/>
			)}
			{/* 长文案改为 break-words 而非 truncate ——
			 * 避免视觉/可访问性不一致（aria-live 朗读完整文本但视觉只看到一半）
			 */}
			<span className="min-w-0 flex-1 leading-relaxed break-words">
				{text}
			</span>
			{action && (
				<button
					type="button"
					onClick={action.onClick}
					className="
						shrink-0 self-center
						rounded-(--radius-sm)
						border border-(--line-soft) bg-(--bg-elev)
						px-2 py-0.5
						text-[11.5px] font-medium text-(--text)
						transition-colors duration-100
						hover:bg-(--bg-hover)
						focus:outline-none
					"
				>
					{action.label}
				</button>
			)}
		</div>
	);
}

/**
 * 全局 Toast 容器
 * ---------------------------------------------------------------------------
 * 订阅 store.toasts；每条新 toast 入栈时起一个 timeout 在 duration 后
 * 自动 dismiss。用 ref Map 跟踪 timeout handle 以便：
 *   1. 同一条 toast 被重复处理时不重复起定时器（StrictMode 下 useEffect
 *      会跑两次，没有这个保护会出现"timer 漏挂"）
 *   2. toast 被外部提前 dismiss 时取消对应 timer
 *   3. 组件卸载时清理所有 timer，避免 memory leak / 卸载后 setState
 */
export function Toast() {
	const toasts = useUIStore((s) => s.toasts);
	const dismissToast = useUIStore((s) => s.dismissToast);

	// id → timeout handle
	const timersRef = useRef<Map<string, number>>(new Map());

	useEffect(() => {
		const timers = timersRef.current;
		const aliveIds = new Set(toasts.map((t) => t.id));

		// 1. 给新出现的 toast 起 timer
		for (const t of toasts) {
			if (timers.has(t.id)) continue;
			const duration = t.duration ?? DEFAULT_DURATION_MS;
			const handle = window.setTimeout(() => {
				dismissToast(t.id);
				timers.delete(t.id);
			}, duration);
			timers.set(t.id, handle);
		}

		// 2. 清掉对应已被外部 dismiss 的 toast 的 timer（避免 fire 后空跑）
		for (const [id, handle] of timers) {
			if (!aliveIds.has(id)) {
				window.clearTimeout(handle);
				timers.delete(id);
			}
		}
	}, [toasts, dismissToast]);

	// 卸载时清理所有 timer —— 防止"卸载后 timer fire 调用 dismissToast"
	// 触发"setState on unmounted"。React 18+ 不再报这个 warning，但仍是
	// 良好实践。
	useEffect(() => {
		return () => {
			for (const handle of timersRef.current.values()) {
				window.clearTimeout(handle);
			}
			timersRef.current.clear();
		};
	}, []);

	if (toasts.length === 0) return null;

	// keyframes `zpass-toast-in` 已统一提到 globals.css —— 不再每次挂载注入
	// inline <style>。原本"Toast 没渲染过则 NewItemDialog 入场动画失效"的
	// 潜在 bug 一并消除。
	return (
		<section
			aria-label="Notifications"
			className="
				pointer-events-none fixed right-5 bottom-5 z-(--z-toast)
				flex flex-col items-end gap-2
			"
		>
			{toasts.map((t) => (
				<ToastItemView
					key={t.id}
					text={t.text}
					icon={t.icon}
					action={
						t.action
							? {
									label: t.action.label,
									onClick: () => {
										t.action?.onClick();
										dismissToast(t.id);
									},
								}
							: undefined
					}
				/>
			))}
		</section>
	);
}

export default Toast;
