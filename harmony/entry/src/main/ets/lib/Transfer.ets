// Transfer —— Vault 导入 / 导出
//
// 与 phone/lib/transfer.ts 角色一致：把当前已解锁 vault 的所有 item 导出为
// 明文 JSON（方便迁移到其他密码管理器），或从 JSON 导入。
//
// 安全提示：导出文件是明文！调用方应让用户清楚理解风险。
//
// 文件格式（与 desktop / phone 规范一致）：
// {
//   "schemaVersion": "zpass-export-v1",
//   "exportedAt": <unix ms>,
//   "appVersion": "0.1.0",
//   "itemCount": <n>,
//   "items": [ ItemPayload, ... ]
// }
//
// 导入兼容：
//   - 规范认 schemaVersion;旧版 harmony 曾用 format,保留回退。
//   - 两者都缺失时,只要能解析出 items 数组即放行(与 phone 容错一致)。
//   - 条目支持 ItemPayload 形(fields map)与旧版平铺形(字段散在顶层)。

import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { vaultService, type ItemPayload, type VaultItemType } from './VaultService';
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';

export interface ExportFile {
  schemaVersion: string;
  exportedAt: number;
  appVersion: string;
  itemCount: number;
  items: ItemPayload[];
}

const EXPORT_SCHEMA: string = 'zpass-export-v1';
const APP_VERSION: string = '0.1.0';

const VALID_TYPES: ReadonlySet<string> = new Set<string>([
  'login',
  'card',
  'note',
  'identity',
  'ssh',
  'passkey',
  'totp',
]);

/** 旧版平铺 VaultItem 元数据字段（不进 fields） */
const FLAT_META_KEYS: ReadonlySet<string> = new Set<string>([
  'id',
  'type',
  'name',
  'modified',
  'spaceId',
  'createdAt',
  'updatedAt',
  'revision',
  'deletedAt',
  'fields',
]);

interface ImportDraft {
  type: VaultItemType;
  name: string;
  fields: Record<string, Object>;
}

function asRecord(v: Object | undefined | null): Record<string, Object> | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object') return null;
  if (Array.isArray(v)) return null;
  return v as Record<string, Object>;
}

/** 从解析结果提取条目数组（兼容 {items:[]} 与裸数组） */
function extractItems(parsed: Object): Object[] {
  if (Array.isArray(parsed)) return parsed as Object[];
  const rec = asRecord(parsed);
  if (rec !== null && Array.isArray(rec.items)) return rec.items as Object[];
  return [];
}

/**
 * 把任意来源条目 normalize 成 ImportDraft：
 *   - desktop / 新版 phone / harmony：已是 ItemPayload 形，取 fields。
 *   - 旧版平铺形：把非元数据键收拢进 fields，customFields 落到 _customFields。
 */
function normalizeToDraft(o: Object): ImportDraft | null {
  const rec = asRecord(o);
  if (rec === null) return null;
  const rawType = rec.type;
  const rawName = rec.name;
  if (typeof rawType !== 'string' || !VALID_TYPES.has(rawType as string)) return null;
  if (typeof rawName !== 'string') return null;
  const typeStr = rawType as string;
  const nameStr = (rawName as string).trim();
  if (nameStr.length === 0) return null;

  const fieldsRec = asRecord(rec.fields);
  if (fieldsRec !== null) {
    const copy: Record<string, Object> = JSON.parse('{}') as Record<string, Object>;
    for (const k of Object.keys(fieldsRec)) {
      const val = fieldsRec[k];
      if (val !== undefined && val !== null) copy[k] = val;
    }
    return { type: typeStr as VaultItemType, name: nameStr, fields: copy };
  }

  const fields: Record<string, Object> = JSON.parse('{}') as Record<string, Object>;
  for (const k of Object.keys(rec)) {
    if (FLAT_META_KEYS.has(k)) continue;
    const v = rec[k];
    if (k === 'customFields') {
      if (Array.isArray(v) && (v as Object[]).length > 0) fields._customFields = v;
      continue;
    }
    if (v === undefined || v === null || v === '') continue;
    fields[k] = v;
  }
  return { type: typeStr as VaultItemType, name: nameStr, fields };
}

/* ----------------------------------------------------------------------------
 * 导出
 * -------------------------------------------------------------------------- */

/**
 * 导出当前 vault 的所有 item 为明文 JSON 文件。
 *
 * 流程：
 *  1. vaultService.listItems()
 *  2. JSON.stringify(...)
 *  3. 弹 DocumentViewPicker.save() 让用户选保存位置
 *  4. 把内容写进选中的 fd
 */
export async function exportVaultToFile(context: common.Context): Promise<string> {
  const items = await vaultService.listItems();
  const payload: ExportFile = {
    schemaVersion: EXPORT_SCHEMA,
    exportedAt: Date.now(),
    appVersion: APP_VERSION,
    itemCount: items.length,
    items,
  };
  const text = JSON.stringify(payload, null, 2);

  const documentSaveOptions = new picker.DocumentSaveOptions();
  documentSaveOptions.newFileNames = [`zpass-export-${Date.now()}.json`];
  documentSaveOptions.fileSuffixChoices = ['.json'];
  const documentPicker = new picker.DocumentViewPicker(context);
  const uris = await documentPicker.save(documentSaveOptions);
  if (!uris || uris.length === 0) {
    throw new Error('用户取消保存');
  }
  const fileUri = uris[0];
  const file = await fs.open(
    fileUri,
    fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC,
  );
  try {
    await fs.write(file.fd, text);
  } finally {
    await fs.close(file.fd);
  }
  return fileUri;
}

/* ----------------------------------------------------------------------------
 * 导入
 * -------------------------------------------------------------------------- */

/**
 * 从用户选择的 JSON 文件导入 items。
 *
 * 规则：
 *  - 严格校验 format 字段（zpass-export-v1）
 *  - 每条 item 通过 vaultService.createItem 重新加密入库（生成新 id）
 *  - 返回成功导入的条数
 */
export async function importVaultFromFile(context: common.Context): Promise<number> {
  const documentSelectOptions = new picker.DocumentSelectOptions();
  documentSelectOptions.maxSelectNumber = 1;
  // OHOS 没有显式 mime filter for JSON；让用户自己挑
  const documentPicker = new picker.DocumentViewPicker(context);
  const uris = await documentPicker.select(documentSelectOptions);
  if (!uris || uris.length === 0) {
    throw new Error('未选择文件');
  }
  const fileUri = uris[0];
  const file = await fs.open(fileUri, fs.OpenMode.READ_ONLY);
  let text: string;
  try {
    const stat = await fs.stat(file.fd);
    const buf = new ArrayBuffer(stat.size);
    await fs.read(file.fd, buf);
    text = util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(buf));
  } finally {
    await fs.close(file.fd);
  }

  let parsed: Object;
  try {
    parsed = JSON.parse(text) as Object;
  } catch {
    throw new Error('JSON 解析失败');
  }

  // 声明的 schema：规范认 schemaVersion,回退旧版 harmony 的 format。
  // 仅当声明了且不等于本版本时才拒绝;缺失则容错放行。
  const top = asRecord(parsed);
  const schema = top !== null ? top.schemaVersion : undefined;
  const legacyFormat = top !== null ? top.format : undefined;
  let declared = '';
  if (typeof schema === 'string') {
    declared = schema as string;
  } else if (typeof legacyFormat === 'string') {
    declared = legacyFormat as string;
  }
  if (declared.length > 0 && declared !== EXPORT_SCHEMA) {
    throw new Error(`不支持的文件格式：${declared}`);
  }

  const rawItems = extractItems(parsed);
  if (rawItems.length === 0) {
    throw new Error('文件中没有可导入的条目');
  }

  let imported = 0;
  for (const raw of rawItems) {
    const draft = normalizeToDraft(raw);
    if (draft === null) continue;
    try {
      await vaultService.createItem(draft.type, draft.name, draft.fields);
      imported++;
    } catch (_e) {
      // 单条失败不中断整体
    }
  }
  return imported;
}
