// Transfer —— Vault 导入 / 导出
//
// 与 phone/lib/transfer.ts 角色一致：把当前已解锁 vault 的所有 item 导出为
// 明文 JSON（方便迁移到其他密码管理器），或从 JSON 导入。
//
// 安全提示：导出文件是明文！调用方应让用户清楚理解风险。
//
// 文件格式：
// {
//   "format": "zpass-export-v1",
//   "createdAt": <ms>,
//   "items": [ ItemPayload, ... ]
// }

import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { vaultService, type ItemPayload, type VaultItemType } from './VaultService';
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';

export interface ExportFile {
  format: string;
  createdAt: number;
  items: ItemPayload[];
}

const EXPORT_FORMAT: string = 'zpass-export-v1';

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
    format: EXPORT_FORMAT,
    createdAt: Date.now(),
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

  let parsed: ExportFile;
  try {
    parsed = JSON.parse(text) as ExportFile;
  } catch {
    throw new Error('JSON 解析失败');
  }
  if (!parsed || parsed.format !== EXPORT_FORMAT) {
    throw new Error(`不支持的文件格式：${parsed?.format ?? 'missing'}`);
  }
  if (!Array.isArray(parsed.items)) {
    throw new Error('文件中没有 items 数组');
  }

  let imported = 0;
  for (const it of parsed.items) {
    try {
      if (!it.type || !it.name) continue;
      await vaultService.createItem(
        it.type as VaultItemType,
        it.name,
        it.fields ?? {},
      );
      imported++;
    } catch (_e) {
      // 单条失败不中断整体
    }
  }
  return imported;
}
