// 保险库导入 / 导出 —— 纯本地文件操作。
//
// 与 desktop exportservice.go 的 envelope 完全 1:1：
//   - 顶层：{ schemaVersion: "zpass-export-v1", exportedAt(unix ms int),
//             appVersion, itemCount, items: ItemPayload[] }
//   - items 元素是 ItemPayload 形（{id, type, name, fields, createdAt,
//     updatedAt, deletedAt?, revision?}），与后端持久化结构一致，所有
//     类型字段都在嵌套的 `fields` map 内。
//
// 旧版 phone 导出（< 2026-05）写的是平铺 VaultItem（字段直接挂在顶层），
// import 时仍保留兼容路径：检测到没有 `fields` map 时把其它键 normalize
// 回 fields；这样用户老备份也能继续读。

import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";

import type { ItemPayload, VaultItemType } from "@/lib/vault-service";

export const EXPORT_SCHEMA = "zpass-export-v1";
const APP_VERSION = "1.0.0";

/** Envelope 与 desktop exportservice.go `exportEnvelope` 字段顺序对齐 */
export interface ExportPayload {
  schemaVersion: string;
  exportedAt: number;
  appVersion: string;
  itemCount: number;
  items: ItemPayload[];
}

/** desktop 端枚举的 7 种条目类型，import 校验用 */
const VALID_TYPES: VaultItemType[] = [
  "login",
  "card",
  "note",
  "identity",
  "ssh",
  "passkey",
  "totp",
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
 *
 * 入参就是 vault-service.listItems() 的原始 ItemPayload，未做任何字段投影，
 * 保证 envelope 与 desktop ExportService.ExportAllToFile 写出的字节序一致
 * （除了 indent 风格 —— 都是两空格）。明文备份是用户的明确意图，调用方
 * 必须先做警告。
 */
export async function exportVault(payloads: ItemPayload[]): Promise<ExportOutcome> {
  const envelope: ExportPayload = {
    schemaVersion: EXPORT_SCHEMA,
    exportedAt: Date.now(),
    appVersion: APP_VERSION,
    itemCount: payloads.length,
    items: payloads,
  };
  const json = JSON.stringify(envelope, null, 2);

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
  return { shared, path, itemCount: payloads.length };
}

/* ----------------------------------------------------------------------------
 * 导入
 * -------------------------------------------------------------------------- */

/** 给 vault-service.importItems 的草稿形：与 ItemPayload 同形但不带 id/时间戳 */
export type ImportDraft = Omit<
  ItemPayload,
  "id" | "createdAt" | "updatedAt" | "revision" | "deletedAt"
>;

export type ImportResult =
  | { ok: true; items: ImportDraft[]; fileName: string }
  | { ok: false; reason: "cancelled" | "parse_error" | "empty" };

/** 旧版 phone 导出的平铺 VaultItem 元数据字段（不进 fields） */
const FLAT_META_KEYS = new Set([
  "id",
  "type",
  "name",
  "modified",
  "createdAt",
  "updatedAt",
  "revision",
  "deletedAt",
  "fields",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * 把任意来源的条目对象 normalize 成 ImportDraft：
 *   - desktop / 新版 phone：已经是 ItemPayload 形，校验 fields 是 object 即可
 *   - 旧版 phone：把除元数据外的 key 收拢进 fields；customFields 落到
 *     `_customFields` 保留键（与 desktop CUSTOM_FIELDS_KEY 一致）
 *
 * 不在这里做字段语义翻译（如 desktop card.expiry ↔ phone card.exp），因为
 * phone 端 vault-context.toVaultItem 已经按 phone 字段名读取；跨端如有字段
 * 命名差异由两端的展示层自行兜底。
 */
function normalizeToDraft(o: unknown): ImportDraft | null {
  if (!isObject(o)) return null;
  const type = o.type;
  const name = o.name;
  if (typeof type !== "string" || !VALID_TYPES.includes(type as VaultItemType)) {
    return null;
  }
  if (typeof name !== "string") return null;

  // 已是 ItemPayload 形：直接取 fields
  if (isObject(o.fields)) {
    return {
      type: type as VaultItemType,
      name,
      fields: { ...(o.fields as Record<string, unknown>) },
    };
  }

  // 旧版平铺 VaultItem：把非元数据字段塞进 fields，customFields 走保留键
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (FLAT_META_KEYS.has(k)) continue;
    if (k === "customFields") {
      if (Array.isArray(v) && v.length > 0) fields._customFields = v;
      continue;
    }
    if (v === undefined || v === null || v === "") continue;
    fields[k] = v;
  }
  return { type: type as VaultItemType, name, fields };
}

/** 从任意解析结果中提取条目数组（兼容 {items:[]} 与裸数组） */
function extractRaw(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isObject(parsed) && Array.isArray(parsed.items)) {
    return parsed.items as unknown[];
  }
  return [];
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
    const raw = extractRaw(parsed);
    const items = raw
      .map(normalizeToDraft)
      .filter((d): d is ImportDraft => d !== null);
    if (items.length === 0) return { ok: false, reason: "empty" };
    return { ok: true, items, fileName: asset.name ?? "import.json" };
  } catch {
    return { ok: false, reason: "parse_error" };
  }
}
