//! 跨语言一致性测试：Rust 必须能复现 Go mobilecrypto 的字节级行为
//!
//! Fixture 由 `mobilecrypto/cmd/genfixtures` 生成。重新生成方法：
//!
//! ```sh
//! cd mobilecrypto && go run ./cmd/genfixtures
//! ```
//!
//! 两类断言：
//!   1. KEK：Rust derive_kek 输出 == Go argon2.IDKey 输出（字节级）
//!   2. AEAD：Rust open_aead 能解开 Go SealAEAD 的输出，明文相等

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use cryptocore::{derive_kek, open_aead};
use serde::Deserialize;

#[derive(Deserialize)]
struct KekCase {
    name: String,
    password: String,
    salt_b64: String,
    mem_kib: u32,
    iter: u32,
    par: u32,
    key_len: u32,
    expected_kek_b64: String,
}

#[derive(Deserialize)]
struct AeadCase {
    name: String,
    key_b64: String,
    plaintext_b64: String,
    aad_b64: String,
    sealed_b64: String,
}

#[derive(Deserialize)]
struct Fixtures {
    kek_cases: Vec<KekCase>,
    aead_cases: Vec<AeadCase>,
}

fn load() -> Fixtures {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/cross-validation.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "无法读取 fixture {}: {e}\n请在 mobilecrypto/ 下运行：go run ./cmd/genfixtures",
            path.display()
        )
    });
    serde_json::from_str(&raw).expect("fixture JSON 解析失败")
}

#[test]
fn kek_cases_match_go_byte_for_byte() {
    let fx = load();
    assert!(!fx.kek_cases.is_empty(), "KEK fixture 为空");
    for c in &fx.kek_cases {
        let salt = B64.decode(&c.salt_b64).expect("salt base64");
        let expected = B64.decode(&c.expected_kek_b64).expect("expected base64");
        let got = derive_kek(&c.password, &salt, c.mem_kib, c.iter, c.par, c.key_len)
            .unwrap_or_else(|e| panic!("[{}] derive_kek 失败: {e}", c.name));
        assert_eq!(
            got, expected,
            "[{}] Rust 与 Go Argon2id 输出字节不一致",
            c.name
        );
    }
}

#[test]
fn aead_cases_decrypt_to_expected_plaintext() {
    let fx = load();
    assert!(!fx.aead_cases.is_empty(), "AEAD fixture 为空");
    for c in &fx.aead_cases {
        let key = B64.decode(&c.key_b64).expect("key base64");
        let plaintext = B64.decode(&c.plaintext_b64).expect("plaintext base64");
        let aad = B64.decode(&c.aad_b64).expect("aad base64");
        let sealed = B64.decode(&c.sealed_b64).expect("sealed base64");
        let got = open_aead(&key, &sealed, &aad)
            .unwrap_or_else(|e| panic!("[{}] Rust 解不开 Go SealAEAD 输出: {e}", c.name));
        assert_eq!(got, plaintext, "[{}] 解密明文与 Go 输入不一致", c.name);
    }
}
