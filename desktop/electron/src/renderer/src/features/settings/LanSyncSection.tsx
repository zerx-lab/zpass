// LAN 同步 设置区块
//
// 在 Settings → 安全 区域下，提供：
//   - 启停本机 sync server（让别人连过来）
//   - 显示 PIN / IP / port / QR payload（便于对端配对）
//   - 通过"连接其它设备"对话框输入对端 IP+PIN 主动发起同步
//   - 进度展示（fetch / push / merge 阶段）
//   - 冲突列表入口 → 打开冲突解决对话框
//
// 不在此文件实现 QR 扫码（桌面端用户输 IP+PIN 即可；扫码留给 phone 端实现）。

import * as RadixDialog from "@radix-ui/react-dialog";
import {
	AlertTriangle,
	ArrowRightLeft,
	ChevronLeft,
	ChevronRight,
	Circle,
	CircleDot,
	X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import {
  applyMerge,
  connectToSyncServer,
  disconnectSync,
  getSyncStatus,
  resolveConflict,
  type SyncConflict,
  type SyncStatus,
  startSyncServer,
  stopSyncServer,
} from "@/lib/sync-api";

/* ----------------------------------------------------------------------------
 * 主区块
 * -------------------------------------------------------------------------- */

export function LanSyncSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await getSyncStatus();
      setStatus(s);
    } catch (e) {
      // 后端不可达（dev 模式）—— 静默
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
  }, [refresh]);

  const handleStart = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await startSyncServer();
      setStatus(s);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    try {
      await stopSyncServer();
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    await disconnectSync();
    await refresh();
  };

  const serverRunning = status?.serverRunning ?? false;
  const hasConflicts = (status?.conflicts?.length ?? 0) > 0;
  const role = status?.role ?? "";

  return (
    <section className="flex flex-col rounded-xl border border-(--line) bg-(--bg-elev)">
      <header className="flex items-center gap-2.5 border-b border-(--line-soft) px-5 py-4">
        <ArrowRightLeft size={15} strokeWidth={1.5} className="text-(--text-2)" />
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <h2 className="text-[14px] font-semibold text-(--text)">
            {t("settings_section_lan_sync")}
          </h2>
          <p className="text-[12px] text-(--text-3)">
            {t("settings_section_lan_sync_desc")}
          </p>
        </div>
      </header>

      <div className="flex flex-col divide-y divide-(--line-soft)">
        {/* 服务端：启动 / 停止 + PIN/IP 展示 */}
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-center justify-between gap-6">
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="text-[13px] font-medium text-(--text)">
                作为服务端（让别人连过来）
              </span>
              <span className="mt-0.5 text-[11.5px] text-(--text-3)">
                开启后会监听局域网端口，等待对端用 PIN 配对
              </span>
            </div>
            <div className="shrink-0">
              {serverRunning ? (
                <Button onClick={handleStop} disabled={busy} variant="ghost">
                  停止
                </Button>
              ) : (
                <Button onClick={handleStart} disabled={busy}>
                  开启
                </Button>
              )}
            </div>
          </div>

          {serverRunning && status && (
            <div className="flex flex-col gap-2 rounded-lg border border-(--line-soft) bg-(--bg) px-3 py-3">
              <div className="flex items-baseline gap-2 text-[12px] text-(--text-3)">
                <span className="w-14 shrink-0 text-(--text-4)">PIN</span>
                <code className="font-mono text-[15px] font-semibold tracking-[0.3em] text-(--text)">
                  {status.serverPin}
                </code>
              </div>
              <div className="flex items-baseline gap-2 text-[12px] text-(--text-3)">
                <span className="w-14 shrink-0 text-(--text-4)">地址</span>
                <code className="font-mono text-(--text-2)">
                  {(status.serverHosts ?? []).map(
                    (h) => `${h}:${status.serverPort}`,
                  ).join("  ")}
                </code>
              </div>
              <div className="flex items-baseline gap-2 text-[11px] text-(--text-4)">
                <span className="w-14 shrink-0">QR</span>
                <code className="break-all font-mono">{status.qrPayload}</code>
              </div>
            </div>
          )}
        </div>

        {/* 客户端：连接其他设备 */}
        <div className="flex items-center justify-between gap-6 px-5 py-4">
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="text-[13px] font-medium text-(--text)">
              连接其它设备
            </span>
            <span className="mt-0.5 text-[11.5px] text-(--text-3)">
              主动输入对端的 IP 与 PIN 完成配对并拉取同步数据
            </span>
          </div>
          <div className="shrink-0">
            {role === "client" ? (
              <Button onClick={handleDisconnect} variant="ghost">
                断开
              </Button>
            ) : (
              <Button
                onClick={() => setConnectOpen(true)}
                disabled={hasConflicts}
              >
                连接…
              </Button>
            )}
          </div>
        </div>

        {/* 进度 + 冲突摘要 */}
        {status?.progress && status.progress.stage !== "idle" && (
          <div className="flex flex-col gap-2 px-5 py-4">
            <div className="flex items-center justify-between text-[12px]">
              <span className="font-medium text-(--text-2)">
                {progressLabel(status.progress.stage)}
              </span>
              <span className="font-mono text-(--text-3)">
                {status.progress.total > 0
                  ? `${status.progress.processed}/${status.progress.total}`
                  : ""}
              </span>
            </div>
            {status.progress.total > 0 && (
              <div className="h-1.5 overflow-hidden rounded-full bg-(--bg)">
                <div
                  className="h-full rounded-full bg-(--accent) transition-[width] duration-300"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.floor(
                        (status.progress.processed / status.progress.total) * 100,
                      ),
                    )}%`,
                  }}
                />
              </div>
            )}
            {status.progress.message && (
              <div className="text-[11.5px] text-(--text-3)">
                {status.progress.message}
              </div>
            )}
          </div>
        )}

        {/* 冲突待决 —— 高亮卡片确保用户必定看到 */}
        {hasConflicts && (
          <div className="px-5 py-4">
            <div
              className="flex items-center gap-3 rounded-lg border-2 border-(--warn) px-4 py-3"
              style={{
                backgroundColor:
                  "color-mix(in oklab, var(--warn) 8%, transparent)",
              }}
            >
              <AlertTriangle
                size={20}
                strokeWidth={2}
                className="shrink-0 text-(--warn)"
              />
              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="text-[13.5px] font-semibold text-(--text)">
                  {status?.conflicts?.length ?? 0} 项冲突待你决策
                </span>
                <span className="mt-0.5 text-[11.5px] text-(--text-3)">
                  对端正在等待你在此处完成冲突解决后才能继续同步
                </span>
              </div>
              <Button
                onClick={() => setConflictOpen(true)}
                variant="warn"
                size="md"
                className="shrink-0"
              >
                立即解决
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="px-5 py-3 text-[12px] text-(--danger)">{error}</div>
        )}
      </div>

      {connectOpen && (
        <ConnectDialog
          onClose={() => setConnectOpen(false)}
          onConnected={async () => {
            setConnectOpen(false);
            const s = await getSyncStatus();
            setStatus(s);
            if ((s.conflicts?.length ?? 0) > 0) {
              setConflictOpen(true);
            }
          }}
        />
      )}

      {conflictOpen && status?.conflicts && (
        <ConflictResolverDialog
          conflicts={status.conflicts}
          onClose={() => setConflictOpen(false)}
          onDone={async () => {
            setConflictOpen(false);
            await refresh();
          }}
        />
      )}
    </section>
  );
}

/* ----------------------------------------------------------------------------
 * 连接对话框
 * -------------------------------------------------------------------------- */

function ConnectDialog({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => void | Promise<void>;
}) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const baseUrl = `http://${host.trim()}:${port.trim()}`;
      await connectToSyncServer(baseUrl, pin.trim());
      await onConnected();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <RadixDialog.Root open onOpenChange={(o) => !o && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="zpass-backdrop fixed inset-0 z-40" />
        <RadixDialog.Content className="zpass-glass fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-xl p-5">
          <div className="flex items-center justify-between gap-2">
            <RadixDialog.Title className="text-[14px] font-semibold">
              连接到 LAN 同步服务端
            </RadixDialog.Title>
            <RadixDialog.Close asChild>
              <button
                type="button"
                className="text-(--text-4) hover:text-(--text-2)"
              >
                <X size={16} />
              </button>
            </RadixDialog.Close>
          </div>
          <div className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-(--text-3)">IP 地址</span>
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.42"
                className="rounded-md border border-(--line) bg-(--bg) px-2.5 py-1.5 text-[13px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-(--text-3)">端口</span>
              <input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="55432"
                className="rounded-md border border-(--line) bg-(--bg) px-2.5 py-1.5 text-[13px] font-mono"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-(--text-3)">PIN（对端屏幕上显示）</span>
              <input
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="123456"
                maxLength={6}
                className="rounded-md border border-(--line) bg-(--bg) px-2.5 py-1.5 text-center text-[15px] font-mono tracking-[0.3em]"
              />
            </label>
            {error && (
              <div className="text-[12px] text-(--danger)">{error}</div>
            )}
            <div className="mt-2 flex justify-end gap-2">
              <Button onClick={onClose} variant="ghost" disabled={busy}>
                取消
              </Button>
              <Button onClick={handleConnect} disabled={busy || !host || !port || !pin}>
                {busy ? "配对中…" : "配对并同步"}
              </Button>
            </div>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/* ----------------------------------------------------------------------------
 * 冲突解决对话框
 * -------------------------------------------------------------------------- */

function ConflictResolverDialog({
  conflicts,
  onClose,
  onDone,
}: {
  conflicts: SyncConflict[];
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [idx, setIdx] = useState(0);
  const [resolutions, setResolutions] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    conflicts.forEach((c) => {
      // 默认值：suggestedRemote → "remote" 否则 "local"
      map[c.id] = c.suggestedRemote ? "remote" : "local";
    });
    return map;
  });
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = conflicts[idx];
  const allChosen = conflicts.every((c) => resolutions[c.id]);

  const choose = (choice: "local" | "remote" | "duplicate" | "skip") => {
    setResolutions((r) => ({ ...r, [current.id]: choice }));
  };

  const bulkAll = (choice: "local" | "remote" | "skip") => {
    const map: Record<string, string> = {};
    conflicts.forEach((c) => {
      map[c.id] = choice;
    });
    setResolutions(map);
  };

  const applyAll = async () => {
    setApplying(true);
    setError(null);
    try {
      for (const c of conflicts) {
        const r = resolutions[c.id] as
          | "local"
          | "remote"
          | "duplicate"
          | "skip";
        await resolveConflict(c.id, r);
      }
      await applyMerge();
      await onDone();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <RadixDialog.Root open onOpenChange={(o) => !o && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="zpass-backdrop fixed inset-0 z-40" />
        <RadixDialog.Content className="zpass-glass fixed left-1/2 top-1/2 z-50 flex h-[640px] w-[920px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl">
          {/* Header */}
          <header className="flex items-center justify-between gap-2 border-b border-(--line-soft) px-5 py-4">
            <div className="flex flex-col leading-tight">
              <RadixDialog.Title className="text-[14px] font-semibold">
                同步冲突解决 ({idx + 1} / {conflicts.length})
              </RadixDialog.Title>
              <span className="text-[11.5px] text-(--text-3)">
                {kindLabel(current?.kind ?? "")}：选择保留哪一份，或合并为新条目
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => bulkAll("local")}>
                全部用本机
              </Button>
              <Button variant="ghost" onClick={() => bulkAll("remote")}>
                全部用对端
              </Button>
              <Button variant="ghost" onClick={() => bulkAll("skip")}>
                全部跳过
              </Button>
              <RadixDialog.Close asChild>
                <button
                  type="button"
                  className="text-(--text-4) hover:text-(--text-2)"
                >
                  <X size={16} />
                </button>
              </RadixDialog.Close>
            </div>
          </header>

          {/* Body：双栏 diff */}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <ConflictPanel
              title="本机 (Desktop)"
              item={current?.local}
              entry={current?.localManifest}
              selected={resolutions[current?.id] === "local"}
              onSelect={() => choose("local")}
            />
            <div className="w-px shrink-0 bg-(--line-soft)" />
            <ConflictPanel
              title="对端"
              item={current?.remote}
              entry={current?.remoteManifest}
              selected={resolutions[current?.id] === "remote"}
              onSelect={() => choose("remote")}
            />
          </div>

          {/* Footer */}
          <footer className="flex items-center justify-between gap-3 border-t border-(--line-soft) px-5 py-3">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                disabled={idx === 0}
                onClick={() => setIdx((i) => Math.max(0, i - 1))}
                leftIcon={<ChevronLeft size={14} strokeWidth={1.5} />}
              >
                上一条
              </Button>
              <Button
                variant="ghost"
                onClick={() => choose("duplicate")}
                title="作为新条目同时保留两份"
              >
                两份都保留
              </Button>
              <Button
                variant="ghost"
                onClick={() => choose("skip")}
                title="保留本机原状，不写入对端版本"
              >
                跳过
              </Button>
              <Button
                variant="ghost"
                disabled={idx >= conflicts.length - 1}
                onClick={() =>
                  setIdx((i) => Math.min(conflicts.length - 1, i + 1))
                }
                rightIcon={<ChevronRight size={14} strokeWidth={1.5} />}
              >
                下一条
              </Button>
            </div>
            <div className="flex items-center gap-3">
              {error && (
                <span className="text-[11.5px] text-(--danger)">{error}</span>
              )}
              <Button
                disabled={!allChosen || applying}
                onClick={applyAll}
              >
                {applying ? "应用中…" : "应用全部"}
              </Button>
            </div>
          </footer>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/* ----------------------------------------------------------------------------
 * 冲突双栏单侧
 * -------------------------------------------------------------------------- */

function ConflictPanel({
  title,
  item,
  entry,
  selected,
  onSelect,
}: {
  title: string;
  item: SyncConflict["local"];
  entry: SyncConflict["localManifest"];
  selected: boolean;
  onSelect: () => void;
}) {
  if (!entry) {
    return <div className="flex-1 p-5 text-[12px] text-(--text-4)">无</div>;
  }
  return (
    <div
      onClick={onSelect}
      className={
        "flex flex-1 min-w-0 cursor-pointer flex-col overflow-y-auto p-5 transition-colors " +
        // 选中态：brand-soft 底 + 1px brand inset 环（修复原 --accent-bg 幽灵 token
        // 致背景透明，并把 web 味的 ring-2 收到 1px）
        (selected
          ? "bg-(--brand-soft) ring-1 ring-(--brand) ring-inset"
          : "hover:bg-(--bg)")
      }
    >
      <header className="mb-3 flex items-center justify-between">
        <span className="text-[13px] font-semibold">{title}</span>
        {/* 自绘单选点（替换原生 radio，三端一致） */}
        {selected ? (
          <CircleDot size={16} strokeWidth={1.75} className="text-(--brand)" />
        ) : (
          <Circle size={16} strokeWidth={1.75} className="text-(--text-4)" />
        )}
      </header>
      <dl className="flex flex-col gap-2 text-[12px]">
        <Field
          label="ID"
          value={<code className="font-mono text-[10.5px]">{entry.id}</code>}
        />
        <Field
          label="updatedAt"
          value={new Date(entry.updatedAt).toLocaleString()}
        />
        {entry.deletedAt && (
          <Field
            label="deletedAt"
            value={
              <span className="text-(--danger)">
                {new Date(entry.deletedAt).toLocaleString()} (已删除)
              </span>
            }
          />
        )}
        {entry.contentHash && (
          <Field
            label="contentHash"
            value={<code className="font-mono text-[10.5px]">{entry.contentHash}</code>}
          />
        )}
      </dl>
      {item ? (
        <div className="mt-4 flex flex-col gap-2 rounded-lg border border-(--line-soft) bg-(--bg) p-3 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="font-medium text-(--text)">{item.name}</span>
            <span className="rounded-md bg-(--bg-elev) px-1.5 py-0.5 text-[10px] uppercase text-(--text-3)">
              {item.type}
            </span>
          </div>
          {Object.entries(item.fields ?? {})
            .filter(
              ([k, v]) =>
                typeof v === "string" && v && k !== "_customFields",
            )
            .map(([k, v]) => (
              <div
                key={k}
                className="flex items-baseline justify-between gap-3 border-t border-(--line-soft) pt-2"
              >
                <span className="text-(--text-4)">{k}</span>
                <span className="truncate font-mono text-[11px]">
                  {redactSecret(k, String(v))}
                </span>
              </div>
            ))}
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-(--line-soft) bg-(--bg) p-3 text-[12px] text-(--text-4)">
          payload 不可用（条目不存在或解密失败）
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-(--text-4)">{label}</dt>
      <dd className="text-(--text-2)">{value}</dd>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e ?? "unknown error");
}

function progressLabel(stage: string): string {
  switch (stage) {
    case "pairing":
      return "正在配对";
    case "manifest":
      return "拉取目录";
    case "fetch":
      return "拉取条目";
    case "push":
      return "推送条目";
    case "merge":
      return "等待用户解决冲突";
    case "commit":
      return "应用合并";
    case "done":
      return "已完成";
    case "error":
      return "出错";
    default:
      return stage;
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "concurrent_edit":
      return "并发编辑（双方时间戳相同但内容不同）";
    case "divergent_content":
      return "内容分叉（双方都改过）";
    case "delete_vs_edit":
      return "删除 vs 编辑";
    default:
      return "未知冲突";
  }
}

function redactSecret(key: string, value: string): string {
  const lower = key.toLowerCase();
  if (
    lower === "password" ||
    lower === "totp" ||
    lower === "cvv" ||
    lower === "pin" ||
    lower === "seed" ||
    lower === "secret"
  ) {
    return "•".repeat(Math.min(value.length, 8));
  }
  return value.length > 60 ? value.slice(0, 57) + "…" : value;
}
