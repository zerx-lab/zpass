// 自定义字段 —— 与 desktop 端 `_customFields` 约定保持完全一致
//
// 设计要点（对齐 desktop electron VaultPage）：
//   - 后端 ItemPayload.fields 是 map[string]any，约定保留键 `_customFields`
//     存自定义字段数组，与原生字段彻底解耦
//   - 4 种字段类型对齐 Bitwarden：
//       text     纯文本
//       hidden   遮蔽显示，带 reveal 切换 + 复制按钮
//       boolean  开关
//       linked   下拉选择关联到本条目的某个原生字段（仅展示关联键名）
//   - 编辑器对 customFields 做完整的增删改；提交时序列化回数组
//   - 详情页对未知字段的兜底渲染需排除掉 _customFields 以避免重复显示

import type { VaultItemType } from "@/data/vault";

export type CustomFieldType = "text" | "hidden" | "boolean" | "linked";

export const CUSTOM_FIELD_TYPES: CustomFieldType[] = [
  "text",
  "hidden",
  "boolean",
  "linked",
];

export interface CustomField {
  id: string;
  type: CustomFieldType;
  name: string;
  /** text/hidden 为 string；boolean 为 bool；linked 为关联的原生字段 key（string） */
  value: string | boolean;
}

/** 保留在 fields 里专门存自定义字段数组的键名 */
export const CUSTOM_FIELDS_KEY = "_customFields";

/**
 * 每种条目类型可被 linked 字段引用的原生字段 key 集合
 *
 * 注意：phone 端字段命名与 desktop 略有差异（如 card.cardholder/number/exp/cvv，
 * identity.first/last/email/phone），这里按 phone 端实际 schema 罗列。
 */
export const LINKABLE_FIELDS_BY_TYPE: Record<VaultItemType, string[]> = {
  login: ["username", "password", "totp"],
  card: ["cardholder", "number", "exp", "cvv"],
  note: [],
  identity: ["first", "last", "email", "phone"],
  ssh: ["username", "publicKey", "apiKey"],
  passkey: ["rpId", "userName", "credentialId"],
  totp: ["issuer", "account", "secret"],
};

export function newCustomFieldId(): string {
  // crypto.randomUUID 在 Hermes (React Native) 上不一定可用，使用退化方案
  return `cf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 反序列化：从 fields[_customFields] 解析出 CustomField[]，做一遍格式校验 */
export function parseCustomFields(
  fields: Record<string, unknown> | undefined,
): CustomField[] {
  if (!fields) return [];
  const raw = fields[CUSTOM_FIELDS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: CustomField[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const type = e.type;
    if (
      type !== "text" &&
      type !== "hidden" &&
      type !== "boolean" &&
      type !== "linked"
    ) {
      continue;
    }
    const id =
      typeof e.id === "string" && e.id ? e.id : newCustomFieldId();
    const name = typeof e.name === "string" ? e.name : "";
    let value: string | boolean;
    if (type === "boolean") {
      value = e.value === true;
    } else {
      value = typeof e.value === "string" ? e.value : "";
    }
    out.push({ id, type, name, value });
  }
  return out;
}

/** 序列化：把 CustomField[] 写回 fields，过滤掉空名字段（boolean 例外） */
export function serializeCustomFields(arr: CustomField[]): CustomField[] {
  return arr
    .filter((f) => (f.name ?? "").trim() || f.type === "boolean")
    .map((f) => ({
      id: f.id,
      type: f.type,
      name: f.name,
      value:
        f.type === "boolean"
          ? Boolean(f.value)
          : typeof f.value === "string"
            ? f.value
            : "",
    }));
}

/** 给标签 i18n 时使用的中文名（phone 端目前未引入 i18n，直接硬编码） */
export const CUSTOM_FIELD_TYPE_LABEL: Record<CustomFieldType, string> = {
  text: "文本",
  hidden: "隐藏",
  boolean: "开关",
  linked: "关联",
};

export const CUSTOM_FIELD_TYPE_DESC: Record<CustomFieldType, string> = {
  text: "可见的普通文本",
  hidden: "遮蔽显示，复制时自动清空",
  boolean: "开 / 关 切换",
  linked: "关联到本条目的另一个字段",
};
