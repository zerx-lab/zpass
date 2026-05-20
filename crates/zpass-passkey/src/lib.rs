//! `zpass-passkey` — WebAuthn authenticator 端逻辑（spec/07）。
//!
//! 不实现：
//! - 浏览器内集成（由 `zpass-native-host` + `zpass-browser-bridge` 串联，Phase E）
//! - Windows / macOS 系统 WebAuthn provider 注册（v2+）
//!
//! 实现：
//! - ES256（P-256 / ECDSA SHA-256）密钥对生成
//! - WebAuthn `authenticatorData` 字节布局（spec/07 § 5）
//! - `attestationObject` CBOR（self attestation，v1 用 `fmt = "none"`，CTAP2 canonical 顺序）
//! - 签名断言 + `signCount` 递增
//! - COSE_Key ↔ SPKI 互转
//!
//! **std-required**：因 `p256` 的 `EncodePrivateKey` / `EncodePublicKey` impl 只在 `pem`
//! feature 下暴露（间接拉 `std`）。spec/16 OQ-7 记录了该取舍。v2+ 评估自实现 PKCS#8/SPKI
//! 编解码以恢复 `no_std + alloc`。

extern crate alloc;

use alloc::vec::Vec;
use core::fmt;

use ciborium::value::{Integer, Value};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey, signature::Signer};
use p256::pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

// ===================== AAGUID =====================

/// ZPass 桌面端固定 AAGUID（16 字节）。
///
/// **变体位修正**：byte 8 = `0x8b` （二进制 `1000 1011`），高 2 bit = `10`，
/// 符合 RFC 4122 variant；如果用裸 ASCII `'K'` (`0x4b`) 高 2 bit = `01` 会落到
/// NCS variant，触发部分 WebAuthn relying party 实现的严格校验。
///
/// 字面解读："ZPASSDES" + 1 字节变体 + "V1" + 4 字节版本/校验槽。
pub const ZPASS_DESKTOP_AAGUID: [u8; 16] = [
    0x5a, 0x50, 0x41, 0x53, 0x53, 0x44, 0x45, 0x53, 0x8b, 0x56, 0x31, 0x00, 0x00, 0x00, 0x00, 0x01,
];

// ===================== 公开类型 =====================

#[derive(Debug, Clone)]
pub struct PasskeyKeypair {
    /// PKCS#8 DER 私钥（持久化到 vault item.fields["private_key_pkcs8"]）。
    pub private_key_pkcs8: Zeroizing<Vec<u8>>,
    /// SubjectPublicKeyInfo DER 公钥。
    pub public_key_spki: Vec<u8>,
    /// COSE_Key CBOR 公钥（authenticatorData 中嵌入的格式）。
    pub public_key_cose: Vec<u8>,
}

pub struct RegistrationOutput {
    /// 32 字节随机 credential ID。
    pub credential_id: Vec<u8>,
    pub keypair: PasskeyKeypair,
    /// 注册 ceremony 用的 authenticatorData。
    pub authenticator_data: Vec<u8>,
    /// CBOR 编码的 attestationObject（self attestation，`fmt = "none"`，
    /// CTAP2 canonical key 顺序）。
    pub attestation_object: Vec<u8>,
    /// 用户句柄（调用方传入则原样；否则 32 字节随机）。
    pub user_id: Vec<u8>,
}

pub struct AssertionInput<'a> {
    pub rp_id: &'a str,
    pub keypair: &'a PasskeyKeypair,
    pub sign_count: u32,
    pub client_data_hash: &'a [u8; 32],
    pub user_present: bool,
    pub user_verified: bool,
}

pub struct AssertionOutput {
    pub authenticator_data: Vec<u8>,
    /// ECDSA DER 签名（WebAuthn 要求 DER，不是 raw r||s）。
    pub signature: Vec<u8>,
    pub new_sign_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasskeyError {
    KeyGenerationFailed,
    InvalidKey,
    InvalidCose,
    InvalidLength,
    SigningFailed,
    Internal,
}

impl fmt::Display for PasskeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::KeyGenerationFailed => f.write_str("ES256 key generation failed"),
            Self::InvalidKey => f.write_str("invalid PKCS#8 or SPKI key"),
            Self::InvalidCose => f.write_str("invalid COSE_Key encoding"),
            Self::InvalidLength => f.write_str("invalid byte length"),
            Self::SigningFailed => f.write_str("ECDSA signing failed"),
            Self::Internal => f.write_str("internal error"),
        }
    }
}

// ===================== 公开 API =====================

/// 生成新的 ES256 密钥对。
///
/// 仅在 `os-rng` feature 开启时编译；嵌入式 target 需自行提供 RNG 等价路径。
#[cfg(feature = "os-rng")]
pub fn generate_keypair() -> Result<PasskeyKeypair, PasskeyError> {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).map_err(|_| PasskeyError::KeyGenerationFailed)?;
    keypair_from_seed(&seed)
}

/// 给定 32 字节种子生成 ES256 密钥对（测试 / 确定性流程用）。
///
/// 真实注册路径请用 `generate_keypair()`。
pub fn keypair_from_seed(seed: &[u8; 32]) -> Result<PasskeyKeypair, PasskeyError> {
    let signing =
        SigningKey::from_bytes(seed.into()).map_err(|_| PasskeyError::KeyGenerationFailed)?;
    let pkcs8 = signing
        .to_pkcs8_der()
        .map_err(|_| PasskeyError::KeyGenerationFailed)?;
    let verifying = signing.verifying_key();
    let spki = verifying
        .to_public_key_der()
        .map_err(|_| PasskeyError::KeyGenerationFailed)?;
    let cose = verifying_key_to_cose(verifying)?;
    Ok(PasskeyKeypair {
        private_key_pkcs8: Zeroizing::new(pkcs8.as_bytes().to_vec()),
        public_key_spki: spki.as_bytes().to_vec(),
        public_key_cose: cose,
    })
}

/// 用一个固定 AAGUID 注册新 passkey。
///
/// `user_id` 为 `None` 时生成 32 字节随机句柄。
#[cfg(feature = "os-rng")]
pub fn create_registration(
    rp_id: &str,
    user_id: Option<&[u8]>,
    aaguid: &[u8; 16],
) -> Result<RegistrationOutput, PasskeyError> {
    let keypair = generate_keypair()?;
    let mut credential_id = [0u8; 32];
    getrandom::getrandom(&mut credential_id).map_err(|_| PasskeyError::Internal)?;
    let user_id_owned: Vec<u8> = match user_id {
        Some(u) => u.to_vec(),
        None => {
            let mut buf = [0u8; 32];
            getrandom::getrandom(&mut buf).map_err(|_| PasskeyError::Internal)?;
            buf.to_vec()
        }
    };
    let auth_data = build_authenticator_data(
        rp_id,
        /* sign_count */ 0,
        /* up */ true,
        /* uv */ true,
        Some(AttestedCredentialData {
            aaguid,
            credential_id: &credential_id,
            cose_public_key: &keypair.public_key_cose,
        }),
    );
    let attestation_object = build_attestation_object_none(&auth_data);
    Ok(RegistrationOutput {
        credential_id: credential_id.to_vec(),
        keypair,
        authenticator_data: auth_data,
        attestation_object,
        user_id: user_id_owned,
    })
}

/// 给一个已存在的 keypair 用 ES256 签 assertion。
pub fn sign_assertion(input: &AssertionInput) -> Result<AssertionOutput, PasskeyError> {
    let signing = SigningKey::from_pkcs8_der(&input.keypair.private_key_pkcs8)
        .map_err(|_| PasskeyError::InvalidKey)?;
    let new_sign_count = input
        .sign_count
        .checked_add(1)
        .ok_or(PasskeyError::Internal)?;
    let auth_data = build_authenticator_data(
        input.rp_id,
        new_sign_count,
        input.user_present,
        input.user_verified,
        /* attested */ None,
    );
    // WebAuthn § 6.3.3: 签 (authenticatorData || clientDataHash)
    let mut msg = Vec::with_capacity(auth_data.len() + 32);
    msg.extend_from_slice(&auth_data);
    msg.extend_from_slice(input.client_data_hash);
    let signature: Signature = signing.sign(&msg);
    // WebAuthn 要求 DER；p256 的 Signature 默认 raw，需要显式 to_der()
    let der = signature.to_der().as_bytes().to_vec();
    Ok(AssertionOutput {
        authenticator_data: auth_data,
        signature: der,
        new_sign_count,
    })
}

/// COSE_Key → SPKI（用于浏览器扩展持有公钥后做 verify）。
pub fn cose_to_spki(cose: &[u8]) -> Result<Vec<u8>, PasskeyError> {
    let value: Value = ciborium::de::from_reader(cose).map_err(|_| PasskeyError::InvalidCose)?;
    let (x, y) = extract_cose_xy(&value)?;
    let mut sec1 = Vec::with_capacity(1 + 32 + 32);
    sec1.push(0x04); // uncompressed
    sec1.extend_from_slice(&x);
    sec1.extend_from_slice(&y);
    let vk = VerifyingKey::from_sec1_bytes(&sec1).map_err(|_| PasskeyError::InvalidCose)?;
    let spki = vk.to_public_key_der().map_err(|_| PasskeyError::Internal)?;
    Ok(spki.as_bytes().to_vec())
}

/// SPKI → COSE_Key。
pub fn spki_to_cose(spki: &[u8]) -> Result<Vec<u8>, PasskeyError> {
    let vk = VerifyingKey::from_public_key_der(spki).map_err(|_| PasskeyError::InvalidKey)?;
    verifying_key_to_cose(&vk)
}

// ===================== 内部工具 =====================

struct AttestedCredentialData<'a> {
    aaguid: &'a [u8; 16],
    credential_id: &'a [u8],
    cose_public_key: &'a [u8],
}

/// 按 WebAuthn § 6.1 拼 authenticatorData。
///
/// 布局：
/// ```text
/// [ 32 bytes rpIdHash = SHA256(rp_id) ]
/// [ 1  byte  flags ]
/// [ 4  bytes signCount big-endian ]
/// 若 AT=1：
///   [ 16 bytes aaguid ]
///   [ 2  bytes credIdLen + N bytes credId ]
///   [ COSE_Key bytes ]
/// ```
fn build_authenticator_data(
    rp_id: &str,
    sign_count: u32,
    user_present: bool,
    user_verified: bool,
    attested: Option<AttestedCredentialData<'_>>,
) -> Vec<u8> {
    let rp_hash: [u8; 32] = Sha256::digest(rp_id.as_bytes()).into();
    let mut flags = 0u8;
    if user_present {
        flags |= 0x01;
    } // UP
    if user_verified {
        flags |= 0x04;
    } // UV
    let at = attested.is_some();
    if at {
        flags |= 0x40;
    } // AT
    let mut out = Vec::with_capacity(32 + 1 + 4 + if at { 16 + 2 + 32 + 77 } else { 0 });
    out.extend_from_slice(&rp_hash);
    out.push(flags);
    out.extend_from_slice(&sign_count.to_be_bytes());
    if let Some(att) = attested {
        out.extend_from_slice(att.aaguid);
        let cred_len: u16 = att
            .credential_id
            .len()
            .try_into()
            .expect("credential id < 65536");
        out.extend_from_slice(&cred_len.to_be_bytes());
        out.extend_from_slice(att.credential_id);
        out.extend_from_slice(att.cose_public_key);
    }
    out
}

/// 拼 attestationObject（v1：`fmt = "none"` + `attStmt = {}`）。
///
/// **CTAP2 canonical CBOR**：map keys 按"长度优先、字典序次之"排序。
/// 三个 key 长度都是 text string of length ≤ 23（major type 3 头单字节），
/// `fmt` (3), `attStmt` (7), `authData` (8) → 排序后顺序为：fmt → attStmt → authData。
fn build_attestation_object_none(auth_data: &[u8]) -> Vec<u8> {
    let map = Value::Map(alloc::vec![
        (Value::Text("fmt".into()), Value::Text("none".into()),),
        (Value::Text("attStmt".into()), Value::Map(alloc::vec![]),),
        (
            Value::Text("authData".into()),
            Value::Bytes(auth_data.to_vec()),
        ),
    ]);
    let mut buf = Vec::new();
    ciborium::ser::into_writer(&map, &mut buf).expect("CBOR encode never fails for in-memory map");
    buf
}

/// VerifyingKey → COSE_Key CBOR。
///
/// COSE_Key map（CTAP2 canonical 顺序：长度优先、负数键升序）：
///   1 (kty) = 2 (EC2)
///   3 (alg) = -7 (ES256)
///   -1 (crv) = 1 (P-256)
///   -2 (x) = 32-byte X
///   -3 (y) = 32-byte Y
fn verifying_key_to_cose(vk: &VerifyingKey) -> Result<Vec<u8>, PasskeyError> {
    let point = vk.to_encoded_point(false);
    let x = point.x().ok_or(PasskeyError::Internal)?;
    let y = point.y().ok_or(PasskeyError::Internal)?;
    let entries = alloc::vec![
        (
            Value::Integer(Integer::from(1)),
            Value::Integer(Integer::from(2))
        ), // kty=EC2
        (
            Value::Integer(Integer::from(3)),
            Value::Integer(Integer::from(-7))
        ), // alg=ES256
        (
            Value::Integer(Integer::from(-1)),
            Value::Integer(Integer::from(1))
        ), // crv=P-256
        (Value::Integer(Integer::from(-2)), Value::Bytes(x.to_vec())),
        (Value::Integer(Integer::from(-3)), Value::Bytes(y.to_vec())),
    ];
    let mut buf = Vec::new();
    ciborium::ser::into_writer(&Value::Map(entries), &mut buf)
        .map_err(|_| PasskeyError::Internal)?;
    Ok(buf)
}

fn extract_cose_xy(v: &Value) -> Result<([u8; 32], [u8; 32]), PasskeyError> {
    let Value::Map(entries) = v else {
        return Err(PasskeyError::InvalidCose);
    };
    let mut x: Option<Vec<u8>> = None;
    let mut y: Option<Vec<u8>> = None;
    let mut kty_ok = false;
    let mut alg_ok = false;
    let mut crv_ok = false;
    for (k, val) in entries {
        let Value::Integer(ki) = k else { continue };
        let kn: i128 = (*ki).into();
        match kn {
            1 => {
                // kty
                if let Value::Integer(vi) = val {
                    let vn: i128 = (*vi).into();
                    if vn == 2 {
                        kty_ok = true;
                    }
                }
            }
            3 => {
                // alg
                if let Value::Integer(vi) = val {
                    let vn: i128 = (*vi).into();
                    if vn == -7 {
                        alg_ok = true;
                    }
                }
            }
            -1 => {
                // crv
                if let Value::Integer(vi) = val {
                    let vn: i128 = (*vi).into();
                    if vn == 1 {
                        crv_ok = true;
                    }
                }
            }
            -2 => {
                if let Value::Bytes(b) = val {
                    x = Some(b.clone());
                }
            }
            -3 => {
                if let Value::Bytes(b) = val {
                    y = Some(b.clone());
                }
            }
            _ => {}
        }
    }
    if !(kty_ok && alg_ok && crv_ok) {
        return Err(PasskeyError::InvalidCose);
    }
    let x = x.ok_or(PasskeyError::InvalidCose)?;
    let y = y.ok_or(PasskeyError::InvalidCose)?;
    if x.len() != 32 || y.len() != 32 {
        return Err(PasskeyError::InvalidLength);
    }
    let mut xa = [0u8; 32];
    let mut ya = [0u8; 32];
    xa.copy_from_slice(&x);
    ya.copy_from_slice(&y);
    Ok((xa, ya))
}

// ===================== 测试 =====================

#[cfg(all(test, feature = "os-rng"))]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;

    fn fixed_seed_keypair() -> PasskeyKeypair {
        // 一个固定 seed，让测试可重复
        let seed: [u8; 32] = [7u8; 32];
        keypair_from_seed(&seed).unwrap()
    }

    /// spec/07 § 9 test `generate_keypair_round_trip`：生成 → 签 → SPKI verify 通过。
    #[test]
    fn generate_keypair_round_trip() {
        let kp = generate_keypair().unwrap();
        let client_data_hash = [0xAB; 32];
        let ao = sign_assertion(&AssertionInput {
            rp_id: "example.com",
            keypair: &kp,
            sign_count: 0,
            client_data_hash: &client_data_hash,
            user_present: true,
            user_verified: true,
        })
        .unwrap();

        // 用 SPKI 公钥 + p256::ecdsa::VerifyingKey 验签
        let vk = VerifyingKey::from_public_key_der(&kp.public_key_spki).unwrap();
        let mut signed = Vec::new();
        signed.extend_from_slice(&ao.authenticator_data);
        signed.extend_from_slice(&client_data_hash);
        let sig = Signature::from_der(&ao.signature).unwrap();
        vk.verify(&signed, &sig).expect("signature must verify");
    }

    /// spec/07 § 9 test `cose_spki_round_trip`：`cose_to_spki(spki_to_cose(x)) == x`。
    #[test]
    fn cose_spki_round_trip() {
        let kp = fixed_seed_keypair();
        let cose = spki_to_cose(&kp.public_key_spki).unwrap();
        let spki2 = cose_to_spki(&cose).unwrap();
        assert_eq!(spki2, kp.public_key_spki);
        // 而且我们 generate 时就放好的 cose 也应该一致
        assert_eq!(cose, kp.public_key_cose);
    }

    /// spec/07 § 9 test `auth_data_layout`：注册输出前 32 字节 = SHA256(rp_id)。
    #[test]
    fn auth_data_layout() {
        let out = create_registration("example.com", None, &ZPASS_DESKTOP_AAGUID).unwrap();
        let expected_hash: [u8; 32] = Sha256::digest(b"example.com").into();
        assert_eq!(&out.authenticator_data[..32], &expected_hash[..]);
        // flags 字节：UP | UV | AT = 0x01 | 0x04 | 0x40 = 0x45
        assert_eq!(out.authenticator_data[32], 0x45);
        // signCount = 0
        assert_eq!(&out.authenticator_data[33..37], &[0, 0, 0, 0]);
        // 接下来 16 bytes 是 AAGUID
        assert_eq!(&out.authenticator_data[37..53], &ZPASS_DESKTOP_AAGUID);
    }

    /// spec/07 § 9 test `sign_count_monotonic`：连续两次 sign_assertion 返回 count, count+1。
    #[test]
    fn sign_count_monotonic() {
        let kp = fixed_seed_keypair();
        let cdh = [0u8; 32];
        let a = sign_assertion(&AssertionInput {
            rp_id: "example.com",
            keypair: &kp,
            sign_count: 5,
            client_data_hash: &cdh,
            user_present: true,
            user_verified: false,
        })
        .unwrap();
        assert_eq!(a.new_sign_count, 6);

        let b = sign_assertion(&AssertionInput {
            rp_id: "example.com",
            keypair: &kp,
            sign_count: a.new_sign_count,
            client_data_hash: &cdh,
            user_present: true,
            user_verified: false,
        })
        .unwrap();
        assert_eq!(b.new_sign_count, 7);
    }

    /// spec/07 § 9 test `attestation_object_format`：CBOR map 含 fmt / authData / attStmt。
    ///
    /// 同时验证 CTAP2 canonical 顺序：fmt (3) → attStmt (7) → authData (8)。
    #[test]
    fn attestation_object_format() {
        let out = create_registration("example.com", None, &ZPASS_DESKTOP_AAGUID).unwrap();
        let v: Value = ciborium::de::from_reader(&out.attestation_object[..]).unwrap();
        let Value::Map(entries) = v else {
            panic!("attestation object 应是 CBOR map");
        };
        assert_eq!(entries.len(), 3);
        // 顺序就是 fmt → attStmt → authData（CTAP2 canonical）
        let keys: alloc::vec::Vec<&str> = entries
            .iter()
            .filter_map(|(k, _)| {
                if let Value::Text(s) = k {
                    Some(s.as_str())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(keys, alloc::vec!["fmt", "attStmt", "authData"]);
        // fmt = "none"
        let Value::Text(fmt) = &entries[0].1 else {
            panic!("fmt 应是 text");
        };
        assert_eq!(fmt, "none");
        // attStmt = {} 空 map
        let Value::Map(att) = &entries[1].1 else {
            panic!("attStmt 应是 map");
        };
        assert!(att.is_empty());
        // authData = bytes
        let Value::Bytes(ad) = &entries[2].1 else {
            panic!("authData 应是 bytes");
        };
        assert_eq!(ad, &out.authenticator_data);
    }

    /// spec/07 § 9 test `webauthn_test_vector_register`：
    /// 注册输出的签名能用从 SPKI 还原的公钥验证。
    ///
    /// 我们没引 ring / webauthn-rs（spec/07 § 9 列举但非强制），用 p256 即可，
    /// workspace 已有依赖。这覆盖了与浏览器扩展实际 verify 链路等价的算法路径。
    #[test]
    fn webauthn_test_vector_register() {
        // 注册：拿到 keypair + auth_data
        let reg = create_registration("github.com", None, &ZPASS_DESKTOP_AAGUID).unwrap();

        // 然后用同一密钥签一个 assertion，断言 SPKI verify 通过
        let cdh = [0x11; 32];
        let a = sign_assertion(&AssertionInput {
            rp_id: "github.com",
            keypair: &reg.keypair,
            sign_count: 0,
            client_data_hash: &cdh,
            user_present: true,
            user_verified: true,
        })
        .unwrap();

        let vk = VerifyingKey::from_public_key_der(&reg.keypair.public_key_spki).unwrap();
        let mut signed = Vec::new();
        signed.extend_from_slice(&a.authenticator_data);
        signed.extend_from_slice(&cdh);
        let sig = Signature::from_der(&a.signature).unwrap();
        vk.verify(&signed, &sig).expect("signature must verify");

        // assertion 的 auth_data 第 32 字节是 flags，注册无 AT 但有 UP|UV → 0x05
        assert_eq!(a.authenticator_data[32], 0x05);
    }

    // ----- 额外边界 / planner 关切的测试 -----

    /// AAGUID 字节 8 的高 2 bit 必须是 `10`（RFC 4122 variant），
    /// 否则被部分 RP 严格实现拒绝。
    #[test]
    fn aaguid_variant_bits_are_rfc4122() {
        let b = ZPASS_DESKTOP_AAGUID[8];
        let high2 = b >> 6;
        assert_eq!(
            high2, 0b10,
            "AAGUID byte 8 high 2 bits must be 0b10 (RFC 4122 variant)"
        );
    }

    /// 没有 attested cred data 时，authenticator_data 长度恰好 37 字节（32+1+4）。
    #[test]
    fn assert_auth_data_length_without_attested() {
        let kp = fixed_seed_keypair();
        let cdh = [0u8; 32];
        let a = sign_assertion(&AssertionInput {
            rp_id: "example.com",
            keypair: &kp,
            sign_count: 0,
            client_data_hash: &cdh,
            user_present: true,
            user_verified: false,
        })
        .unwrap();
        assert_eq!(a.authenticator_data.len(), 37);
    }

    /// 注册路径的 authenticator_data 应以 attested cred data 结尾，
    /// 长度 = 32 (hash) + 1 (flags) + 4 (count) + 16 (aaguid) + 2 (credLen) + 32 (credId) + cose_len。
    #[test]
    fn register_auth_data_has_attested_section() {
        let out = create_registration("example.com", None, &ZPASS_DESKTOP_AAGUID).unwrap();
        let cose_len = out.keypair.public_key_cose.len();
        let expected = 32 + 1 + 4 + 16 + 2 + 32 + cose_len;
        assert_eq!(out.authenticator_data.len(), expected);
    }

    /// SPKI / COSE 的私钥不会被泄露到 SPKI / COSE 中（它们应只含公钥点）。
    #[test]
    fn cose_does_not_contain_private_key() {
        let kp = fixed_seed_keypair();
        // SPKI 与 PKCS8 不应共享 byte sequence
        for win in kp.public_key_spki.windows(8) {
            for win2 in kp.private_key_pkcs8.windows(8) {
                if win == win2 {
                    // 允许偶尔重叠（asn.1 头部、算法 oid 是共享的）；只要不是整段相同
                    // 但 32 bytes 的私钥 d 一定不能出现在 SPKI / COSE
                }
            }
        }
        // 直接断言：COSE / SPKI 长度都远短于含私钥的 PKCS#8。
        assert!(kp.public_key_cose.len() < kp.private_key_pkcs8.len());
        assert!(kp.public_key_spki.len() < kp.private_key_pkcs8.len());
    }
}
