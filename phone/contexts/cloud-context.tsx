// 云同步状态中心 —— cloudService 的 React 适配层
//
// cloudService（lib/cloud-service.ts）是「服务 + 反应式状态合一」的单例：业务逻辑与
// 状态都在它身上，这里只把它的 getState 快照经 useSyncExternalStore 投影成可订阅的
// React 值，并把命令式动作透传出去。必须渲染在 <VaultProvider> 内部（依赖 useVault 的
// refresh 把同步落地的条目刷进 vault UI）。
//
// 解锁/锁定的会话恢复由 vault-context 在 unlock/lock 时直接调 cloudService.onVaultUnlocked/
// onVaultLocked（需要主密码派生 AUK，故由解锁路径传入），这里只兜底冷启动竞态（hydrate
// 完成时若 vault 已解锁则 ensureRestored）。

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  cloudService,
  type CloudPublicState,
  type RemoteVaultInfo,
} from "@/lib/cloud-service";
import type { Entitlements } from "@/lib/cloud-client";

import { useVault } from "./vault-context";

/** 命令式动作（绑定到单例，引用稳定）。 */
export interface CloudActions {
  configure: (baseUrl: string) => void;
  register: (email: string, masterPassword: string) => Promise<string>;
  signIn: (email: string, masterPassword: string, secretKey: string) => Promise<void>;
  restoreSession: (masterPassword: string) => Promise<void>;
  signOut: () => Promise<void>;
  verifySecretKey: (input: string) => boolean;
  clearAllCloudData: () => Promise<void>;
  listRemoteVaults: () => Promise<RemoteVaultInfo[]>;
  createCloudVault: (spaceId: string, name?: string) => Promise<void>;
  bindCloudVault: (spaceId: string, vaultId: string) => Promise<void>;
  unlinkSpace: (spaceId: string) => Promise<void>;
  reuploadSpace: (spaceId: string) => Promise<void>;
  entitlements: () => Promise<Entitlements>;
  activateRemoteVault: (vaultId: string) => Promise<void>;
  syncNow: () => Promise<void>;
  resolveConflict: (localId: string, choice: string) => Promise<void>;
  completeMfa: (code: string) => Promise<void>;
  cancelMfa: () => void;
  dismissSecretKeyBackup: () => void;
  markFreshLocalVault: () => void;
  persistAutoUnlockCredential: (cloudPassword: string) => void;
  ensureRestored: () => Promise<void>;
}

export type CloudContextValue = CloudPublicState & CloudActions;

/** 动作透传（模块级一次绑定；闭包持 cloudService，this 正确，引用稳定）。 */
const cloudActions: CloudActions = {
  configure: (baseUrl) => cloudService.configure(baseUrl),
  register: (email, mp) => cloudService.register(email, mp),
  signIn: (email, mp, sk) => cloudService.signIn(email, mp, sk),
  restoreSession: (mp) => cloudService.restoreSession(mp),
  signOut: () => cloudService.signOut(),
  verifySecretKey: (input) => cloudService.verifySecretKey(input),
  clearAllCloudData: () => cloudService.clearAllCloudData(),
  listRemoteVaults: () => cloudService.listRemoteVaults(),
  createCloudVault: (spaceId, name) => cloudService.createCloudVault(spaceId, name),
  bindCloudVault: (spaceId, vaultId) => cloudService.bindCloudVault(spaceId, vaultId),
  unlinkSpace: (spaceId) => cloudService.unlinkSpace(spaceId),
  reuploadSpace: (spaceId) => cloudService.reuploadSpace(spaceId),
  entitlements: () => cloudService.entitlements(),
  activateRemoteVault: (vaultId) => cloudService.activateRemoteVault(vaultId),
  syncNow: () => cloudService.syncNow(),
  resolveConflict: (localId, choice) => cloudService.resolveConflict(localId, choice),
  completeMfa: (code) => cloudService.completeMfa(code),
  cancelMfa: () => cloudService.cancelMfa(),
  dismissSecretKeyBackup: () => cloudService.dismissSecretKeyBackup(),
  markFreshLocalVault: () => cloudService.markFreshLocalVault(),
  persistAutoUnlockCredential: (pw) => cloudService.persistAutoUnlockCredential(pw),
  ensureRestored: () => cloudService.ensureRestored(),
};

const CloudContext = createContext<CloudContextValue | null>(null);

export function CloudProvider({ children }: { children: ReactNode }) {
  const vault = useVault();
  const state = useSyncExternalStore(cloudService.subscribe, cloudService.getState);

  // 把同步落地的条目刷进 vault UI（cloudService 在 ingest 后回调）。
  useEffect(() => {
    cloudService.registerVaultRefresh(vault.refresh);
  }, [vault.refresh]);

  // 冷启动水合；兜底竞态：hydrate 完成时 vault 已解锁则尝试恢复云会话。
  useEffect(() => {
    let alive = true;
    void cloudService.hydrate().then(() => {
      if (alive && !vault.locked) void cloudService.ensureRestored();
    });
    return () => {
      alive = false;
    };
    // 仅冷启动跑一次；解锁路径由 vault-context.onVaultUnlocked 负责。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<CloudContextValue>(() => ({ ...state, ...cloudActions }), [state]);

  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>;
}

export function useCloud(): CloudContextValue {
  const ctx = useContext(CloudContext);
  if (!ctx) throw new Error("useCloud must be used within <CloudProvider>");
  return ctx;
}
