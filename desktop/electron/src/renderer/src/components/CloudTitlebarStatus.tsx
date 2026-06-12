// Titlebar 云端连接状态指示器
// ---------------------------------------------------------------------------
// 挂在自定义标题栏左侧品牌标识之后（见 Titlebar.tsx），让用户不进设置页就能
// 一眼看到云同步的健康度：登录失效（被远端吊销 / 管理员禁止登录）、同步失败、
// 待解决冲突、同步中、实时通道连接状态。
//
// 交互：
//   - 默认点击 → syncNow() 触发一次快速同步（同步中禁用防重复触发）。
//   - 登录失效（revoked）点击 → 跳转 /settings/cloud-sync 让用户重新登录
//     （此时 syncNow 必然 401，没有意义）。
//
// 状态全部派生自 useCloudStore —— CloudEventSync 已订阅 cloud:* 事件持续写入
// store（progress / conflictCount / realtime / revoked），这里零订阅、纯读取。
//
// 设计约束（与 Titlebar.tsx / AGENTS.md 对齐）：
//   - 未配置云端或从未登录时彻底不渲染，标题栏保持原样。
//   - 圆点配色仅用语义 token：--danger / --warn / --ok / --text-3。
//   - 圆角档位 5（rounded-[5px]）；文字 11px 走 --text-3，hover 抬到 --text-2。
//   - 指示器自身必须 no-drag 开洞，否则点击会触发窗口拖拽。

import { clsx } from "clsx";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { syncNow } from "@/lib/cloud-api";
import { translateCloudError } from "@/lib/cloud-errors";
import { useCloudStore } from "@/stores/cloud";

/** Punch a hole in the titlebar drag region — same rationale as Titlebar.tsx. */
const NO_DRAG_STYLE: CSSProperties = {
  // @ts-expect-error - vendor-prefixed CSS property not in standard React types
  WebkitAppRegion: "no-drag",
};

type Severity = "danger" | "warn" | "busy" | "neutral" | "ok";

const DOT_CLASS: Record<Severity, string> = {
  danger: "bg-(--danger)",
  warn: "bg-(--warn)",
  busy: "bg-(--ok) animate-pulse",
  neutral: "bg-(--text-3)",
  ok: "bg-(--ok)",
};

export function CloudTitlebarStatus() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const status = useCloudStore((s) => s.status);
  const progress = useCloudStore((s) => s.progress);
  const conflictCount = useCloudStore((s) => s.conflictCount);
  const realtime = useCloudStore((s) => s.realtime);
  const revoked = useCloudStore((s) => s.revoked);

  // 未配置云端、或既未登录也没有失效会话需要提示 —— 不渲染，标题栏保持原样。
  if (!status?.configured) return null;
  if (!status.signedIn && !revoked) return null;

  const syncing = progress.stage === "pushing" || progress.stage === "pulling";

  // 状态优先级（高 → 低）：登录失效 > 同步失败 > 冲突 > 同步中 > 实时通道。
  let severity: Severity;
  let label: string;
  let tooltip: string;
  if (revoked) {
    severity = "danger";
    label = t("cloud_titlebar_revoked");
    tooltip = t("cloud_session_revoked");
  } else if (progress.stage === "error") {
    severity = "danger";
    label = t("cloud_titlebar_error");
    tooltip = progress.error
      ? `${t("cloud_titlebar_error")}: ${translateCloudError(progress.error, t)}`
      : t("cloud_titlebar_error");
  } else if (conflictCount > 0) {
    severity = "warn";
    label = t("cloud_titlebar_conflicts", { count: conflictCount });
    tooltip = t("cloud_titlebar_click_to_sync");
  } else if (syncing) {
    severity = "busy";
    label = t("cloud_titlebar_syncing");
    tooltip = t("cloud_titlebar_syncing");
  } else if (realtime === "connecting" || realtime === "reconnecting") {
    severity = "neutral";
    label = t("cloud_titlebar_connecting");
    tooltip = t("cloud_titlebar_click_to_sync");
  } else if (realtime === "offline") {
    severity = "neutral";
    label = t("cloud_titlebar_offline");
    tooltip = t("cloud_titlebar_click_to_sync");
  } else {
    severity = "ok";
    label = t("cloud_titlebar_synced");
    tooltip = status.email
      ? `${status.email} — ${t("cloud_titlebar_click_to_sync")}`
      : t("cloud_titlebar_click_to_sync");
  }

  const onClick = () => {
    if (revoked) {
      // 会话已失效，同步必然 401 —— 直接带用户去云同步设置重新登录。
      navigate("/settings/cloud-sync");
      return;
    }
    if (syncing) return;
    // 进度 / 失败 / 完成统一由 cloud:sync:* 事件经 CloudEventSync 回写 store；
    // 本地 catch 仅防 unhandled rejection。
    syncNow().catch(() => {});
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={syncing}
      title={tooltip}
      aria-label={label}
      className={clsx(
        "flex h-6 items-center gap-1.5 rounded-[5px] px-2",
        "text-[11px] text-(--text-3) transition-colors duration-120",
        syncing
          ? "cursor-default"
          : "hover:bg-(--titlebar-btn-hover) hover:text-(--text-2)",
      )}
      style={NO_DRAG_STYLE}
    >
      <span
        className={clsx(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          DOT_CLASS[severity],
        )}
      />
      <span className="max-w-44 truncate">{label}</span>
    </button>
  );
}

export default CloudTitlebarStatus;
