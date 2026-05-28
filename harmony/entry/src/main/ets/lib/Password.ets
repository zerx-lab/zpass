// 密码强度评估与剪贴板复制
//
// 与 phone/lib/password.ts + lib/clipboard.ts 合并：体积都很小，本端合到一个文件。

import { pasteboard } from '@kit.BasicServicesKit';
import { vibrator } from '@kit.SensorServiceKit';

/* ----------------------------------------------------------------------------
 * 密码强度评估（详情页用，无需知道生成选项）
 *
 * 与 phone/lib/password.ts estimateStrength 完全一致。
 * -------------------------------------------------------------------------- */

export interface Strength {
  /** 0..100 */
  score: number;
  label: string;
  /** 估算熵值（bit） */
  entropy: number;
}

export function estimateStrength(password: string): Strength {
  if (!password) return { score: 0, label: '无', entropy: 0 };

  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 30;
  if (pool === 0) pool = 26;

  const entropy = Math.round(password.length * Math.log2(pool));
  const score = Math.min(100, Math.round((entropy / 128) * 100));
  return { score, label: strengthLabel(score), entropy };
}

export function strengthLabel(score: number): string {
  if (score >= 85) return '很强';
  if (score >= 70) return '强';
  if (score >= 50) return '一般';
  if (score >= 30) return '较弱';
  return '很弱';
}

export function crackTime(score: number): string {
  if (score >= 90) return '数百年';
  if (score >= 75) return '数十年';
  if (score >= 60) return '数月';
  if (score >= 45) return '数天';
  if (score >= 30) return '数小时';
  return '即时';
}

/* ----------------------------------------------------------------------------
 * 剪贴板 —— @ohos.pasteboard
 *
 * 与 phone/lib/clipboard.ts 行为对齐：
 *  - copyText: 写入后给一次轻触感反馈
 *  - copyEphemeral: timeout 后若剪贴板内容未变则清空（防长期残留）
 * -------------------------------------------------------------------------- */

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

export async function copyText(value: string): Promise<void> {
  const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, value);
  await pb.setData(data);
  await lightHaptic();
}

/**
 * 复制敏感值；timeoutMs 后若剪贴板内容未变则清空
 *
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
