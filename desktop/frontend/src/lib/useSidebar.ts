import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const STORAGE_KEY_COLLAPSED = "zpass:sidebar:collapsed";
const STORAGE_KEY_WIDTH = "zpass:sidebar:width";

const SIDEBAR_WIDTH_DEFAULT = 248;
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 400;
const SIDEBAR_WIDTH_COLLAPSED = 52; // icon-only 宽度

// ---------------------------------------------------------------------------
// 辅助：从 localStorage 安全读取
// ---------------------------------------------------------------------------

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "true";
  } catch {
    return fallback;
  }
}

function readNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Hook 返回值类型
// ---------------------------------------------------------------------------

export interface SidebarState {
  /** 当前侧边栏是否收起 */
  collapsed: boolean;
  /** 展开时的像素宽度 */
  width: number;
  /** 实际渲染宽度（collapsed ? ICON_WIDTH : width） */
  effectiveWidth: number;
  /** 切换收起/展开 */
  toggle: () => void;
  /** 强制展开 */
  expand: () => void;
  /** 强制收起 */
  collapse: () => void;
  /** resize handle 的 ref，挂到分隔线元素上 */
  resizeHandleRef: React.RefObject<HTMLDivElement | null>;
  /** 是否正在拖拽 */
  isDragging: boolean;
}

// ---------------------------------------------------------------------------
// useSidebar
// ---------------------------------------------------------------------------

/**
 * 管理 Desktop Sidebar 的收起/展开状态与拖拽宽度。
 *
 * 特性：
 *   - collapsed / width 双状态，持久化到 localStorage。
 *   - 拖拽时更新 width（clamp 到 [MIN, MAX]），拖拽松开后写入持久化。
 *   - 拖拽到小于 MIN*0.6 位置时自动收起（snap-to-collapse）。
 *   - 提供 toggle / expand / collapse 三个命令式 API，供 Sidebar 按钮 &
 *     全局快捷键 ⌘B 调用。
 *   - effectiveWidth 是组件侧应直接消费的渲染宽度（collapsed 时返回 icon 宽）。
 */
export function useSidebar(): SidebarState {
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    readBool(STORAGE_KEY_COLLAPSED, false),
  );
  const [width, setWidth] = useState<number>(() => {
    const saved = readNumber(STORAGE_KEY_WIDTH, SIDEBAR_WIDTH_DEFAULT);
    return Math.min(Math.max(saved, SIDEBAR_WIDTH_MIN), SIDEBAR_WIDTH_MAX);
  });
  const [isDragging, setIsDragging] = useState(false);

  // 拖拽状态用 ref 避免 closure 陈旧值
  const dragStartX = useRef<number>(0);
  const dragStartWidth = useRef<number>(width);
  const resizeHandleRef = useRef<HTMLDivElement>(null);

  // ── 持久化 ────────────────────────────────────────────────────────────────

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_COLLAPSED, String(collapsed));
    } catch {
      // ignore
    }
  }, [collapsed]);

  // width 仅在非拖拽状态下才写入（拖拽结束统一写一次，避免频繁 IO）
  const persistWidth = useCallback((w: number) => {
    try {
      localStorage.setItem(STORAGE_KEY_WIDTH, String(w));
    } catch {
      // ignore
    }
  }, []);

  // ── 命令式 API ─────────────────────────────────────────────────────────────

  const toggle = useCallback(() => setCollapsed((c) => !c), []);
  const expand = useCallback(() => setCollapsed(false), []);
  const collapse = useCallback(() => setCollapsed(true), []);

  // ── 拖拽逻辑 ──────────────────────────────────────────────────────────────
  //
  // 拖拽分隔线时，在 document 上监听 pointermove / pointerup。
  // 使用 pointer events（而不是 mouse events）：
  //   1. 鼠标移出窗口依然能收到事件（setPointerCapture 配合）。
  //   2. 对触屏/画板笔也有效。

  useEffect(() => {
    const handle = resizeHandleRef.current;
    if (!handle) return;

    const onPointerDown = (e: PointerEvent) => {
      // 只响应主键（鼠标左键 / 触摸 / 笔）
      if (e.button !== 0 && e.pointerType === "mouse") return;
      e.preventDefault();

      // 收起状态下点击分隔线 → 直接展开，不进入拖拽
      if (collapsed) {
        setCollapsed(false);
        return;
      }

      dragStartX.current = e.clientX;
      dragStartWidth.current = width;
      setIsDragging(true);

      // 把 pointer capture 锁到 handle，确保 move 不丢失
      handle.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging) return;
      const delta = e.clientX - dragStartX.current;
      const next = dragStartWidth.current + delta;

      // snap-to-collapse：宽度拖到非常小时自动收起
      const snapThreshold = SIDEBAR_WIDTH_MIN * 0.6;
      if (next < snapThreshold) {
        setCollapsed(true);
        setIsDragging(false);
        return;
      }

      const clamped = Math.min(Math.max(next, SIDEBAR_WIDTH_MIN), SIDEBAR_WIDTH_MAX);
      setWidth(clamped);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!isDragging) return;

      const delta = e.clientX - dragStartX.current;
      const next = dragStartWidth.current + delta;
      const clamped = Math.min(Math.max(next, SIDEBAR_WIDTH_MIN), SIDEBAR_WIDTH_MAX);

      setIsDragging(false);
      setWidth(clamped);
      persistWidth(clamped);
    };

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);

    return () => {
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onPointerUp);
      handle.removeEventListener("pointercancel", onPointerUp);
    };
  }, [collapsed, width, isDragging, persistWidth]);

  // ── 派生值 ────────────────────────────────────────────────────────────────

  const effectiveWidth = collapsed ? SIDEBAR_WIDTH_COLLAPSED : width;

  return {
    collapsed,
    width,
    effectiveWidth,
    toggle,
    expand,
    collapse,
    resizeHandleRef,
    isDragging,
  };
}

export { SIDEBAR_WIDTH_COLLAPSED, SIDEBAR_WIDTH_DEFAULT };
