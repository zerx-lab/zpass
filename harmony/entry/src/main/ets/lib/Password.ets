// 密码强度评估 —— 与 phone/lib/password.ts 一一对齐。
//
// 仅做评分用途，不依赖生成器配置。SecurityTab / Onboarding 等位置直接调用。
// 剪贴板能力拆分在 lib/Clipboard.ets。

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
