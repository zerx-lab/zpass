import { useEffect } from "react";
import { tinykeys } from "tinykeys";
import { Outlet } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";
import { Titlebar } from "@/components/Titlebar";
import { Topbar } from "@/components/Topbar";
import { useSidebar } from "@/lib/useSidebar";

/**
 * 应用根布局
 * ---------------------------------------------------------------------------
 * 在原有三行两列 grid 基础上，接入 useSidebar hook，实现：
 *   1. 侧边栏宽度动态（拖拽 resize）—— grid-cols 用 CSS var 驱动
 *   2. 侧边栏收起/展开（icon-only 52px ↔ 展开宽度）
 *   3. 拖拽期间全局 cursor: col-resize + 禁止文字选中
 *
 * useSidebar 实例在 AppShell 创建，通过 props 传给 <Sidebar>，
 * 保证两者共享同一份状态（不重复读 localStorage、不多次注册事件）。
 *
 * 全局快捷键 ⌘B / Ctrl+B 由 Shortcuts.tsx 调用 sidebarStore 或
 * 通过 Context 触发 toggle，此处不重复注册。
 */
export function AppShell() {
	const sidebar = useSidebar();
	const { effectiveWidth, isDragging, toggle } = sidebar;

	// ⌘B / Ctrl+B —— 收起/展开侧边栏（与 VS Code / shadcn sidebar 一致）
	useEffect(() => {
		const unbind = tinykeys(window, {
			"$mod+KeyB": (e: KeyboardEvent) => {
				e.preventDefault();
				toggle();
			},
		});
		return () => unbind();
	}, [toggle]);

	return (
		<div
			className="app grid h-full w-full overflow-hidden bg-(--bg) text-(--text)"
			style={{
				gridTemplateColumns: `${effectiveWidth}px 1fr`,
				gridTemplateRows: "auto auto 1fr",
				// 拖拽时全局禁选，避免文字被框选
				userSelect: isDragging ? "none" : undefined,
				// 拖拽时强制 col-resize 光标，防止鼠标移出 handle 后光标跳回
				cursor: isDragging ? "col-resize" : undefined,
			}}
			// 拖拽时阻止 pointer 事件穿透到子级 iframe（Wails webview）
			data-dragging={isDragging ? "true" : "false"}
		>
			{/* Row 1 —— 自定义 titlebar，跨两列 */}
			<div className="col-span-2 row-start-1">
				<Titlebar />
			</div>

			{/* 左栏 —— Sidebar，跨越 row 2 + row 3 */}
			<div
				className="col-start-1 row-start-2 row-end-4 min-h-0"
				style={{
					// 平滑过渡宽度变化（仅非拖拽时启用，拖拽时关闭避免卡顿）
					transition: isDragging ? "none" : "width 200ms ease",
					width: effectiveWidth,
					// 防止 grid 子项被撑大
					minWidth: 0,
					overflow: "hidden",
				}}
			>
				<Sidebar sidebarState={sidebar} />
			</div>

			{/* Row 2 Col 2 —— Topbar */}
			<div className="col-start-2 row-start-2">
				<Topbar />
			</div>

			{/* Row 3 Col 2 —— 主内容区（Outlet） */}
			<main className="col-start-2 row-start-3 flex min-h-0 flex-col overflow-hidden">
				<div className="flex-1 min-h-0 overflow-hidden">
					<Outlet />
				</div>
			</main>
		</div>
	);
}

export default AppShell;
