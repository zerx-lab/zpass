// 剪贴板封装 —— 与 phone/lib/clipboard.ts 行为对齐。
//
// 与 desktop writeClipboardEphemeral 同义：copyEphemeral 在 timeoutMs 后若
// 剪贴板内容未变则清空，防止敏感值长期残留。
//
// 触感反馈走 @ohos.vibrator（轻量 12ms 触发），模拟器 / 无马达设备静默忽略。

import { pasteboard } from '@kit.BasicServicesKit';
import { vibrator } from '@kit.SensorServiceKit';

const pb = pasteboard.getSystemPasteboard();

async function lightHaptic(): Promise<void> {
  try {
    await vibrator.startVibration(
      { type: 'time', duration: 12 },
      { id: 0, usage: 'touch' },
    );
  } catch (_e) {
    // 模拟器 / 无马达设备：静默忽略
  }
}

/** 复制文本，并给出轻触感反馈 */
export async function copyText(value: string): Promise<void> {
  const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, value);
  await pb.setData(data);
  await lightHaptic();
}

/**
 * 复制敏感值（密码 / 验证码），timeoutMs 后若剪贴板内容未变则清空。
 * 与 desktop writeClipboardEphemeral / phone copyEphemeral 行为对齐。
 */
export async function copyEphemeral(
  value: string,
  timeoutMs: number = 30_000,
): Promise<void> {
  await copyText(value);
  setTimeout(async () => {
    try {
      const data = await pb.getData();
      const current = data.getPrimaryText();
      if (current === value) {
        const empty = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, '');
        await pb.setData(empty);
      }
    } catch (_e) {
      // 系统剪贴板读取失败时静默忽略
    }
  }, timeoutMs);
}
