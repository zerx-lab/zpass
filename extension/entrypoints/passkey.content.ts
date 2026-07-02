export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  allFrames: true,
  runAt: "document_start",
  world: "MAIN",
  main() {
    installPasskeyProxy();
  }
});

type PasskeyBridgeType = "zpass.passkeyList" | "zpass.passkeyCreate" | "zpass.passkeySign" | "zpass.passkeyChoose";

interface PasskeyDescriptor {
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

interface PasskeyCredentialResult extends PasskeyDescriptor {
  publicKeyCose: string;
  publicKeySpki: string;
  coseAlgorithm: number;
  authenticatorData?: string;
  attestationObject?: string;
}

interface PasskeyAssertionResult {
  itemId: string;
  credentialId: string;
  userId: string;
  authenticatorData: string;
  signature: string;
  signCount: number;
}

interface BridgeResponse<T> {
  source: "zpass-extension";
  channel: "passkey";
  id: string;
  ok: boolean;
  result?: T;
  error?: string;
}

// 桥接超时:list 无用户交互给短超时;choose/create/sign 都含用户交互
// (页面选择对话框 / 创建确认 / 桌面端解锁与审批),15s 会在用户犹豫时
// 超时回退浏览器原生弹窗,与 ZPass 对话框双 UI 叠加 —— 对齐 WebAuthn
// 惯例给 5 分钟。
const REQUEST_TIMEOUT_MS: Record<PasskeyBridgeType, number> = {
  "zpass.passkeyList": 15000,
  "zpass.passkeyChoose": 300000,
  "zpass.passkeyCreate": 300000,
  "zpass.passkeySign": 300000
};
const PASSKEY_ALG_ES256 = -7;

function installPasskeyProxy(): void {
  const container = navigator.credentials;
  if (!container?.create || !container.get) return;

  const originalCreate = container.create.bind(container);
  const originalGet = container.get.bind(container);

  const createProxy: CredentialsContainer["create"] = async (options) => {
    if (!options?.publicKey) return originalCreate(options);
    try {
      return await createZPassCredential(options.publicKey, options.signal);
    } catch (error) {
      if (shouldFallbackToBrowser(error)) {
        return originalCreate(options);
      }
      throw error;
    }
  };

  const getProxy: CredentialsContainer["get"] = async (options) => {
    if (!options?.publicKey) return originalGet(options);
    // conditional mediation(如 Google 首页加载即发起的静默 autofill 请求)
    // 语义是「挂起等用户从浏览器 autofill UI 主动选择」。ZPass 桥目前只有
    // 模态流程:拦截会导致页面一加载就弹选择框/自动签名;失败(桌面端锁定/
    // 用户取消)还会 reject 掉页面的 conditional 请求,杀死整页 passkey
    // 通道 —— 表现为「必须手输用户名点继续才能再触发 passkey」。放行给
    // 浏览器原生实现。
    if (options.mediation === "conditional") return originalGet(options);
    try {
      const credential = await getZPassCredential(options.publicKey, options.signal);
      return credential ?? originalGet(options);
    } catch (error) {
      if (shouldFallbackToBrowser(error)) {
        return originalGet(options);
      }
      throw error;
    }
  };

  Object.defineProperty(container, "create", {
    configurable: true,
    writable: true,
    value: createProxy
  });
  Object.defineProperty(container, "get", {
    configurable: true,
    writable: true,
    value: getProxy
  });
}

async function createZPassCredential(
  publicKey: PublicKeyCredentialCreationOptions,
  signal?: AbortSignal
): Promise<Credential> {
  throwIfAborted(signal);
  if (!publicKey.pubKeyCredParams.some((param) => param.type === "public-key" && param.alg === PASSKEY_ALG_ES256)) {
    throw webAuthnError("NotSupportedError", "ZPass supports ES256 passkeys.");
  }
  if (!publicKey.rp?.name || !publicKey.user?.id || !publicKey.user.name) {
    throw webAuthnError("TypeError", "Passkey registration options are incomplete.");
  }

  const rpId = publicKey.rp.id || window.location.hostname;
  const clientDataJSON = makeClientDataJSON("webauthn.create", publicKey.challenge);
  const created = await sendBridge<PasskeyCredentialResult>("zpass.passkeyCreate", {
    rpId,
    rpName: publicKey.rp.name,
    userId: bufferToBase64Url(publicKey.user.id),
    userName: publicKey.user.name,
    userDisplayName: publicKey.user.displayName,
    name: `${publicKey.rp.name} (${publicKey.user.displayName || publicKey.user.name})`
  });
  throwIfAborted(signal);

  if (!created.attestationObject) {
    throw webAuthnError("UnknownError", "ZPass Desktop did not return an attestation object.");
  }

  const rawId = base64UrlToBuffer(created.credentialId);
  const attestationObject = base64UrlToBuffer(created.attestationObject);
  const publicKeyBytes = base64UrlToBuffer(created.publicKeyCose);
  const authenticatorData = created.authenticatorData ? base64UrlToBuffer(created.authenticatorData) : new ArrayBuffer(0);
  const transports = created.transports.length > 0 ? created.transports : ["internal"];
  const response = {
    clientDataJSON,
    attestationObject,
    getAuthenticatorData: () => cloneBuffer(authenticatorData),
    getPublicKey: () => cloneBuffer(publicKeyBytes),
    getPublicKeyAlgorithm: () => created.coseAlgorithm || PASSKEY_ALG_ES256,
    getTransports: () => [...transports],
    toJSON: () => ({
      clientDataJSON: bufferToBase64Url(clientDataJSON),
      attestationObject: bufferToBase64Url(attestationObject),
      authenticatorData: bufferToBase64Url(authenticatorData),
      publicKey: bufferToBase64Url(publicKeyBytes),
      publicKeyAlgorithm: created.coseAlgorithm || PASSKEY_ALG_ES256,
      transports
    })
  } as AuthenticatorAttestationResponse;

  return makePublicKeyCredential(created.credentialId, rawId, response);
}

async function getZPassCredential(
  publicKey: PublicKeyCredentialRequestOptions,
  signal?: AbortSignal
): Promise<Credential | null> {
  throwIfAborted(signal);
  const rpId = publicKey.rpId || window.location.hostname;
  const choosePayload = { rpId };
  const allowCredentialIds = publicKey.allowCredentials
    ?.filter((descriptor) => descriptor.type === "public-key")
    .map((descriptor) => bufferToBase64Url(descriptor.id));
  if (allowCredentialIds?.length) {
    Object.assign(choosePayload, { allowCredentialIds });
  }
  const credential = await sendBridge<PasskeyDescriptor | null>("zpass.passkeyChoose", choosePayload);
  if (!credential) return null;

  const clientDataJSON = makeClientDataJSON("webauthn.get", publicKey.challenge);
  const clientDataHash = await sha256Base64Url(clientDataJSON);
  const assertion = await sendBridge<PasskeyAssertionResult>("zpass.passkeySign", {
    rpId,
    credentialId: credential.credentialId,
    clientDataHash
  });
  throwIfAborted(signal);

  const rawId = base64UrlToBuffer(assertion.credentialId);
  const authenticatorData = base64UrlToBuffer(assertion.authenticatorData);
  const signature = base64UrlToBuffer(assertion.signature);
  const userHandle = base64UrlToBuffer(assertion.userId);
  const response = {
    clientDataJSON,
    authenticatorData,
    signature,
    userHandle,
    toJSON: () => ({
      clientDataJSON: bufferToBase64Url(clientDataJSON),
      authenticatorData: bufferToBase64Url(authenticatorData),
      signature: bufferToBase64Url(signature),
      userHandle: bufferToBase64Url(userHandle)
    })
  } as AuthenticatorAssertionResponse;

  return makePublicKeyCredential(assertion.credentialId, rawId, response);
}

function makeClientDataJSON(type: "webauthn.create" | "webauthn.get", challenge: BufferSource): ArrayBuffer {
  const payload = {
    type,
    challenge: bufferToBase64Url(challenge),
    origin: window.location.origin,
    crossOrigin: window.top !== window
  };
  return toArrayBuffer(new TextEncoder().encode(JSON.stringify(payload)));
}

function makePublicKeyCredential(
  id: string,
  rawId: ArrayBuffer,
  response: AuthenticatorAttestationResponse | AuthenticatorAssertionResponse
): PublicKeyCredential {
  return {
    id,
    rawId,
    response,
    type: "public-key",
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({}),
    toJSON: () => ({
      id,
      rawId: bufferToBase64Url(rawId),
      response: (response as unknown as { toJSON: () => unknown }).toJSON(),
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {}
    })
  } as PublicKeyCredential;
}

function sendBridge<T>(type: PasskeyBridgeType, payload: unknown): Promise<T> {
  const id = `zpass-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(webAuthnError("NotAllowedError", "ZPass Desktop did not respond."));
    }, REQUEST_TIMEOUT_MS[type]);

    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };

    const onMessage = (event: MessageEvent) => {
      const data = event.data as BridgeResponse<T>;
      if (
        event.source !== window ||
        event.origin !== window.location.origin ||
        !data ||
        data.source !== "zpass-extension" ||
        data.channel !== "passkey" ||
        data.id !== id
      ) {
        return;
      }
      cleanup();
      if (data.ok) {
        resolve(data.result as T);
      } else {
        reject(webAuthnError("NotAllowedError", data.error || "ZPass passkey request failed."));
      }
    };

    window.addEventListener("message", onMessage);
    window.postMessage(
      {
        source: "zpass-page",
        channel: "passkey",
        id,
        type,
        payload
      },
      window.location.origin
    );
  });
}

async function sha256Base64Url(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bufferToBase64Url(digest);
}

function bufferToBase64Url(source: BufferSource): string {
  const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return toArrayBuffer(bytes);
}

function cloneBuffer(buffer: ArrayBuffer): ArrayBuffer {
  return buffer.slice(0);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw webAuthnError("AbortError", "The passkey request was aborted.");
  }
}

function shouldFallbackToBrowser(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "NotSupportedError" ||
    /not connected|not available|native messaging host|No fillable|did not respond/i.test(error.message)
  );
}

function webAuthnError(name: string, message: string): Error {
  try {
    return new DOMException(message, name);
  } catch {
    const error = new Error(message);
    error.name = name;
    return error;
  }
}
