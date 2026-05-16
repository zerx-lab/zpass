// 剪贴板封装 —— 统一走 expo-clipboard，附带触感反馈与可选自动清空。

import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";

/** 复制文本，并给出轻触感反馈 */
export async function copyText(value: string): Promise<void> {
  await Clipboard.setStringAsync(value);
  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/**
 * 复制敏感值（密码 / 验证码），在 timeoutMs 后若剪贴板内容未变则清空。
 * 与 desktop writeClipboardEphemeral 行为对齐。
 */
export async function copyEphemeral(
  value: string,
  timeoutMs = 30_000,
): Promise<void> {
  await copyText(value);
  setTimeout(async () => {
    try {
      const current = await Clipboard.getStringAsync();
      if (current === value) await Clipboard.setStringAsync("");
    } catch {
      // 剪贴板读取失败时静默忽略
    }
  }, timeoutMs);
}
