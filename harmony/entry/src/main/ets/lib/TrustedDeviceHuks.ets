// 信任设备 WrapKey 存储 —— HUKS 占位
//
// 单 class 结构（避免 ArkTS 不识别 discriminated union）：
//   - ok=true 时 key 非空
//   - ok=false 时 reason 描述失败原因，key 为 null
//
// MVP 阶段全部返回 unsupported / absent；后续 Phase 接入 HUKS + userIAM。

export class ReadWrapKeyResult {
  ok: boolean;
  key: Uint8Array | null;
  /** 'absent' = 永久失效（清孤儿）; 'transient' = 用户取消（可重试）; '' = ok=true */
  reason: string;
  constructor(ok: boolean, key: Uint8Array | null, reason: string) {
    this.ok = ok;
    this.key = key;
    this.reason = reason;
  }
}

export async function isTrustedKeystoreSupported(): Promise<boolean> {
  // TODO(harmony-trusted-device): 接入 @kit.UniversalKeystoreKit + @kit.UserAuthenticationKit
  return false;
}

export async function writeTrustedWrapKey(_key: Uint8Array): Promise<void> {
  throw new Error('trusted device not implemented on harmony yet');
}

export async function readTrustedWrapKey(): Promise<ReadWrapKeyResult> {
  return new ReadWrapKeyResult(false, null, 'absent');
}

export async function deleteTrustedWrapKey(): Promise<void> {
  // no-op
}
