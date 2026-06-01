// 自定义字段 —— 与 desktop / phone _customFields 对齐
//
// fields 是 ItemFields (Record<string, string>)，_customFields 键的值
// 是 JSON 字符串（一组 CustomField 序列化）。

import type { VaultItemType } from '../model/Vault';
import type { ItemFields } from '../model/Vault';

export type CustomFieldType = 'text' | 'hidden' | 'boolean' | 'linked';

export const CUSTOM_FIELD_TYPES: CustomFieldType[] = ['text', 'hidden', 'boolean', 'linked'];

export interface CustomField {
  id: string;
  type: CustomFieldType;
  name: string;
  /** text/hidden/linked 用此；boolean 用 boolValue */
  value: string;
  boolValue?: boolean;
}

export const CUSTOM_FIELDS_KEY: string = '_customFields';

/** 类型 → 可关联字段；Map 避免 Record 字面量 */
export const LINKABLE_FIELDS_BY_TYPE: Map<VaultItemType, string[]> = new Map<VaultItemType, string[]>([
  ['login', ['username', 'password', 'totp']],
  ['card', ['cardholder', 'number', 'exp', 'cvv']],
  ['note', []],
  ['identity', ['first', 'last', 'email', 'phone']],
  ['ssh', ['username', 'publicKey', 'apiKey']],
  ['passkey', ['rpId', 'userName', 'credentialId']],
  ['totp', ['issuer', 'account', 'secret']],
]);

export function newCustomFieldId(): string {
  return `cf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 反序列化 _customFields */
export function parseCustomFields(fields: ItemFields | undefined): CustomField[] {
  if (!fields) return [];
  // 跨端兼容：本端 _customFields 是 JSON 字符串（ItemFields=Record<string,string>），
  // 而 phone/desktop（fields=map[string]any）写的是原生数组。两种都要能解析，
  // 否则其它端创建的自定义字段在鸿蒙端不可见。
  const rawVal: Object | undefined = fields[CUSTOM_FIELDS_KEY] as Object | undefined;
  let parsed: object[] = [];
  if (Array.isArray(rawVal)) {
    parsed = rawVal as object[];
  } else if (typeof rawVal === 'string' && rawVal) {
    try {
      const tmp = JSON.parse(rawVal) as object;
      if (Array.isArray(tmp)) parsed = tmp as object[];
    } catch (_e) {
      return [];
    }
  } else {
    return [];
  }
  const out: CustomField[] = [];
  for (const entry of parsed) {
    const e = entry as Record<string, string | boolean>;
    const rawType = e.type;
    if (typeof rawType !== 'string') continue;
    if (rawType !== 'text' && rawType !== 'hidden' && rawType !== 'boolean' && rawType !== 'linked') {
      continue;
    }
    const id = typeof e.id === 'string' && e.id ? e.id : newCustomFieldId();
    const name = typeof e.name === 'string' ? e.name : '';
    const cf: CustomField = {
      id,
      type: rawType as CustomFieldType,
      name,
      value: typeof e.value === 'string' ? e.value : '',
    };
    if (rawType === 'boolean') {
      cf.boolValue = e.value === true || e.value === 'true';
    }
    out.push(cf);
  }
  return out;
}

/** 把 CustomField[] 序列化为可塞回 fields 的 JSON 字符串 */
export function serializeCustomFields(arr: CustomField[]): string {
  return JSON.stringify(
    arr
      .filter((f) => (f.name ?? '').trim() || f.type === 'boolean')
      .map((f) => {
        if (f.type === 'boolean') {
          return new SerializedBooleanField(f.id, f.name, !!f.boolValue);
        }
        return new SerializedTextField(f.id, f.type, f.name, f.value ?? '');
      }),
  );
}

class SerializedBooleanField {
  id: string;
  type: string = 'boolean';
  name: string;
  value: boolean;
  constructor(id: string, name: string, value: boolean) {
    this.id = id;
    this.name = name;
    this.value = value;
  }
}

class SerializedTextField {
  id: string;
  type: string;
  name: string;
  value: string;
  constructor(id: string, type: string, name: string, value: string) {
    this.id = id;
    this.type = type;
    this.name = name;
    this.value = value;
  }
}

export const CUSTOM_FIELD_TYPE_LABEL: Map<CustomFieldType, string> = new Map<CustomFieldType, string>([
  ['text', '文本'],
  ['hidden', '隐藏'],
  ['boolean', '开关'],
  ['linked', '关联'],
]);

export const CUSTOM_FIELD_TYPE_DESC: Map<CustomFieldType, string> = new Map<CustomFieldType, string>([
  ['text', '可见的普通文本'],
  ['hidden', '遮蔽显示，复制时自动清空'],
  ['boolean', '开 / 关 切换'],
  ['linked', '关联到本条目的另一个字段'],
]);
