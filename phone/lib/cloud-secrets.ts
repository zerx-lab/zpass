// ZPass Phone —— 云同步敏感数据的设备绑定存储（at-rest 加密）
//
// 替代 harmony 的 CloudSecretsHuks.ets：那边用 HUKS AES-256-CBC 把云账户的
// Secret Key + JWT token 加密成 iv‖ciphertext 再落沙箱；这边把同一对秘密交给
// `expo-secure-store`（iOS Keychain / Android Keystore）。SecureStore 本身就是
// **设备绑定**的密文存储，密钥不可导出，所以不需要再手动 AES-CBC —— 直接存
// JSON 明文字符串，由 OS 钥匙串负责落盘加密。
//
// keychainAccessible 用 WHEN_UNLOCKED_THIS_DEVICE_ONLY，与 vault-service.ts 的
// 信任设备 WrapKey 一致：仅本机、解锁后可读，不随 iCloud / 云备份迁移。
//
// 完整性兜底与 harmony 同理：SecureStore 不可用（如部分模拟器）时 save 返回
// false，调用方退化为明文落 CloudStorage 文件；读出的 JSON 损坏则返回 null。

import * as SecureStore from "expo-secure-store";

/* ----------------------------------------------------------------------------
 * SecureStore key —— 进程级常量，沿用 harmony HUKS_ALIAS 命名
 *
 * 仅含 SecureStore 允许的 `[A-Za-z0-9._-]`，避免原生层 key 名校验失败。
 * -------------------------------------------------------------------------- */

const CLOUD_SECRETS_KEY = "zpass.cloud.secrets.v1";

/* ----------------------------------------------------------------------------
 * 明文形态 —— 落 SecureStore 前 JSON.stringify 的对象
 * -------------------------------------------------------------------------- */

export interface CloudSecretsPlain {
  secretKey: string;
  token: string;
}

/* ----------------------------------------------------------------------------
 * 读 / 写 / 删
 * -------------------------------------------------------------------------- */

/**
 * 写入云密钥到 SecureStore。成功返回 true；任何抛错返回 false
 * （调用方退化为明文存进 CloudStorage 文件）。
 */
export async function saveCloudSecrets(s: CloudSecretsPlain): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(CLOUD_SECRETS_KEY, JSON.stringify(s), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取云密钥。无记录返回 null；JSON 损坏返回 null；
 * secretKey / token 非字符串时强制 coerce 为 ''。
 */
export async function loadCloudSecrets(): Promise<CloudSecretsPlain | null> {
  const raw = await SecureStore.getItemAsync(CLOUD_SECRETS_KEY);
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const obj = (parsed ?? {}) as Partial<CloudSecretsPlain>;
  return {
    secretKey: typeof obj.secretKey === "string" ? obj.secretKey : "",
    token: typeof obj.token === "string" ? obj.token : "",
  };
}

/** 删除云密钥（登出时清理）。幂等 —— 不存在 / 平台不支持均静默吞。 */
export async function deleteCloudSecrets(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(CLOUD_SECRETS_KEY);
  } catch {
    // 不存在 / 平台不支持 → 静默吞
  }
}

/** 探测当前平台是否支持 SecureStore（不可用时调用方退化为明文存储）。 */
export async function cloudSecretsSupported(): Promise<boolean> {
  return await SecureStore.isAvailableAsync();
}
