//! 嵌入式 i18n 字符串表（spec/11 § 4）。
//!
//! 两个 locale：`en` / `zh`，编译时 `include_str!` 嵌入。
//!
//! `t(key)` miss 时返回 `key` 本身（与 Go / 前端 i18next 一致），便于尽早发现遗漏。

use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    En,
    Zh,
}

impl Locale {
    /// 用于持久化 / API 序列化。Phase B 当前不持久化，Phase C 接 settings 时使用。
    #[allow(dead_code)]
    pub fn code(self) -> &'static str {
        match self {
            Locale::En => "en",
            Locale::Zh => "zh",
        }
    }

    /// 从字符串还原 locale；未知返回 `En`。Phase C 的 settings 读取磁盘 prefs 时使用。
    #[allow(dead_code)]
    pub fn parse(s: &str) -> Self {
        match s {
            "zh" | "zh-CN" | "zh-Hans" => Locale::Zh,
            _ => Locale::En,
        }
    }
}

const EN_JSON: &str = include_str!("../../locales/en.json");
const ZH_JSON: &str = include_str!("../../locales/zh.json");

fn parse_locale(json: &str) -> HashMap<&'static str, &'static str> {
    // 先解析为 owned HashMap，再把每个 String 用 Box::leak 提为 'static。
    // 进程级别 leak 是可接受的：i18n 表加载一次、永驻进程。
    let raw: HashMap<String, String> =
        serde_json::from_str(json).expect("locale JSON must be a flat string map");
    raw.into_iter()
        .map(|(k, v)| {
            let k: &'static str = Box::leak(k.into_boxed_str());
            let v: &'static str = Box::leak(v.into_boxed_str());
            (k, v)
        })
        .collect()
}

fn en_table() -> &'static HashMap<&'static str, &'static str> {
    static T: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    T.get_or_init(|| parse_locale(EN_JSON))
}

fn zh_table() -> &'static HashMap<&'static str, &'static str> {
    static T: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    T.get_or_init(|| parse_locale(ZH_JSON))
}

/// 查 key 在指定 locale 下的翻译。miss 时返回 `key` 本身（leak 一份 'static 副本）。
pub fn t_in(locale: Locale, key: &str) -> &'static str {
    let table = match locale {
        Locale::En => en_table(),
        Locale::Zh => zh_table(),
    };
    if let Some(s) = table.get(key) {
        return s;
    }
    Box::leak(key.to_string().into_boxed_str())
}

/// 全局当前 locale。Phase B 启动时通过 [`set_current_locale`] 注入。
static CURRENT: OnceLock<std::sync::RwLock<Locale>> = OnceLock::new();

fn current_cell() -> &'static std::sync::RwLock<Locale> {
    CURRENT.get_or_init(|| std::sync::RwLock::new(default_locale()))
}

/// 从环境变量推导默认 locale。
pub fn default_locale() -> Locale {
    if let Ok(lang) = std::env::var("LANG")
        && lang.starts_with("zh")
    {
        return Locale::Zh;
    }
    if let Ok(lang) = std::env::var("LC_ALL")
        && lang.starts_with("zh")
    {
        return Locale::Zh;
    }
    Locale::En
}

pub fn current_locale() -> Locale {
    *current_cell().read().expect("i18n lock poisoned")
}

pub fn set_current_locale(locale: Locale) {
    *current_cell().write().expect("i18n lock poisoned") = locale;
}

/// 用当前 locale 查 key。
pub fn t(key: &str) -> &'static str {
    t_in(current_locale(), key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn en_and_zh_have_identical_keys() {
        let en: HashSet<_> = en_table().keys().collect();
        let zh: HashSet<_> = zh_table().keys().collect();
        let only_en: Vec<_> = en.difference(&zh).collect();
        let only_zh: Vec<_> = zh.difference(&en).collect();
        assert!(
            only_en.is_empty() && only_zh.is_empty(),
            "i18n key 不对齐：only_en={only_en:?}, only_zh={only_zh:?}"
        );
    }

    #[test]
    fn missing_key_returns_self() {
        assert_eq!(t_in(Locale::En, "no.such.key"), "no.such.key");
    }

    #[test]
    fn t_returns_translated_when_present() {
        assert_eq!(t_in(Locale::En, "welcome.create"), "Create a new vault");
        assert_eq!(t_in(Locale::Zh, "welcome.create"), "创建新保险库");
    }

    #[test]
    fn locale_parse_handles_chinese_aliases() {
        assert_eq!(Locale::parse("zh"), Locale::Zh);
        assert_eq!(Locale::parse("zh-CN"), Locale::Zh);
        assert_eq!(Locale::parse("zh-Hans"), Locale::Zh);
        assert_eq!(Locale::parse("fr"), Locale::En);
    }
}
