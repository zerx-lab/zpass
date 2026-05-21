import { Events, Window } from "@wailsio/runtime";
import { clsx } from "clsx";
import { Copy as MaxIcon, Minus, Square, X } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { isMacOS } from "@/lib/platform";

/**
 * 自定义标题栏（Custom Titlebar）—— Wails 3 版本
 * ---------------------------------------------------------------------------
 * 用途：ZPass 桌面端在 main.go 中使用 frameless 窗口（无系统标题栏），
 * 因此需要一个纯 HTML 实现的替代品，提供：
 *   1. 应用品牌标识（左侧 Z + ZPass 文字）
 *   2. 可拖拽区域（Wails 3 通过 CSS 自定义属性 `--wails-draggable: drag` 标记）
 *   3. 窗口控件：最小化 / 最大化（切换） / 关闭（仅 Windows / Linux）
 *
 * 设计约束（与 AGENTS.md 对齐）：
 *   - 高度 36px，属于设计系统内"紧凑头部"档位
 *   - 不使用品牌 accent 色，全部走 --text / --text-2 / --text-3 等中性 token
 *   - 圆角仅用 5/7/10/14；此处窗口按钮不带圆角（平切矩形，与系统控件一致）
 *   - 悬停色走 --titlebar-btn-hover / --titlebar-close-hover，对齐 Windows 11
 *     Fluent 规范（见 src/styles/tokens.css 里的注释）；按下态用更浅/更深的
 *     active token 做"回弹"反馈，不再用通用 --bg-hover / --bg-active。
 *
 * 平台差异：
 *   - Windows / Linux：渲染右侧三键（Min / Max / Close），对齐 Windows 11 的
 *     46×36 px 控件尺寸与配色。
 *   - macOS：**不渲染自定义窗口按钮**，改为在左侧预留 80px 留白
 *     （`--titlebar-traffic-lights-inset`），为原生红绿灯预留位置。
 *     即使当前 main.go 用 frameless 暂时没有红绿灯，也保留这份留白 ——
 *     后续启用 `MacTitleBarHiddenInset` + 系统红绿灯时无需再改组件布局。
 *
 * 渲染位置（重要）：
 *   组件 return 由两部分组成：
 *     1. 一个高度 36px 的**透明占位 div**，留在调用方（AppShell grid row 1）原位，
 *        让 grid 行高与之前一致，主内容布局零改动；
 *     2. 真正可见的标题栏内容通过 React Portal 渲染到 `#titlebar-root`
 *        （body 下的最后一个子节点，位于 `#portal-root` 之后），并使用
 *        `position: fixed; top: 0` 贴顶。
 *
 *   为什么必须 portal 出 #root 子树（详见 index.html 中 #titlebar-root 注释）：
 *     - Radix Dialog/AlertDialog 的 Overlay (`fixed inset-0 z-50`) 挂在
 *       #portal-root 内，DOM 顺序 `#root` < `#portal-root`，同 z-index 下
 *       Overlay 永远盖住 #root 子树里的任何元素，Titlebar 也不例外。
 *     - 缩放档位下 ThemeSync 写在 #root 的 inline `zoom` 让 #root 形成 stacking
 *       context，把 Titlebar 的 z-index "锁" 在 #root 内部，更突破不了 Overlay。
 *     - 把 Titlebar portal 到位于 #portal-root **之后**的 #titlebar-root：
 *       同 z=50 时因 DOM 顺序靠后而覆盖所有 Modal Overlay，并且不再受 #root
 *       zoom stacking context 限制；行为对齐 macOS / 1Password / Bitwarden。
 *
 *   副作用：Titlebar 不再跟随应用内部缩放（zoom），始终按 100% 物理像素渲染。
 *   这与 Windows 11 系统窗口控件、macOS 红绿灯的行为一致 —— 窗口控件本就不
 *   应当随应用内部缩放变化。
 *
 * Wails 3 拖拽机制（与 Tauri 的 `data-tauri-drag-region` 不同）：
 *   - Wails 3 通过 CSS 自定义属性 `--wails-draggable: drag` 标记拖拽区域。
 *     运行时（drag.ts）在鼠标 mousedown 时读取目标元素的 computed style，
 *     若该属性值为 "drag" 则触发原生窗口拖动。
 *   - 必须用 inline style 而非 className —— Tailwind 不会生成自定义属性
 *     的 utility class，且 CSS 自定义属性是 inherit 的，可以放在外层 div 上
 *     让所有子元素都"可拖动"，按钮则通过自身设 `--wails-draggable: no-drag`
 *     来"开洞"（虽然运行时只判断 "drag"，未设值即视为不可拖，但显式声明
 *     更直观且未来扩展行为更清晰）。
 *   - 双击拖拽区切换最大化由 Wails 3 原生处理（与 Tauri 一致）。
 *
 * 注意事项：
 *   - 当窗口处于最大化状态时，最大化按钮切换为"还原"图标，视觉与系统一致。
 *   - Wails 3 的窗口 API（Window.Minimise / Maximise / Close 等）返回 Promise，
 *     失败可以 catch；这里在 catch 里只 log，不阻断 UI。
 *   - 通过监听 `events.windows.WindowDidResize` 等事件保持最大化状态同步；
 *     Wails 3 的事件常量统一在 `@wailsio/runtime` 的 `events` 命名空间下。
 */

/** Drag region shared style.
 *
 * Wails 3 used the bespoke `--wails-draggable: drag/no-drag` CSS custom
 * property; the same code now runs inside Electron, where the well-known
 * `-webkit-app-region: drag/no-drag` is what the WebContents reads to
 * decide which areas the OS treats as the window-move handle. The property
 * inherits, so the outer titlebar sets `drag` once and child buttons opt
 * out via `no-drag` below.
 */
const DRAG_STYLE: CSSProperties = {
  // @ts-expect-error - vendor-prefixed CSS property not in standard React types
  WebkitAppRegion: "drag",
};

/** Punch a hole in the drag region for interactive controls. */
const NO_DRAG_STYLE: CSSProperties = {
  // @ts-expect-error - vendor-prefixed CSS property not in standard React types
  WebkitAppRegion: "no-drag",
};

export function Titlebar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [hoveredButton, setHoveredButton] = useState<
    "minimize" | "maximize" | "close" | null
  >(null);
  const [pressedButton, setPressedButton] = useState<
    "minimize" | "maximize" | "close" | null
  >(null);
  // 平台判断仅在渲染期读一次 —— initPlatform 在 main.tsx 启动时已经写入
  // <html data-platform>；组件挂载时属性已就绪，无需订阅更新（平台不会变）。
  const mac = isMacOS();

  // 订阅窗口尺寸/状态变化，保持最大化图标与真实状态同步
  useEffect(() => {
    // macOS 走系统红绿灯，不渲染自定义最大化按钮，也就没必要订阅状态
    if (mac) return;

    let cancelled = false;

    // 初次读取
    Window.IsMaximised()
      .then((v) => {
        if (!cancelled) setIsMaximized(v);
      })
      .catch(() => {
        // 运行时不可用 / 权限缺失时静默回退
      });

    // Wails 3 通过事件总线广播窗口生命周期事件。窗口 resize 时会触发
    // `windows.WindowDidResize`（macOS 上是 `windows.WindowDidEndLiveResize`），
    // 在三个平台都用 `windows.WindowDidResize` 做近似订阅 —— Wails 3 在
    // 任何平台都会发这个事件，无需平台分支。
    //
    // 用 Events.On 注册返回 unregister 函数（同步），不需要 await。
    const off = Events.On("windows.WindowDidResize", () => {
      Window.IsMaximised()
        .then((v) => {
          if (!cancelled) setIsMaximized(v);
        })
        .catch(() => {});
    });

    return () => {
      cancelled = true;
      try {
        off?.();
      } catch {
        // Events.On 在某些早期 alpha 版本可能不返回函数；忽略以保证卸载安全
      }
    };
  }, [mac]);

  const onMinimize = () => {
    Window.Minimise().catch((err) => console.error("Minimise failed", err));
  };

  const onToggleMaximize = () => {
    Window.ToggleMaximise().catch((err) =>
      console.error("ToggleMaximise failed", err),
    );
  };

  const onClose = () => {
    Window.Close().catch((err) => console.error("Close failed", err));
  };

  const getWindowButtonStyle = (
    kind: "minimize" | "maximize" | "close",
  ): CSSProperties => {
    const hovered = hoveredButton === kind;
    const pressed = pressedButton === kind;

    // 所有按钮都需要"开洞"避免误触发拖拽
    const base: CSSProperties = { ...NO_DRAG_STYLE };

    if (kind === "close") {
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
    }

    if (pressed) {
      return {
        ...base,
        backgroundColor: "var(--titlebar-btn-active)",
        borderLeftColor: "var(--line)",
        color: "var(--text)",
      };
    }
    if (hovered) {
      return {
        ...base,
        backgroundColor: "var(--titlebar-btn-hover)",
        borderLeftColor: "var(--line)",
        color: "var(--text)",
      };
    }
    return base;
  };

  // Portal 目标：#titlebar-root（见 index.html 注释）。Wails 是纯 CSR，无 SSR，
  // 但保留 typeof document 守卫便于在测试 / 静态分析下不抛错。
  // 拿不到节点时（极端情况）退到 document.body，至少保证 Titlebar 仍可见，
  // 不会因 portal 目标为 null 而整块 Titlebar 静默消失。
  const portalTarget =
    typeof document !== "undefined"
      ? (document.getElementById("titlebar-root") ?? document.body)
      : null;

  const titlebarBody = (
    <div
      className={clsx(
        // fixed 贴顶；z-50 与 Radix Dialog Overlay 同级，但因 #titlebar-root
        // 在 DOM 中位于 #portal-root 之后，同 z 下 Titlebar 总是绘制在上。
        // 不再用 relative —— 改成 fixed 直接占据视口顶部 36px。
        "fixed inset-x-0 top-0 z-50 flex h-9 items-center select-none",
        "border-b border-(--line) bg-(--bg-elev)",
      )}
      // 外层标题栏整体作为拖拽源（CSS 自定义属性会 inherit 到子元素，
      // 子元素是按钮的会显式 no-drag 开洞）。macOS 下额外向右偏移 80px
      // 给原生红绿灯腾位置。
      style={{
        ...DRAG_STYLE,
        ...(mac
          ? { paddingLeft: "var(--titlebar-traffic-lights-inset)" }
          : undefined),
      }}
    >
      {/*
				左侧品牌标识 —— 仅保留 logo（7×7 Z 点阵），不再渲染 "ZPass" 文字。
				logo 与桌面端 appicon (build/appicon.icon/Assets/wails_icon_vector.svg)
				设计同源：7×7 圆点矩阵 + 中部对角线构成字母 Z，呼应 "OTP FEEL"。

				- viewBox 0 0 7 7：每格 1 单位，圆心 (col+0.5, row+0.5)，r=0.45 —— 紧凑
				  几何让 18×18px 渲染下点阵仍清晰可辨。
				- 不画中部浅灰底纹：小尺寸下浅灰会变成视觉噪点，反而损害 Z 字辨识度；
				  大尺寸 appicon 才保留底纹（颗粒底）。
				- fill="currentColor" + 父级 text-(--text)：自动跟随明暗主题（亮主题黑色
				  Z 字，暗主题白色 Z 字），无需切图。
				- 不做交互（无 hover / click），与原品牌标识一致。
			*/}
      <div
        className={clsx(
          "flex h-full items-center pr-2 text-(--text)",
          // macOS 下外层已经用 paddingLeft 让出红绿灯位置，这里不再叠加 pl-3
          mac ? "pl-0" : "pl-3",
        )}
        aria-label="ZPass"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 7 7"
          xmlns="http://www.w3.org/2000/svg"
          role="img"
          aria-hidden="true"
          focusable="false"
        >
          <g fill="currentColor">
            {/* 行 0 / 1：上横（7 列） */}
            <circle cx="0.5" cy="0.5" r="0.45" />
            <circle cx="1.5" cy="0.5" r="0.45" />
            <circle cx="2.5" cy="0.5" r="0.45" />
            <circle cx="3.5" cy="0.5" r="0.45" />
            <circle cx="4.5" cy="0.5" r="0.45" />
            <circle cx="5.5" cy="0.5" r="0.45" />
            <circle cx="6.5" cy="0.5" r="0.45" />
            <circle cx="0.5" cy="1.5" r="0.45" />
            <circle cx="1.5" cy="1.5" r="0.45" />
            <circle cx="2.5" cy="1.5" r="0.45" />
            <circle cx="3.5" cy="1.5" r="0.45" />
            <circle cx="4.5" cy="1.5" r="0.45" />
            <circle cx="5.5" cy="1.5" r="0.45" />
            <circle cx="6.5" cy="1.5" r="0.45" />
            {/* 行 2：对角线右侧 cols 4,5 */}
            <circle cx="4.5" cy="2.5" r="0.45" />
            <circle cx="5.5" cy="2.5" r="0.45" />
            {/* 行 3：对角线中间 cols 3,4 */}
            <circle cx="3.5" cy="3.5" r="0.45" />
            <circle cx="4.5" cy="3.5" r="0.45" />
            {/* 行 4：对角线左侧 cols 2,3 */}
            <circle cx="2.5" cy="4.5" r="0.45" />
            <circle cx="3.5" cy="4.5" r="0.45" />
            {/* 行 5 / 6：下横（7 列） */}
            <circle cx="0.5" cy="5.5" r="0.45" />
            <circle cx="1.5" cy="5.5" r="0.45" />
            <circle cx="2.5" cy="5.5" r="0.45" />
            <circle cx="3.5" cy="5.5" r="0.45" />
            <circle cx="4.5" cy="5.5" r="0.45" />
            <circle cx="5.5" cy="5.5" r="0.45" />
            <circle cx="6.5" cy="5.5" r="0.45" />
            <circle cx="0.5" cy="6.5" r="0.45" />
            <circle cx="1.5" cy="6.5" r="0.45" />
            <circle cx="2.5" cy="6.5" r="0.45" />
            <circle cx="3.5" cy="6.5" r="0.45" />
            <circle cx="4.5" cy="6.5" r="0.45" />
            <circle cx="5.5" cy="6.5" r="0.45" />
            <circle cx="6.5" cy="6.5" r="0.45" />
          </g>
        </svg>
      </div>

      {/* 中央拖拽区 —— 占据剩余空间；双击 Wails 3 原生支持切换最大化 */}
      <div className="h-full flex-1" aria-hidden="true" />

      {/*
				右侧窗口控件 —— 仅 Windows / Linux 渲染。
				macOS 由原生红绿灯负责，这里彻底不画，避免双份控件并存。
				三个按钮均为 46×36 方块，对齐 Windows 11 系统控件尺寸。
				hover / active 使用 Fluent 对齐的专属 token（见 tokens.css）：
				  - 普通按钮：hover=--titlebar-btn-hover，active=--titlebar-btn-active
				  - 关闭按钮：hover=--titlebar-close-hover，active=--titlebar-close-active
				                 前景色切到 --titlebar-close-ink (白)，与系统关闭键一致
			*/}
      {!mac && (
        <div className="flex h-full items-stretch" style={NO_DRAG_STYLE}>
          <button
            type="button"
            onClick={onMinimize}
            onMouseEnter={() => setHoveredButton("minimize")}
            onMouseLeave={() => {
              setHoveredButton((current) =>
                current === "minimize" ? null : current,
              );
              setPressedButton((current) =>
                current === "minimize" ? null : current,
              );
            }}
            onMouseDown={() => setPressedButton("minimize")}
            onMouseUp={() =>
              setPressedButton((current) =>
                current === "minimize" ? null : current,
              )
            }
            title="Minimize"
            aria-label="Minimize window"
            className={clsx(
              "flex h-full w-11.5 items-center justify-center border-l border-transparent",
              "text-(--text-3) transition-[background-color,color,border-color] duration-120",
            )}
            style={getWindowButtonStyle("minimize")}
          >
            <Minus size={14} strokeWidth={1.5} />
          </button>

          <button
            type="button"
            onClick={onToggleMaximize}
            onMouseEnter={() => setHoveredButton("maximize")}
            onMouseLeave={() => {
              setHoveredButton((current) =>
                current === "maximize" ? null : current,
              );
              setPressedButton((current) =>
                current === "maximize" ? null : current,
              );
            }}
            onMouseDown={() => setPressedButton("maximize")}
            onMouseUp={() =>
              setPressedButton((current) =>
                current === "maximize" ? null : current,
              )
            }
            title={isMaximized ? "Restore" : "Maximize"}
            aria-label={isMaximized ? "Restore window" : "Maximize window"}
            className={clsx(
              "flex h-full w-11.5 items-center justify-center border-l border-transparent",
              "text-(--text-3) transition-[background-color,color,border-color] duration-120",
            )}
            style={getWindowButtonStyle("maximize")}
          >
            {isMaximized ? (
              // 还原 —— 两个叠放的方块（简化的系统图标）
              <MaxIcon size={12} strokeWidth={1.5} />
            ) : (
              // 最大化 —— 单方块
              <Square size={12} strokeWidth={1.5} />
            )}
          </button>

          <button
            type="button"
            onClick={onClose}
            onMouseEnter={() => setHoveredButton("close")}
            onMouseLeave={() => {
              setHoveredButton((current) =>
                current === "close" ? null : current,
              );
              setPressedButton((current) =>
                current === "close" ? null : current,
              );
            }}
            onMouseDown={() => setPressedButton("close")}
            onMouseUp={() =>
              setPressedButton((current) =>
                current === "close" ? null : current,
              )
            }
            title="Close"
            aria-label="Close window"
            className={clsx(
              "flex h-full w-11.5 items-center justify-center border-l border-transparent",
              "text-(--text-3) transition-[background-color,color,border-color] duration-120",
            )}
            style={getWindowButtonStyle("close")}
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      {/*
				Grid 占位 —— 保证调用方（AppShell grid row 1）原位仍有 36px 高，
				主内容不会因 Titlebar portal 走后向上跳一行。透明、不可交互、
				不参与拖拽，仅作为布局占位；border/bg 一律不动 —— 视觉上由
				portal 出去的 fixed 标题栏接手贴顶渲染。
			*/}
      <div className="h-9 shrink-0" aria-hidden="true" />
      {portalTarget ? createPortal(titlebarBody, portalTarget) : null}
    </>
  );
}

export default Titlebar;
