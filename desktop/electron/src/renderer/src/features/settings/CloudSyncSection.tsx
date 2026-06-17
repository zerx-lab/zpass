// 云同步 设置区块
//
// 在 Settings → 安全 分组下，提供：
//   - 云服务连接状态（地址由 lib/cloud-env.ts 解析，用户不可改）
//   - 账户状态展示（未登录 / 已登录 + 邮箱 / accountId / 钥匙串后端）
//   - 空间自动同步状态（1Password 模型:登录后云端 vault ↔ 本地空间自动镜像,
//     无手动绑定;detached 空间提供"重新上云",套餐限额时提示）
//   - 无名旧 vault 的手动绑定兜底（仅在存在此类 vault 时展示）
//   - 立即同步 + 进度展示
//   - 冲突解决对话框（复用 LanSyncSection 的 ConflictResolverDialog UX）

import * as RadixDialog from "@radix-ui/react-dialog";
import {
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleDot,
  Cloud,
  Globe,
  Key,
  ShieldAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import {
  activateRemoteVault,
  applyCloudMerge,
  bindCloudVault,
  createCloudVault,
  listCloudConflicts,
  listLinkedSpaces,
  listRemoteVaults,
  type RemoteVault,
  resolveCloudConflict,
  type SyncConflict,
  signOutCloud,
  syncNow,
} from "@/lib/cloud-api";
import { LOCAL_CLOUD_BASE_URL, PROD_CLOUD_BASE_URL } from "@/lib/cloud-env";
import { translateCloudError } from "@/lib/cloud-errors";
import { useCloudStore } from "@/stores/cloud";
import {
  createSpaceWithoutAutoLink,
  reconcileCloudSpaces,
} from "@/stores/cloud-mirror";
import { useSpacesStore } from "@/stores/spaces";
import { dialogPortalContainer } from "./shared";

/* ----------------------------------------------------------------------------
 * Helper: 错误消息提取
 *
 * state 里存后端原文（英文），展示点统一走 translateCloudError(raw, t)
 * 翻译成当前语言 —— 切换语言后已有错误文案也会实时更新。
 * -------------------------------------------------------------------------- */

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e ?? "unknown error");
}

/* ----------------------------------------------------------------------------
 * 主区块
 * -------------------------------------------------------------------------- */

export function CloudSyncSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const cloudStore = useCloudStore();
  const { status, progress, conflictCount, baseUrl, realtime, revoked } =
    cloudStore;

  const [linkedSpaces, setLinkedSpaces] = useState<string[]>([]);

  const [syncBusy, setSyncBusy] = useState(false);
  const [syncSummary, setSyncSummary] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const [signOutBusy, setSignOutBusy] = useState(false);

  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);

  // dev 模式「开发者 · 云服务地址」快速切换（import.meta.env.DEV 门控展示）
  const [serverInput, setServerInput] = useState("");
  const [serverBusy, setServerBusy] = useState(false);

  // 已配置且已登录时，拉取当前已绑定的空间列表
  const refreshLinked = useCallback(async () => {
    if (!status?.signedIn) return;
    try {
      const list = await listLinkedSpaces();
      setLinkedSpaces(list.map((l) => l.spaceId));
    } catch {
      // 失败时静默；不影响其他操作
    }
  }, [status?.signedIn]);

  // 进设置页时顺手对账一次(幂等、有重入保护),完成后刷新绑定列表
  useEffect(() => {
    if (!status?.signedIn) return;
    void reconcileCloudSpaces().then(refreshLinked);
  }, [status?.signedIn, refreshLinked]);

  useEffect(() => {
    void refreshLinked();
  }, [refreshLinked]);

  // 解析出的 server 地址回填输入框（保存后即时反映新值）
  useEffect(() => {
    setServerInput(baseUrl);
  }, [baseUrl]);

  /* ── 登出 ── */
  const handleSignOut = async () => {
    setSignOutBusy(true);
    try {
      await signOutCloud();
      await cloudStore.refresh();
    } catch {
      // 登出失败不需要提示（状态刷新后 UI 自动更新）
    } finally {
      setSignOutBusy(false);
    }
  };

  /* ── dev：切换云服务地址（持久化 + 重新配置后端 + 刷新）── */
  const handleSetServer = async (url: string) => {
    const target = url.trim();
    if (!target || serverBusy) return;
    setServerBusy(true);
    try {
      await cloudStore.setCloudBaseUrl(target);
    } finally {
      setServerBusy(false);
    }
  };

  /* ── 立即同步 ── */
  const handleSyncNow = async () => {
    setSyncBusy(true);
    setSyncSummary(null);
    setSyncError(null);
    try {
      const summary = await syncNow();
      setSyncSummary(
        t("cloud_sync_done_summary", {
          pulled: summary.pulled,
          pushed: summary.pushed,
        }),
      );
      await cloudStore.refresh();
      // 同步完成后刷新冲突计数
      const list = await listCloudConflicts();
      cloudStore.setConflictCount(list.length);
    } catch (e) {
      setSyncError(messageOf(e));
    } finally {
      setSyncBusy(false);
    }
  };

  /* ── 打开冲突解决对话框 ── */
  const handleOpenConflicts = async () => {
    try {
      const list = await listCloudConflicts();
      setConflicts(list);
      setConflictOpen(true);
    } catch {
      // 拉取失败不打开对话框
    }
  };

  /* ── 进度阶段文案 ── */
  const progressLabel = (stage: string): string => {
    switch (stage) {
      case "pushing":
        return t("cloud_progress_pushing");
      case "pulling":
        return t("cloud_progress_pulling");
      case "conflict":
        return t("cloud_progress_conflict");
      case "done":
        return t("cloud_progress_done");
      case "error":
        return t("cloud_progress_error");
      default:
        return stage;
    }
  };

  /* ── 实时通道状态文案 ── */
  const realtimeLabel = (state: string): string => {
    switch (state) {
      case "connected":
        return t("cloud_realtime_connected");
      case "connecting":
        return t("cloud_realtime_connecting");
      case "reconnecting":
        return t("cloud_realtime_reconnecting");
      default:
        return t("cloud_realtime_offline");
    }
  };

  /* ── 实时通道圆点配色：仅 connected 用正向色，其余保持中性灰 ── */
  const realtimeDotClass = (state: string): string =>
    state === "connected" ? "bg-(--ok)" : "bg-(--text-3)";

  const configured = status?.configured ?? false;
  const signedIn = status?.signedIn ?? false;

  return (
    <section className="flex flex-col rounded-xl border border-(--line) bg-(--bg-elev)">
      {/* 区块头部 */}
      <header className="flex items-center gap-2.5 border-b border-(--line-soft) px-5 py-4">
        <Cloud size={15} strokeWidth={1.5} className="text-(--text-2)" />
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <h2 className="text-[14px] font-semibold text-(--text)">
            {t("cloud_settings_title")}
          </h2>
        </div>
      </header>

      <div className="flex flex-col divide-y divide-(--line-soft)">
        {/* ── dev：开发者云服务地址快速切换（仅 import.meta.env.DEV 展示）── */}
        {import.meta.env.DEV && (
          <div className="flex flex-col gap-2.5 px-5 py-4">
            <div className="flex items-center gap-2">
              <Globe size={13} strokeWidth={1.5} className="text-(--text-3)" />
              <span className="text-[12px] font-semibold text-(--text-2)">
                {t("cloud_dev_server_title")}
              </span>
            </div>
            <input
              type="text"
              value={serverInput}
              onChange={(e) => setServerInput(e.target.value)}
              placeholder="https://..."
              spellCheck={false}
              autoComplete="off"
              disabled={serverBusy}
              aria-label={t("cloud_dev_server_title")}
              className="h-9 w-full rounded-[7px] border border-(--line) bg-(--bg) px-3 font-mono text-[12px] text-(--text) outline-none focus:border-(--text-3)"
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={serverBusy}
                onClick={() => handleSetServer(PROD_CLOUD_BASE_URL)}
                className="flex-1"
              >
                {t("cloud_dev_server_online")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={serverBusy}
                onClick={() => handleSetServer(LOCAL_CLOUD_BASE_URL)}
                className="flex-1"
              >
                {t("cloud_dev_server_local")}
              </Button>
              <Button
                size="sm"
                loading={serverBusy}
                disabled={serverBusy}
                onClick={() => handleSetServer(serverInput)}
                className="flex-1"
              >
                {t("cloud_dev_server_save")}
              </Button>
            </div>
            <span className="truncate font-mono text-[11px] text-(--text-3)">
              {t("cloud_dev_server_current", { url: baseUrl })}
            </span>
          </div>
        )}

        {/* ── 未配置（后端 Configure 失败）：展示解析出的地址 + 连接异常说明 ── */}
        {!configured && (
          <div className="flex items-start gap-2 px-5 py-4 text-[12px] text-(--text-2)">
            <ShieldAlert
              size={14}
              strokeWidth={1.5}
              className="mt-0.5 shrink-0 text-(--text-3)"
            />
            <div className="flex min-w-0 flex-col leading-tight">
              <span>{t("cloud_not_configured_notice")}</span>
              {baseUrl && (
                <span className="mt-0.5 font-mono text-[11px] text-(--text-3)">
                  {baseUrl}
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── 会话被远端吊销横幅（SaaS 侧“退出全部设备” / 改主密码后）── */}
        {revoked && !signedIn && (
          <div className="flex items-start gap-2 bg-(--bg) px-5 py-3 text-[12px] text-(--text-2)">
            <ShieldAlert
              size={14}
              strokeWidth={1.5}
              className="mt-0.5 shrink-0 text-(--text-3)"
            />
            <span>{t("cloud_session_revoked")}</span>
          </div>
        )}

        {/* ── 已配置但未登录：展示登录入口 ── */}
        {configured && !signedIn && (
          <div className="flex items-center justify-between gap-6 px-5 py-4">
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="text-[13px] font-medium text-(--text)">
                {t("cloud_not_signed_in")}
              </span>
              <span className="mt-0.5 text-[11.5px] text-(--text-3)">
                {status?.baseUrl || ""}
              </span>
            </div>
            <Button
              onClick={() =>
                navigate("/signin", {
                  state: { from: location.pathname + location.search },
                })
              }
              className="shrink-0"
            >
              {t("cloud_signin_btn")}
            </Button>
          </div>
        )}

        {/* ── 已登录：账户信息 + 登出 ── */}
        {signedIn && (
          <div className="flex items-center justify-between gap-6 px-5 py-4">
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="text-[13px] font-medium text-(--text)">
                {status?.email ?? ""}
              </span>
              <span className="mt-0.5 font-mono text-[11px] text-(--text-3)">
                {(status?.accountId ?? "").slice(0, 20)}
                {(status?.accountId ?? "").length > 20 ? "…" : ""}
              </span>
              <span className="mt-0.5 text-[10.5px] text-(--text-4)">
                {status?.storeBackend ?? ""}
                {status?.storePersist ? " · " + t("cloud_token_persisted") : ""}
              </span>
              {/* 实时推送通道状态 */}
              <div className="mt-1 flex items-center gap-2 text-[12px] text-(--text-3)">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${realtimeDotClass(realtime)}`}
                />
                <span>{realtimeLabel(realtime)}</span>
              </div>
            </div>
            <Button
              onClick={handleSignOut}
              disabled={signOutBusy}
              loading={signOutBusy}
              variant="ghost"
              className="shrink-0"
            >
              {t("cloud_signout")}
            </Button>
          </div>
        )}

        {/* ── 空间自动同步状态（仅已登录时展示）── */}
        {signedIn && (
          <SpaceMirrorPanel
            linkedSpaceIds={linkedSpaces}
            onChanged={refreshLinked}
          />
        )}

        {/* ── 无名旧云端空间的手动绑定兜底（仅已登录且存在此类 vault 时展示）── */}
        {signedIn && <LegacyVaultsPanel onChanged={refreshLinked} />}

        {/* ── 立即同步（仅已登录时展示）── */}
        {signedIn && (
          <div className="flex flex-col gap-2 px-5 py-4">
            <div className="flex items-center justify-between gap-6">
              <div className="flex min-w-0 flex-col leading-tight">
                <span className="text-[13px] font-medium text-(--text)">
                  {t("cloud_sync_now")}
                </span>
                {syncSummary && (
                  <span className="mt-0.5 text-[11.5px] text-(--text-3)">
                    {syncSummary}
                  </span>
                )}
                {syncError && (
                  <div className="mt-1 flex items-start gap-1.5 text-[11.5px] text-(--text-2)">
                    <ShieldAlert
                      size={12}
                      strokeWidth={1.5}
                      className="mt-0.5 shrink-0 text-(--text-3)"
                    />
                    <span>{translateCloudError(syncError, t)}</span>
                  </div>
                )}
              </div>
              <Button
                onClick={handleSyncNow}
                disabled={syncBusy}
                loading={syncBusy}
                className="shrink-0"
              >
                {t("cloud_sync_now")}
              </Button>
            </div>

            {/* 同步进度条（非 idle 时展示）*/}
            {progress.stage !== "idle" && progress.stage !== "done" && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-[12px]">
                  <span className="font-medium text-(--text-2)">
                    {progressLabel(progress.stage)}
                  </span>
                  <span className="font-mono text-(--text-3)">
                    {progress.total > 0
                      ? `${progress.processed}/${progress.total}`
                      : ""}
                  </span>
                </div>
                {progress.total > 0 && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-(--bg)">
                    <div
                      className="h-full rounded-full bg-(--text-2) transition-[width] duration-300"
                      style={{
                        width: `${Math.min(100, Math.floor((progress.processed / progress.total) * 100))}%`,
                      }}
                    />
                  </div>
                )}
                {progress.error && (
                  <div className="text-[11.5px] text-(--text-3)">
                    {translateCloudError(progress.error, t)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── 冲突解决入口（有冲突时展示）── */}
        {signedIn && conflictCount > 0 && (
          <div className="flex items-center justify-between gap-6 px-5 py-4">
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="text-[13px] font-medium text-(--text)">
                {t("cloud_conflicts_pending", { count: conflictCount })}
              </span>
            </div>
            <Button onClick={handleOpenConflicts} className="shrink-0">
              {t("cloud_resolve_conflicts")}
            </Button>
          </div>
        )}
      </div>

      {/* ── 冲突解决对话框 ── */}
      {conflictOpen && conflicts.length > 0 && (
        <CloudConflictResolverDialog
          conflicts={conflicts}
          onClose={() => setConflictOpen(false)}
          onDone={async () => {
            setConflictOpen(false);
            const list = await listCloudConflicts();
            cloudStore.setConflictCount(list.length);
            setConflicts(list);
            await cloudStore.refresh();
          }}
        />
      )}
    </section>
  );
}

/* ----------------------------------------------------------------------------
 * 空间自动同步面板 —— 1Password 模型
 *   登录后云端 vault ↔ 本地空间自动镜像,这里只展示每个本地空间的同步状态:
 *   - 已同步:绑定到云端 vault
 *   - 已分离(detached):云端 vault 被其他设备删除;数据保留,提供「重新上云」
 *   - 仅本地:自动上云被套餐限额挡住(或暂未对账成功)
 * -------------------------------------------------------------------------- */

function SpaceMirrorPanel({
  linkedSpaceIds,
  onChanged,
}: {
  linkedSpaceIds: string[];
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const spaces = useSpacesStore((s) => s.spaces);
  const mirror = useCloudStore((s) => s.mirror);
  const detachedSpaceIds = useCloudStore((s) => s.detachedSpaceIds);
  const setSpaceDetached = useCloudStore((s) => s.setSpaceDetached);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const linked = new Set(linkedSpaceIds);
  const detached = new Set(detachedSpaceIds);
  const frozen = new Set(mirror.frozenSpaceIds);

  /* 「重新上云」:解除 detached 标记后为该空间新建云端 vault */
  const reupload = async (spaceId: string) => {
    const space = spaces.find((s) => s.id === spaceId);
    if (!space) return;
    setBusyId(spaceId);
    setError(null);
    try {
      await createCloudVault(space.id, space.name, space.glyph, space.tag ?? "");
      setSpaceDetached(space.id, false);
      void syncNow().catch(() => {});
      await onChanged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusyId(null);
    }
  };

  /* 「设为活跃空间」:降级冻结后把该空间换进活跃配额(被挤出的转为冻结) */
  const activate = async (spaceId: string) => {
    setBusyId(spaceId);
    setError(null);
    try {
      const pairs = await listLinkedSpaces();
      const pair = pairs.find((p) => p.spaceId === spaceId);
      if (pair) {
        await activateRemoteVault(pair.vaultId);
        void syncNow().catch(() => {});
        // 重新对账刷新 frozen 标记(服务端是唯一权威)
        await reconcileCloudSpaces();
        await onChanged();
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusyId(null);
    }
  };

  const stateLabel = (id: string): string => {
    if (frozen.has(id)) return t("cloud_mirror_frozen");
    if (linked.has(id)) return t("cloud_mirror_synced");
    if (detached.has(id)) return t("cloud_mirror_detached");
    return t("cloud_mirror_local_only");
  };

  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="text-[13px] font-medium text-(--text)">
            {t("cloud_mirror_title")}
          </span>
          <span className="mt-0.5 text-[11.5px] text-(--text-3)">
            {mirror.running ? t("cloud_mirror_running") : t("cloud_mirror_desc")}
          </span>
        </div>
        {typeof mirror.spaceLimit === "number" && (
          <span className="shrink-0 text-[11.5px] text-(--text-3)">
            {t("cloud_mirror_usage", {
              used: mirror.spaceUsed ?? linkedSpaceIds.length,
              limit: mirror.spaceLimit,
            })}
          </span>
        )}
      </div>

      {frozen.size > 0 && (
        <div className="flex items-start gap-2 text-[12px] text-(--text-2)">
          <ShieldAlert
            size={13}
            strokeWidth={1.5}
            className="mt-0.5 shrink-0 text-(--text-3)"
          />
          <span>{t("cloud_mirror_frozen_hint")}</span>
        </div>
      )}

      {mirror.limitBlocked && (
        <div className="flex items-start gap-2 text-[12px] text-(--text-2)">
          <ShieldAlert
            size={13}
            strokeWidth={1.5}
            className="mt-0.5 shrink-0 text-(--text-3)"
          />
          <span>{t("cloud_mirror_limit")}</span>
        </div>
      )}

      {(error ?? mirror.error) && (
        <div className="flex items-start gap-2 text-[12px] text-(--text-2)">
          <ShieldAlert
            size={13}
            strokeWidth={1.5}
            className="mt-0.5 shrink-0 text-(--text-3)"
          />
          <span>{translateCloudError(error ?? mirror.error ?? "", t)}</span>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {spaces.map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-(--line-soft) bg-(--bg) px-3 py-2.5"
          >
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[12.5px] font-medium text-(--text)">
                {s.name}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-(--text-3)">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    linked.has(s.id) && !frozen.has(s.id) ? "bg-(--ok)" : "bg-(--text-3)"
                  }`}
                />
                {stateLabel(s.id)}
              </span>
            </div>
            {frozen.has(s.id) && (
              <Button
                size="sm"
                onClick={() => void activate(s.id)}
                disabled={busyId === s.id}
                loading={busyId === s.id}
                className="shrink-0"
              >
                {t("cloud_mirror_activate")}
              </Button>
            )}
            {!linked.has(s.id) && detached.has(s.id) && (
              <Button
                size="sm"
                onClick={() => void reupload(s.id)}
                disabled={busyId === s.id}
                loading={busyId === s.id}
                className="shrink-0"
              >
                {t("cloud_mirror_reupload")}
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * 无名旧云端空间兜底 —— meta 未回填(旧版本创建)且未绑定的 vault 无法自动
 * 镜像(没有名字),保留手动绑定;一旦绑定,本设备会自动回填 meta,其他设备
 * 即可自动镜像。没有此类 vault 时整个面板不渲染。
 * -------------------------------------------------------------------------- */

function LegacyVaultsPanel({
  onChanged,
}: {
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const spaces = useSpacesStore((s) => s.spaces);
  const removeIgnoredVault = useCloudStore((s) => s.removeIgnoredVault);

  const [vaults, setVaults] = useState<RemoteVault[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await listRemoteVaults();
      setVaults(all.filter((v) => !v.boundSpaceId && !v.name));
    } catch {
      // 拉取失败时不展示面板即可
      setVaults([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 已绑定到 vault 的本地空间不可再选(1:1 模型)
  const boundSpaceIds = new Set(vaults.map((v) => v.boundSpaceId).filter(Boolean));
  const availableSpaces = spaces.filter((s) => !boundSpaceIds.has(s.id));

  const doBind = async (vaultId: string, spaceId: string) => {
    setBusyId(vaultId);
    setError(null);
    try {
      await bindCloudVault(spaceId, vaultId);
      removeIgnoredVault(vaultId); // 手动绑定 = 用户明确要它,解除忽略
      await refresh();
      await onChanged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusyId(null);
    }
  };

  const bindToNew = async (vaultId: string, name: string) => {
    // 压制自动联动:这个新空间马上要绑到现有 vault,不能再 mint 一个
    const id = createSpaceWithoutAutoLink({ name: name.trim() });
    await doBind(vaultId, id);
  };

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  };

  if (vaults.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="text-[13px] font-medium text-(--text)">
          {t("cloud_legacy_vaults_title")}
        </span>
        <span className="mt-0.5 text-[11.5px] text-(--text-3)">
          {t("cloud_legacy_vaults_desc")}
        </span>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-[12px] text-(--text-2)">
          <ShieldAlert
            size={13}
            strokeWidth={1.5}
            className="mt-0.5 shrink-0 text-(--text-3)"
          />
          <span>{translateCloudError(error, t)}</span>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {vaults.map((v) => (
          <div
            key={v.vaultId}
            className="flex flex-col gap-2 rounded-lg border border-(--line-soft) bg-(--bg) px-3 py-2.5"
          >
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="font-mono text-[11px] text-(--text-2)">
                {v.vaultId.slice(0, 8)}
                <span className="ml-1.5 rounded-sm bg-(--bg-elev) px-1 py-px text-[9.5px] uppercase text-(--text-4)">
                  {v.role}
                </span>
              </span>
              <span className="mt-0.5 text-[11.5px] text-(--text-3)">
                {t("cloud_remote_items", { count: v.itemCount })} ·{" "}
                {t("cloud_remote_created", { date: fmtDate(v.createdAt) })}
              </span>
            </div>
            <RemoteVaultBindControl
              spaces={availableSpaces}
              busy={busyId === v.vaultId}
              onBindExisting={(spaceId) => void doBind(v.vaultId, spaceId)}
              onBindNew={(name) => void bindToNew(v.vaultId, name)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/* 单个未绑定云端 vault 的绑定控件：选已有本地空间，或新建一个再绑定 */
function RemoteVaultBindControl({
  spaces,
  busy,
  onBindExisting,
  onBindNew,
}: {
  spaces: { id: string; name: string }[];
  busy: boolean;
  onBindExisting: (spaceId: string) => void;
  onBindNew: (name: string) => void;
}) {
  const { t } = useTranslation();
  const NEW = "__new__";
  const [choice, setChoice] = useState("");
  const [newName, setNewName] = useState("");
  const isNew = choice === NEW;
  const canBind = isNew ? newName.trim().length > 0 : choice !== "";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
        className="rounded-(--radius) border border-(--line) bg-(--bg-elev) px-2 py-1 text-[12px] text-(--text) focus:border-(--text) focus:outline-none"
      >
        <option value="" disabled>
          {t("cloud_remote_pick_space")}
        </option>
        {spaces.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        <option value={NEW}>{t("cloud_remote_new_space")}</option>
      </select>
      {isNew && (
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t("cloud_remote_new_space_name")}
          className="min-w-0 flex-1 rounded-(--radius) border border-(--line) bg-(--bg-elev) px-2 py-1 text-[12px] text-(--text) placeholder:text-(--text-4) focus:border-(--text) focus:outline-none"
        />
      )}
      <Button
        size="sm"
        disabled={busy || !canBind}
        loading={busy}
        onClick={() => (isNew ? onBindNew(newName) : onBindExisting(choice))}
      >
        {t("cloud_remote_bind")}
      </Button>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * 冲突解决对话框 —— 复用 LanSyncSection 的 ConflictResolverDialog UX，
 * 但调用云端 API（resolveCloudConflict / applyCloudMerge）
 * -------------------------------------------------------------------------- */

function CloudConflictResolverDialog({
  conflicts,
  onClose,
  onDone,
}: {
  conflicts: SyncConflict[];
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [idx, setIdx] = useState(0);
  const [resolutions, setResolutions] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const c of conflicts) {
      // 默认值：suggestedRemote → "remote" 否则 "local"
      map[c.id] = c.suggestedRemote ? "remote" : "local";
    }
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
    for (const c of conflicts) {
      map[c.id] = choice;
    }
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
        await resolveCloudConflict(c.id, r);
      }
      await applyCloudMerge();
      await onDone();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <RadixDialog.Root open onOpenChange={(o) => !o && onClose()}>
      <RadixDialog.Portal container={dialogPortalContainer()}>
        <RadixDialog.Overlay className="zpass-backdrop fixed inset-0 z-40" />
        <RadixDialog.Content
          aria-describedby={undefined}
          className="zpass-glass fixed left-1/2 top-1/2 z-50 flex h-[640px] w-[920px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl"
        >
          {/* Header */}
          <header className="flex items-center justify-between gap-2 border-b border-(--line-soft) px-5 py-4">
            <div className="flex flex-col leading-tight">
              <RadixDialog.Title className="text-[14px] font-semibold">
                {t("cloud_conflict_title", {
                  idx: idx + 1,
                  total: conflicts.length,
                })}
              </RadixDialog.Title>
              <span className="text-[11.5px] text-(--text-3)">
                {kindLabel(current?.kind ?? "")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => bulkAll("local")}
              >
                {t("cloud_conflict_all_local")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => bulkAll("remote")}
              >
                {t("cloud_conflict_all_remote")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => bulkAll("skip")}>
                {t("cloud_conflict_all_skip")}
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
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <ConflictPanel
              title={t("cloud_conflict_local")}
              item={current?.local}
              entry={current?.localManifest}
              selected={resolutions[current?.id] === "local"}
              onSelect={() => choose("local")}
            />
            <div className="w-px shrink-0 bg-(--line-soft)" />
            <ConflictPanel
              title={t("cloud_conflict_remote")}
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
                size="sm"
                disabled={idx === 0}
                onClick={() => setIdx((i) => Math.max(0, i - 1))}
                leftIcon={<ChevronLeft size={14} strokeWidth={1.5} />}
              >
                {t("cloud_conflict_prev")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => choose("duplicate")}
                title={t("cloud_conflict_duplicate_hint")}
              >
                {t("cloud_conflict_duplicate")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => choose("skip")}
                title={t("cloud_conflict_skip_hint")}
              >
                {t("cloud_conflict_skip")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={idx >= conflicts.length - 1}
                onClick={() =>
                  setIdx((i) => Math.min(conflicts.length - 1, i + 1))
                }
                rightIcon={<ChevronRight size={14} strokeWidth={1.5} />}
              >
                {t("cloud_conflict_next")}
              </Button>
            </div>
            <div className="flex items-center gap-3">
              {error && (
                <span className="text-[11.5px] text-(--text-2)">
                  {translateCloudError(error, t)}
                </span>
              )}
              <Button
                disabled={!allChosen || applying}
                onClick={applyAll}
                loading={applying}
              >
                {t("cloud_conflict_apply")}
              </Button>
            </div>
          </footer>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/* ----------------------------------------------------------------------------
 * 冲突双栏单侧 —— 与 LanSyncSection.ConflictPanel 保持一致
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
    return (
      <div className="flex-1 p-5 text-[12px] text-(--text-4)">
        <Key size={13} strokeWidth={1.5} className="mb-1 text-(--text-4)" />
      </div>
    );
  }
  return (
    <div
      onClick={onSelect}
      className={
        "flex min-w-0 flex-1 cursor-pointer flex-col overflow-y-auto p-5 transition-colors " +
        (selected
          ? "bg-(--brand-soft) ring-1 ring-(--brand) ring-inset"
          : "hover:bg-(--bg)")
      }
    >
      <header className="mb-3 flex items-center justify-between">
        <span className="text-[13px] font-semibold">{title}</span>
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
                {new Date(entry.deletedAt).toLocaleString()}
              </span>
            }
          />
        )}
        {entry.contentHash && (
          <Field
            label="contentHash"
            value={
              <code className="font-mono text-[10.5px]">
                {entry.contentHash}
              </code>
            }
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
              ([k, v]) => typeof v === "string" && v && k !== "_customFields",
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
          payload 不可用
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
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
  return value.length > 60 ? `${value.slice(0, 57)}…` : value;
}

export default CloudSyncSection;
