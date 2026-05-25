// 密码生成与强度评估 —— 生成器与详情页共用的单一实现。
//
// 随机来源走 expo-crypto（原生 CSPRNG），不再使用 Math.random。

import { randomBytes } from "./crypto";

function secureRandomInt(max: number): number {
  if (max <= 0) return 0;
  const limit = 256 - (256 % max);
  while (true) {
    const b = randomBytes(1)[0];
    if (b < limit) return b % max;
  }
}

export type GenMode = "password" | "passphrase" | "pin";

export interface GenOptions {
  upper: boolean;
  lower: boolean;
  numbers: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
}

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const NUMS = "0123456789";
const SYMS = "!@#$%^&*()_+-=[]{}|;:,.<>?";

export const WORDLIST = [
  "apple", "brave", "cloud", "dance", "eagle", "flame", "grace", "heart",
  "ivory", "jewel", "karma", "lemon", "maple", "noble", "ocean", "pearl",
  "queen", "river", "solar", "tiger", "ultra", "vivid", "water", "xenon",
  "youth", "zebra", "amber", "blaze", "crisp", "delta", "ember", "frost",
  "glide", "haven", "index", "jolly", "knack", "lunar", "mango", "nexus",
  "orbit", "prism", "quiet", "radar", "sleek", "trove", "unity", "vault",
];

export function generatePassword(len: number, opts: GenOptions): string {
  let charset = "";
  if (opts.upper) charset += UPPER;
  if (opts.lower) charset += LOWER;
  if (opts.numbers) charset += NUMS;
  if (opts.symbols) charset += SYMS;
  if (!charset) charset = LOWER + NUMS;
  if (opts.avoidAmbiguous) charset = charset.replace(/[Il1O0]/g, "");

  return Array.from(
    { length: len },
    () => charset[secureRandomInt(charset.length)],
  ).join("");
}

export function generatePassphrase(wordCount: number): string {
  return Array.from(
    { length: wordCount },
    () => WORDLIST[secureRandomInt(WORDLIST.length)],
  ).join("-");
}

export function generatePin(len: number): string {
  return Array.from({ length: len }, () =>
    secureRandomInt(10).toString(),
  ).join("");
}

/* ----------------------------------------------------------------------------
 * 强度评估
 * -------------------------------------------------------------------------- */

export interface Strength {
  /** 0‥100 */
  score: number;
  label: string;
  /** 估算熵值（bit） */
  entropy: number;
}

/** 对任意密码字符串估算强度（详情页用，无需知道生成选项） */
export function estimateStrength(password: string): Strength {
  if (!password) return { score: 0, label: "无", entropy: 0 };

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
  if (score >= 85) return "很强";
  if (score >= 70) return "强";
  if (score >= 50) return "一般";
  if (score >= 30) return "较弱";
  return "很弱";
}

/** 估算破解时间（粗略文案） */
export function crackTime(score: number): string {
  if (score >= 90) return "数百年";
  if (score >= 75) return "数十年";
  if (score >= 60) return "数月";
  if (score >= 45) return "数天";
  if (score >= 30) return "数小时";
  return "即时";
}
