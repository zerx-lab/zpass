// 保险库导入 / 导出 —— 纯本地文件操作。
//
// 导出格式与 desktop exportservice.go 对齐：顶层 schemaVersion 为
// "zpass-export-v1"，items 直接承载条目数组，便于桌面端 / 移动端互导。

import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";

import type { VaultItem, VaultItemType } from "@/data/vault";

export const EXPORT_SCHEMA = "zpass-export-v1";
const APP_VERSION = "1.0.0";

export interface ExportPayload {
  schemaVersion: string;
  appVersion: string;
  exportedAt: string;
  itemCount: number;
  items: VaultItem[];
}

const VALID_TYPES: VaultItemType[] = [
  "login",
  "card",
  "note",
  "identity",
  "ssh",
  "passkey",
];

/* ----------------------------------------------------------------------------
 * 导出
 * -------------------------------------------------------------------------- */

export interface ExportOutcome {
  /** 是否成功触发系统分享 */
  shared: boolean;
  /** 写入的临时文件路径 */
  path: string;
  itemCount: number;
}

/**
 * 把整库条目写成明文 JSON 文件，并唤起系统分享面板让用户保存 / 发送。
 * 明文备份是用户的明确意图（与 desktop ExportDialog 一致），调用方需先做警告。
 */
export async function exportVault(items: VaultItem[]): Promise<ExportOutcome> {
  const payload: ExportPayload = {
    schemaVersion: EXPORT_SCHEMA,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    itemCount: items.length,
    items,
  };
  const json = JSON.stringify(payload, null, 2);

  const stamp = new Date().toISOString().slice(0, 10);
  const path = `${FileSystem.cacheDirectory}zpass-export-${stamp}.json`;
  await FileSystem.writeAsStringAsync(path, json, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  let shared = false;
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(path, {
      mimeType: "application/json",
      dialogTitle: "导出 ZPass 保险库",
      UTI: "public.json",
    });
    shared = true;
  }
  return { shared, path, itemCount: items.length };
}

/* ----------------------------------------------------------------------------
 * 导入
 * -------------------------------------------------------------------------- */

export type ImportResult =
  | { ok: true; items: VaultItem[]; fileName: string }
  | { ok: false; reason: "cancelled" | "parse_error" | "empty" };

/** 判断一个对象是否像合法的 VaultItem */
function looksLikeItem(o: unknown): o is VaultItem {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return (
    typeof r.name === "string" &&
    typeof r.type === "string" &&
    VALID_TYPES.includes(r.type as VaultItemType)
  );
}

/** 从任意解析结果中提取条目数组（兼容 {items:[]} 与裸数组） */
function extractItems(parsed: unknown): VaultItem[] {
  let raw: unknown[];
  if (Array.isArray(parsed)) {
    raw = parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { items?: unknown }).items)
  ) {
    raw = (parsed as { items: unknown[] }).items;
  } else {
    raw = [];
  }
  return raw.filter(looksLikeItem).map((item) => {
    // 补全 modified，保证后续排序 / 展示不出错
    const it = item as VaultItem;
    return {
      ...it,
      modified: typeof it.modified === "number" ? it.modified : Date.now(),
    };
  });
}

/** 唤起系统文件选择器，读取并解析一个 ZPass 导出文件 */
export async function pickAndParseImport(): Promise<ImportResult> {
  const res = await DocumentPicker.getDocumentAsync({
    type: ["application/json", "text/plain", "*/*"],
    copyToCacheDirectory: true,
  });
  if (res.canceled) return { ok: false, reason: "cancelled" };

  const asset = res.assets[0];
  if (!asset) return { ok: false, reason: "cancelled" };
  try {
    const text = await FileSystem.readAsStringAsync(asset.uri, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    const parsed = JSON.parse(text);
    const items = extractItems(parsed);
    if (items.length === 0) return { ok: false, reason: "empty" };
    return { ok: true, items, fileName: asset.name ?? "import.json" };
  } catch {
    return { ok: false, reason: "parse_error" };
  }
}
