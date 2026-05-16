export const NATIVE_HOST_NAME = "com.zerx_lab.zpass";

export interface ActiveTabInfo {
  id?: number;
  url?: string;
}

export interface ExtensionRequest {
  type:
    | "zpass.status"
    | "zpass.queryLogins"
    | "zpass.revealLogin"
    | "zpass.fillActiveTab"
    | "zpass.passkeyList"
    | "zpass.passkeyCreate"
    | "zpass.passkeySign"
    | "zpass.passkeyDelete";
  itemId?: string;
  payload?: unknown;
}

export interface ExtensionResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

export interface NativeRequest<TPayload = unknown> {
  id: string;
  type:
    | "status"
    | "queryLogins"
    | "revealLogin"
    | "passkeyList"
    | "passkeyCreate"
    | "passkeySign"
    | "passkeyDelete";
  payload?: TPayload;
}

export interface NativeResponse<TResult = unknown> {
  id: string;
  ok: boolean;
  result?: TResult;
  error?: string;
}

export interface PageContext {
  origin: string;
  url: string;
}

export interface RevealLoginRequest extends PageContext {
  itemId: string;
}

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  itemCount: number;
}

export interface LoginSummary {
  id: string;
  name: string;
  username: string;
  displayUrl: string;
  updatedAt: number;
}

export interface QueryLoginsResult {
  unlocked: boolean;
  origin: string;
  items: LoginSummary[];
}

export interface LoginSecret {
  id: string;
  name: string;
  username: string;
  password: string;
}

export interface PasskeyPageRequest extends PageContext {
  rpId: string;
}

export interface PasskeyListRequest extends PasskeyPageRequest {}

export interface PasskeyDescriptor {
  itemId: string;
  name: string;
  rpId: string;
  rpName: string;
  userId: string;
  userName: string;
  userDisplayName: string;
  credentialId: string;
  transports: string[];
  signCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface PasskeyListResult {
  unlocked: boolean;
  rpId: string;
  items: PasskeyDescriptor[];
}

export interface PasskeyCreatePayload {
  rpId: string;
  rpName?: string;
  userId: string;
  userName: string;
  userDisplayName?: string;
  name?: string;
}

export interface PasskeyCreateRequest extends PageContext, PasskeyCreatePayload {}

export interface PasskeyCredential {
  itemId: string;
  name: string;
  rpId: string;
  rpName: string;
  userId: string;
  userName: string;
  userDisplayName: string;
  credentialId: string;
  publicKeyCose: string;
  publicKeySpki: string;
  algorithm: string;
  coseAlgorithm: number;
  signCount: number;
  transports: string[];
  authenticatorData?: string;
  attestationObject?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PasskeySignPayload {
  rpId: string;
  credentialId: string;
  clientDataHash: string;
}

export interface PasskeySignRequest extends PageContext, PasskeySignPayload {}

export interface PasskeyDeletePayload {
  rpId: string;
  itemId?: string;
  credentialId?: string;
}

export interface PasskeyDeleteRequest extends PageContext, PasskeyDeletePayload {}

export interface PasskeyDeleteResult {
  deleted: boolean;
  itemId: string;
}

export interface PasskeyAssertion {
  itemId: string;
  credentialId: string;
  userId: string;
  authenticatorData: string;
  signature: string;
  signCount: number;
}

export function getHttpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
