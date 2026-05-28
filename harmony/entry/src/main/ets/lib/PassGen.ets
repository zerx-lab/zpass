import { secureRandomInt } from './Random';

/**
 * 密码生成器核心 —— 与 phone/(tabs)/generator.tsx 对齐
 *
 * 三种模式：password / passphrase / pin
 * 强度估算：基于字符池大小 + 长度算香农熵
 */

export type GenMode = 'password' | 'passphrase' | 'pin';

export interface GenOptions {
  upper: boolean;
  lower: boolean;
  numbers: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
}

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const NUMS = '0123456789';
const SYMS = '!@#$%^&*()_+-=[]{}|;:,.<>?';
const AMBIGUOUS_REGEX = /[Il1O0]/g;

const WORDLIST: string[] = [
  'apple', 'brave', 'cloud', 'dance', 'eagle', 'flame', 'grace', 'heart',
  'ivory', 'jewel', 'karma', 'lemon', 'maple', 'noble', 'ocean', 'pearl',
  'queen', 'river', 'solar', 'tiger', 'ultra', 'vivid', 'water', 'xenon',
  'youth', 'zebra', 'amber', 'blaze', 'crisp', 'delta', 'ember', 'frost',
  'glide', 'haven', 'index', 'jolly', 'knack', 'lunar', 'mango', 'nexus',
  'orbit', 'prism', 'quiet', 'radar', 'sleek', 'trove', 'unity', 'vault',
  'witch', 'xerox', 'yield', 'zonal', 'acorn', 'bloom', 'coral', 'drift',
  'elbow', 'fable', 'glade', 'honey',
];

export function generatePassword(len: number, opts: GenOptions): string {
  let charset = '';
  if (opts.upper) charset += UPPER;
  if (opts.lower) charset += LOWER;
  if (opts.numbers) charset += NUMS;
  if (opts.symbols) charset += SYMS;
  if (charset.length === 0) {
    charset = LOWER + NUMS;
  }
  if (opts.avoidAmbiguous) {
    charset = charset.replace(AMBIGUOUS_REGEX, '');
  }
  // 拒绝采样要求 max <= 256；charset 最大约 88，安全
  let out = '';
  for (let i = 0; i < len; i++) {
    out += charset[secureRandomInt(charset.length)];
  }
  return out;
}

export function generatePassphrase(wordCount: number): string {
  const parts: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    parts.push(WORDLIST[secureRandomInt(WORDLIST.length)]);
  }
  return parts.join('-');
}

export function generatePin(len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += secureRandomInt(10).toString();
  }
  return out;
}

export interface StrengthResult {
  score: number; // 0..100
  label: string;
  entropy: number; // bits
}

export function calcStrength(
  password: string,
  opts: GenOptions,
  mode: GenMode,
): StrengthResult {
  if (password.length === 0) {
    return { score: 0, label: '无', entropy: 0 };
  }

  if (mode === 'passphrase') {
    const poolSize = WORDLIST.length;
    const wordCount = password.split('-').length;
    const entropy = Math.round(wordCount * Math.log2(poolSize));
    const score = Math.min(100, Math.round((entropy / 128) * 100));
    const label = score < 40 ? '较弱' : score < 60 ? '一般' : score < 80 ? '强' : '很强';
    return { score, label, entropy };
  }

  if (mode === 'pin') {
    const entropy = Math.round(password.length * Math.log2(10));
    const score = Math.min(100, Math.round((entropy / 40) * 60));
    return { score, label: score < 50 ? '较弱' : '一般', entropy };
  }

  let poolSize = 0;
  if (opts.lower) poolSize += 26;
  if (opts.upper) poolSize += 26;
  if (opts.numbers) poolSize += 10;
  if (opts.symbols) poolSize += 30;
  if (poolSize === 0) poolSize = 36;

  const entropy = Math.round(password.length * Math.log2(poolSize));
  const score = Math.min(100, Math.round((entropy / 128) * 100));
  const label =
    score < 30 ? '很弱' :
    score < 50 ? '较弱' :
    score < 70 ? '一般' :
    score < 85 ? '强' : '很强';
  return { score, label, entropy };
}
