import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { useState } from "react";
import { X } from "lucide-react";
import { Window } from "@wailsio/runtime";
import { clsx } from "clsx";
import { isMacOS } from "@/lib/platform";

type MiniTitlebarButtonKind = "close";

interface MiniTitlebarProps {
  brand?: string;
  className?: string;
  showCloseButton?: boolean;
  onClose?: () => void;
}

/**
 * 迷你标题栏（未登录/引导页）—— Wails 3 版本
 * ---------------------------------------------------------------------------
 * 用于 Welcome / SignIn / Unlock / Onboarding 这类"轻量单卡片"页面：
 *   - 左侧仅展示品牌字样
 *   - 中间整段可拖拽
 *   - 右侧仅保留关闭按钮（Windows / Linux）
 *
 * 设计目标：
 *   1. 统一未登录态各页面的标题栏实现，避免每页各自手写一份关闭按钮
 *   2. 不依赖 `hover:bg-(--token)` 之类状态 utility，直接用 React 状态 +
 *      inline style 驱动 hover / active，确保在 Wails WebView 中稳定生效
 *   3. macOS 不渲染自定义按钮，左侧自动预留系统红绿灯位置
 *
 * Wails 3 拖拽机制：
 *   - 通过 CSS 自定义属性 `--wails-draggable: drag` 标记拖拽区域，
 *     运行时（drag.ts）在 mousedown 时读取目标元素 computed style 决定
 *     是否触发原生窗口拖动。CSS 自定义属性会 inherit，因此放在外层即可
 *     让所有子元素都参与拖拽；按钮通过 `no-drag` 显式开洞。
 *   - 关闭/最大化等窗口操作走 `Window.Close()` / `Window.Minimise()` 等
 *     `@wailsio/runtime` 默认导出 API。
 */

/** Drag region shared style — see Titlebar.tsx for the rationale. */
const DRAG_STYLE: CSSProperties = {
  // @ts-expect-error - vendor-prefixed CSS property not in standard React types
  WebkitAppRegion: "drag",
};

/** Punch a hole in the drag region for the close button. */
const NO_DRAG_STYLE: CSSProperties = {
  // @ts-expect-error - vendor-prefixed CSS property not in standard React types
  WebkitAppRegion: "no-drag",
};

export function MiniTitlebar({
  brand = "ZPass",
  className,
  showCloseButton = true,
  onClose,
}: MiniTitlebarProps) {
  const mac = isMacOS();
  const [hoveredButton, setHoveredButton] =
    useState<MiniTitlebarButtonKind | null>(null);
  const [pressedButton, setPressedButton] =
    useState<MiniTitlebarButtonKind | null>(null);

  const handleClose = async () => {
    if (onClose) {
      onClose();
      return;
    }

    Window.Close().catch((err) => console.error("Close failed", err));
  };

  const getCloseButtonStyle = (): CSSProperties => {
    const hovered = hoveredButton === "close";
    const pressed = pressedButton === "close";

    // 按钮始终是 no-drag —— 避免父级 inherit 的 drag 值吞掉点击
    const base: CSSProperties = { ...NO_DRAG_STYLE };

    if (pressed) {
      return {
        ...base,
        backgroundColor: "var(--titlebar-close-active)",
        borderLeftColor: "var(--titlebar-close-active)",
        color: "var(--titlebar-close-ink)",
      };
    }

    if (hovered) {
      return {
        ...base,
        backgroundColor: "var(--titlebar-close-hover)",
        borderLeftColor: "var(--titlebar-close-hover)",
        color: "var(--titlebar-close-ink)",
      };
    }

    return base;
  };

  const clearHover = () => {
    setHoveredButton((current) => (current === "close" ? null : current));
    setPressedButton((current) => (current === "close" ? null : current));
  };

  const releasePress = () => {
    setPressedButton((current) => (current === "close" ? null : current));
  };

  const onCloseMouseDown = (e: ReactMouseEvent<HTMLButtonElement>) => {
    // 仅主键按下时进入 pressed 态，避免右键/中键污染视觉状态
    if (e.button !== 0) return;
    setPressedButton("close");
  };

  return (
    <div
      className={clsx(
        "relative z-10 flex h-9 shrink-0 items-center justify-end border-b border-(--line-soft) bg-(--bg) pr-0 select-none",
        className,
      )}
      style={{
        ...DRAG_STYLE,
        paddingLeft: mac ? "var(--titlebar-traffic-lights-inset)" : "12px",
      }}
    >
      <span className="pointer-events-none flex-1 font-mono text-[11px] tracking-[0.14em] text-(--text-4) uppercase">
        {brand}
      </span>

      {!mac && showCloseButton && (
        <button
          type="button"
          title="Close"
          aria-label="Close window"
          onClick={() => {
            void handleClose();
          }}
          onMouseEnter={() => setHoveredButton("close")}
          onMouseLeave={clearHover}
          onMouseDown={onCloseMouseDown}
          onMouseUp={releasePress}
          onBlur={releasePress}
          className={clsx(
            "flex h-9 w-11 items-center justify-center border-l border-transparent",
            "text-(--text-3) transition-[background-color,color,border-color] duration-120",
          )}
          style={getCloseButtonStyle()}
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}

export default MiniTitlebar;
