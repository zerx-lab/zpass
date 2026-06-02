//! SRP-6a 认证原语（RFC 5054 §2.5-2.6）
//!
//! 档案明令本模块是"最高风险, 单列里程碑"：四端（desktop / phone /
//! extension / wasm）后续对齐的字节基准在此锁定。任何 N/g、PAD、k、u、
//! M1、M2 的字节布局变更都会让已注册 verifier / 已签发握手作废。
//!
//! # 锚定
//!
//! 锚 RFC 5054 §2.5-2.6（SRP-6a），**不**沿用 RFC 2945（那是 SRP-3，
//! transcript 不同）。哈希一律 SHA-256，`K = H(S) = SHA256(S)`。这是 zpass
//! 自定后锁的选择，不复刻 1Password 未公开字节。
//!
//! # 群参数（T1.a 拍板）
//!
//! 选定 **RFC 5054 附录 A 的 2048-bit 群**，`g = 2`。N 为该附录列出的
//! 2048-bit safe prime（即 (N-1)/2 亦为素数），256 字节。选 2048-bit 而非
//! 4096-bit：登录热路径每次握手要做数次 modexp，2048-bit 在四端（尤其移动端
//! 与浏览器 bignum）性能/电量可接受，且 RFC 5054 附录 A 直接给出该群的精确
//! 字节，无需在 RFC 3526-4096 与 RFC 5054-4096 是否同素数之间核实（档案
//! §12-7 标注的未决点）。N 的字节由 [`tests`](crate) 中
//! `srp_group_params_locked`（SHA-256 + 长度 + 首尾字节）锁定。
//!
//! # x 字节布局（T1.c 拍板）
//!
//! [`crate::kdf2::derive_srp_x`] 产出 32 字节。本模块把这 32 字节按
//! **大端（big-endian）** 解释为 bignum `x`（RFC 5054 惯例），**不**对 N 取模
//! （32 字节 ≈ 2^256，远小于 2048-bit 的 N，必然 x < N）。该约定由
//! `srp_register_verifier_vector` 向量覆盖。
//!
//! # PAD
//!
//! `PAD(x)` 指把整数 x 左零填充到 N 的字节长度（256 字节），即 RFC 5054 §2.6
//! 的 PAD。所有进哈希的群元素（N / g / A / B / S）都先 PAD。
//!
//! # ephemeral 一次性
//!
//! SRP ephemeral `a`（客户端）/ `b`（服务端）**必须一次性、绝不重用**：重用
//! 会泄露长期密钥相关信息。本 crate 只提供纯函数，`a`/`b` 由
//! [`srp_client_start`] / [`srp_server_start`] 内部用 OS CSPRNG 一次性生成并
//! 返回给调用方；其持有、销毁、per-attempt 绑定与短 TTL 由后端状态机 epic
//! 负责（M6），不在本 crate 范围。
//!
//! 可控的敏感字节缓冲（ephemeral a/b 的字节、返回的会话密钥 K）由各结构体的
//! Drop 用 zeroize 清零。中间 bignum（x/S/exp 等）受 num-bigint 限制无法原位
//! 擦除（[`BigUint`] 不实现 Zeroize，堆缓冲不可控），离开作用域后交分配器回收；
//! 调用方持有的 x_bytes / a_secret 等输入字节才是可控擦除点。

// Rust guideline compliant 2026-02-21

use crate::envelope::ALG_SRP_VERIFIER;
use crate::{Error, Result, random_bytes};
use num_bigint::BigUint;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroize;

/// SRP 群 N 的字节长度（2048-bit = 256 字节）。所有 PAD 以此为目标长度。
pub const N_BYTE_LEN: usize = 256;

/// SRP 群 N —— RFC 5054 附录 A 的 2048-bit safe prime（大端字节）。
///
/// 这是不可妥协的字节对齐点：改动它等于换群，所有已注册 verifier 作废。
/// 由 `srp_group_params_locked` 测试锁定（SHA-256 + 长度 + 首尾字节）。
const N_BYTES: [u8; N_BYTE_LEN] = [
    0xAC, 0x6B, 0xDB, 0x41, 0x32, 0x4A, 0x9A, 0x9B, 0xF1, 0x66, 0xDE, 0x5E, 0x13, 0x89, 0x58, 0x2F,
    0xAF, 0x72, 0xB6, 0x65, 0x19, 0x87, 0xEE, 0x07, 0xFC, 0x31, 0x92, 0x94, 0x3D, 0xB5, 0x60, 0x50,
    0xA3, 0x73, 0x29, 0xCB, 0xB4, 0xA0, 0x99, 0xED, 0x81, 0x93, 0xE0, 0x75, 0x77, 0x67, 0xA1, 0x3D,
    0xD5, 0x23, 0x12, 0xAB, 0x4B, 0x03, 0x31, 0x0D, 0xCD, 0x7F, 0x48, 0xA9, 0xDA, 0x04, 0xFD, 0x50,
    0xE8, 0x08, 0x39, 0x69, 0xED, 0xB7, 0x67, 0xB0, 0xCF, 0x60, 0x95, 0x17, 0x9A, 0x16, 0x3A, 0xB3,
    0x66, 0x1A, 0x05, 0xFB, 0xD5, 0xFA, 0xAA, 0xE8, 0x29, 0x18, 0xA9, 0x96, 0x2F, 0x0B, 0x93, 0xB8,
    0x55, 0xF9, 0x79, 0x93, 0xEC, 0x97, 0x5E, 0xEA, 0xA8, 0x0D, 0x74, 0x0A, 0xDB, 0xF4, 0xFF, 0x74,
    0x73, 0x59, 0xD0, 0x41, 0xD5, 0xC3, 0x3E, 0xA7, 0x1D, 0x28, 0x1E, 0x44, 0x6B, 0x14, 0x77, 0x3B,
    0xCA, 0x97, 0xB4, 0x3A, 0x23, 0xFB, 0x80, 0x16, 0x76, 0xBD, 0x20, 0x7A, 0x43, 0x6C, 0x64, 0x81,
    0xF1, 0xD2, 0xB9, 0x07, 0x87, 0x17, 0x46, 0x1A, 0x5B, 0x9D, 0x32, 0xE6, 0x88, 0xF8, 0x77, 0x48,
    0x54, 0x45, 0x23, 0xB5, 0x24, 0xB0, 0xD5, 0x7D, 0x5E, 0xA7, 0x7A, 0x27, 0x75, 0xD2, 0xEC, 0xFA,
    0x03, 0x2C, 0xFB, 0xDB, 0xF5, 0x2F, 0xB3, 0x78, 0x61, 0x60, 0x27, 0x90, 0x04, 0xE5, 0x7A, 0xE6,
    0xAF, 0x87, 0x4E, 0x73, 0x03, 0xCE, 0x53, 0x29, 0x9C, 0xCC, 0x04, 0x1C, 0x7B, 0xC3, 0x08, 0xD8,
    0x2A, 0x56, 0x98, 0xF3, 0xA8, 0xD0, 0xC3, 0x82, 0x71, 0xAE, 0x35, 0xF8, 0xE9, 0xDB, 0xFB, 0xB6,
    0x94, 0xB5, 0xC8, 0x03, 0xD8, 0x9F, 0x7A, 0xE4, 0x35, 0xDE, 0x23, 0x6D, 0x52, 0x5F, 0x54, 0x75,
    0x9B, 0x65, 0xE3, 0x72, 0xFC, 0xD6, 0x8E, 0xF2, 0x0F, 0xA7, 0x11, 0x1F, 0x9E, 0x4A, 0xFF, 0x73,
];

/// SRP 群生成元 g（RFC 5054 附录 A 2048-bit 群：g = 2）。
const G_VALUE: u8 = 2;

/// N 作为 [`BigUint`]（每次握手廉价重建；N 是公开常量）。
fn group_n() -> BigUint {
    BigUint::from_bytes_be(&N_BYTES)
}

/// g 作为 [`BigUint`]。
fn group_g() -> BigUint {
    BigUint::from(G_VALUE)
}

/// PAD(x)：把非负整数左零填充到 N 的字节长度（256 字节，RFC 5054 §2.6）。
///
/// `BigUint::to_bytes_be` 去掉前导零，故需手工左补零到固定长度。x 必为
/// 群内元素（< N），最长 256 字节，不会溢出。
fn pad(x: &BigUint) -> [u8; N_BYTE_LEN] {
    let raw = x.to_bytes_be();
    let mut out = [0u8; N_BYTE_LEN];
    // raw.len() <= N_BYTE_LEN（x < N），右对齐拷贝。
    let off = N_BYTE_LEN - raw.len();
    out[off..].copy_from_slice(&raw);
    out
}

/// 把若干字节块依次喂入 SHA-256，返回 32 字节摘要。
fn hash(chunks: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for c in chunks {
        h.update(c);
    }
    h.finalize().into()
}

/// 把 32 字节大端摘要解释为 [`BigUint`]（u = H(...) 等场景）。
fn hash_to_int(digest: &[u8; 32]) -> BigUint {
    BigUint::from_bytes_be(digest)
}

/// 计算 SRP 乘子 k = H(N, PAD(g))（RFC 5054 §2.5.3）。
fn compute_k(g: &BigUint) -> BigUint {
    // RFC 5054：k = H(N | PAD(g))。N 本身已是 256 字节，无需 PAD；g 要 PAD。
    let kh = hash(&[&N_BYTES, &pad(g)]);
    hash_to_int(&kh)
}

/// 计算 u = H(PAD(A), PAD(B))（RFC 5054 §2.6）。
fn compute_u(a_pub: &BigUint, b_pub: &BigUint) -> BigUint {
    let uh = hash(&[&pad(a_pub), &pad(b_pub)]);
    hash_to_int(&uh)
}

/// 计算 M1 = H( (H(N) XOR H(g)) | H(I) | s | PAD(A) | PAD(B) | K )。
///
/// 这是 zpass 自定后锁的 transcript：进哈希的 A/B 走 PAD（固定 256 字节）。
fn compute_m1(
    g: &BigUint,
    identity: &[u8],
    salt: &[u8],
    a_pub: &BigUint,
    b_pub: &BigUint,
    session_key: &[u8; 32],
) -> [u8; 32] {
    let hn = hash(&[&N_BYTES]);
    let hg = hash(&[&pad(g)]);
    let mut hn_xor_hg = [0u8; 32];
    for i in 0..32 {
        hn_xor_hg[i] = hn[i] ^ hg[i];
    }
    let hi = hash(&[identity]);
    hash(&[
        &hn_xor_hg,
        &hi,
        salt,
        &pad(a_pub),
        &pad(b_pub),
        session_key,
    ])
}

/// 计算 M2 = H( PAD(A) | M1 | K )（RFC 5054 §2.6 服务端确认）。
fn compute_m2(a_pub: &BigUint, m1: &[u8; 32], session_key: &[u8; 32]) -> [u8; 32] {
    hash(&[&pad(a_pub), m1, session_key])
}

/// 把 32 字节 SRP-x 输出按大端解释为 bignum x（T1.c，不 mod N）。
///
/// `x_bytes` 必须恰为 32 字节（[`crate::kdf2::derive_srp_x`] 的输出）。
fn x_from_bytes(x_bytes: &[u8]) -> Result<BigUint> {
    if x_bytes.len() != crate::KEY_SIZE {
        return Err(Error::KeyLength {
            got: x_bytes.len(),
        });
    }
    Ok(BigUint::from_bytes_be(x_bytes))
}

/// 注册产物：salt（认证盐）+ verifier（v = g^x mod N，PAD 到 256 字节）。
///
/// `salt` 即 `derive_srp_x` 所用的 `salt_auth`，由调用方在注册时生成并存储。
/// `verifier` 是服务器唯一长期持有的认证物。
#[derive(Clone)]
pub struct SrpRegistration {
    /// 认证盐（= derive_srp_x 的 salt_auth），登录 start 时回传客户端。
    pub salt: Vec<u8>,
    /// v = g^x mod N，PAD 到 256 字节（[`N_BYTE_LEN`]）。
    pub verifier: Vec<u8>,
}

impl core::fmt::Debug for SrpRegistration {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        // verifier 是公开的，但仍按习惯不打印完整字节，避免日志噪音。
        f.debug_struct("SrpRegistration")
            .field("alg", &ALG_SRP_VERIFIER)
            .field("salt_len", &self.salt.len())
            .field("verifier_len", &self.verifier.len())
            .finish()
    }
}

/// 注册：给定 SRP-x（32 字节）与认证盐，计算 verifier v = g^x mod N。
///
/// RFC 5054 §2.5.3：`v = g^x % N`。`x` 由 [`crate::kdf2::derive_srp_x`] 产出，
/// 按大端解释（[T1.c](self)）。返回的 verifier PAD 到固定 256 字节，便于四端
/// 字节对齐与存储。
///
/// # Errors
///
/// 当 `x_bytes` 长度不为 32 时返回 [`Error::KeyLength`]。
pub fn srp_register(x_bytes: &[u8], salt: &[u8]) -> Result<SrpRegistration> {
    let n = group_n();
    let g = group_g();
    let x = x_from_bytes(x_bytes)?;
    let v = g.modpow(&x, &n);
    Ok(SrpRegistration {
        salt: salt.to_vec(),
        verifier: pad(&v).to_vec(),
    })
}

/// 客户端临时密钥对：私有 ephemeral a + 公开 A = g^a mod N。
///
/// `a` 是敏感量，Drop 时清零。**一次性、不可重用**。
pub struct SrpClientStart {
    /// 私有 ephemeral a 的大端字节（敏感，Drop 清零）。
    a: Vec<u8>,
    /// 公开 A = g^a mod N，PAD 到 256 字节。
    pub a_pub: Vec<u8>,
}

impl SrpClientStart {
    /// 返回私有 ephemeral a 的大端字节（交给状态机持有，用后即焚）。
    #[must_use]
    pub fn secret_a(&self) -> &[u8] {
        &self.a
    }
}

impl core::fmt::Debug for SrpClientStart {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SrpClientStart")
            .field("a", &"<redacted>")
            .field("a_pub_len", &self.a_pub.len())
            .finish()
    }
}

impl Drop for SrpClientStart {
    fn drop(&mut self) {
        self.a.zeroize();
    }
}

/// 服务端临时密钥对：私有 ephemeral b + 公开 B = (k·v + g^b) mod N。
///
/// `b` 是敏感量，Drop 时清零。**一次性、不可重用**。
pub struct SrpServerStart {
    /// 私有 ephemeral b 的大端字节（敏感，Drop 清零）。
    b: Vec<u8>,
    /// 公开 B = (k·v + g^b) mod N，PAD 到 256 字节。
    pub b_pub: Vec<u8>,
}

impl SrpServerStart {
    /// 返回私有 ephemeral b 的大端字节（交给状态机持有，用后即焚）。
    #[must_use]
    pub fn secret_b(&self) -> &[u8] {
        &self.b
    }
}

impl core::fmt::Debug for SrpServerStart {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SrpServerStart")
            .field("b", &"<redacted>")
            .field("b_pub_len", &self.b_pub.len())
            .finish()
    }
}

impl Drop for SrpServerStart {
    fn drop(&mut self) {
        self.b.zeroize();
    }
}

/// 在 [1, N-1) 范围内生成一次性 ephemeral 私钥（256-bit 随机）。
///
/// RFC 5054 §2.5.4 建议 ephemeral 至少 256 bit。返回大端字节（< N，因 256-bit
/// 远小于 2048-bit N，且非零）。
fn random_ephemeral() -> Result<(Vec<u8>, BigUint)> {
    // 32 字节 = 256 bit。重试直到非零（OS CSPRNG 给全零的概率约 2^-256）。
    loop {
        let bytes = random_bytes(crate::KEY_SIZE)?;
        let value = BigUint::from_bytes_be(&bytes);
        if value != BigUint::ZERO {
            return Ok((bytes, value));
        }
    }
}

/// 客户端 start：生成一次性 a 与 A = g^a mod N（RFC 5054 §2.6）。
///
/// # Errors
///
/// OS CSPRNG 失败时返回 [`Error::Rng`]。
pub fn srp_client_start() -> Result<SrpClientStart> {
    let n = group_n();
    let g = group_g();
    let (a_bytes, a) = random_ephemeral()?;
    let a_pub = g.modpow(&a, &n);
    Ok(SrpClientStart {
        a: a_bytes,
        a_pub: pad(&a_pub).to_vec(),
    })
}

/// 客户端握手输出：证明 M1 + 共享密钥 K（= H(S)）。
///
/// `K` 是敏感量，Drop 时清零。
pub struct SrpClientProof {
    /// 客户端证明 M1（发往服务器）。
    pub m1: [u8; 32],
    /// 共享会话密钥 K = H(S)（敏感，Drop 清零）。
    pub session_key: [u8; 32],
}

impl SrpClientProof {
    /// 校验服务端返回的 M2 = H(PAD(A) | M1 | K)，常数时间比较。
    ///
    /// `a_pub` 为本次握手的客户端公钥 A 字节（来自 [`SrpClientStart::a_pub`]）。
    #[must_use]
    pub fn verify_server(&self, a_pub: &[u8], server_m2: &[u8]) -> bool {
        let a = BigUint::from_bytes_be(a_pub);
        let expected = compute_m2(&a, &self.m1, &self.session_key);
        expected.ct_eq(server_m2).into()
    }
}

impl core::fmt::Debug for SrpClientProof {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SrpClientProof")
            .field("m1", &hex_short(&self.m1))
            .field("session_key", &"<redacted>")
            .finish()
    }
}

impl Drop for SrpClientProof {
    fn drop(&mut self) {
        self.session_key.zeroize();
    }
}

/// 客户端 finish：算 S / K / M1（RFC 5054 §2.6）。
///
/// `S = (B - k·(g^x mod N))^(a + u·x) mod N`，减法在模 N 下取正（避免负数）。
/// `K = H(S) = SHA256(PAD(S))`。
///
/// 参数：
/// - `a_secret`：[`SrpClientStart::secret_a`] 的字节（一次性私钥 a）。
/// - `a_pub` / `b_pub`：客户端 A 与服务端 B 的字节。
/// - `x_bytes`：[`crate::kdf2::derive_srp_x`] 的 32 字节输出。
/// - `salt` / `identity`：认证盐与身份（进 M1 transcript）。
///
/// # Errors
///
/// 当 `x_bytes` 长度不为 32、或服务端 B ≡ 0 (mod N)（RFC 5054 §2.6 要求
/// abort）时返回错误。
pub fn srp_client_finish(
    a_secret: &[u8],
    a_pub: &[u8],
    b_pub: &[u8],
    x_bytes: &[u8],
    salt: &[u8],
    identity: &[u8],
) -> Result<SrpClientProof> {
    let n = group_n();
    let g = group_g();

    let a_priv = BigUint::from_bytes_be(a_secret);
    let a = BigUint::from_bytes_be(a_pub);
    let b = BigUint::from_bytes_be(b_pub);

    // RFC 5054 §2.6：B % N == 0 必须 abort。
    if (&b % &n) == BigUint::ZERO {
        return Err(Error::AeadAuthentication);
    }

    let x = x_from_bytes(x_bytes)?;
    let k = compute_k(&g);
    let u = compute_u(&a, &b);

    // gx = g^x mod N
    let gx = g.modpow(&x, &n);
    // base = (B - k*gx) mod N，减法取正：先把 k*gx 归约到 [0,N)，再用模加法补 N。
    let kgx = (&k * &gx) % &n;
    let base = ((&b % &n) + &n - kgx) % &n;
    // exp = a + u*x
    let exp = &a_priv + (&u * &x);
    let s = base.modpow(&exp, &n);

    let session_key = hash(&[&pad(&s)]);
    let m1 = compute_m1(&g, identity, salt, &a, &b, &session_key);

    // 注：num-bigint 的 BigUint 不实现 Zeroize（堆缓冲不可控擦除），故敏感
    // bignum（x / exp / s）无法在此原位清零；调用方持有的 a_secret / x_bytes /
    // 返回的 session_key 才是可控敏感量（SrpClientStart / SrpClientProof 的 Drop
    // 负责清零）。中间 bignum 离开作用域后由分配器回收。
    Ok(SrpClientProof { m1, session_key })
}

/// 服务端 start：生成一次性 b 与 B = (k·v + g^b) mod N（RFC 5054 §2.5.3）。
///
/// `verifier` 为 256 字节 PAD 后的 v（[`srp_register`] 产出）。
///
/// # Errors
///
/// OS CSPRNG 失败时返回 [`Error::Rng`]。
pub fn srp_server_start(verifier: &[u8]) -> Result<SrpServerStart> {
    let n = group_n();
    let g = group_g();
    let v = BigUint::from_bytes_be(verifier);
    let k = compute_k(&g);

    let (b_bytes, b_priv) = random_ephemeral()?;
    // B = (k*v + g^b) mod N
    let b_pub = ((&k * &v) % &n + g.modpow(&b_priv, &n)) % &n;
    Ok(SrpServerStart {
        b: b_bytes,
        b_pub: pad(&b_pub).to_vec(),
    })
}

/// 服务端握手输出：校验结果 + M2 + 共享密钥 K。
///
/// `K` 是敏感量，Drop 时清零。
pub struct SrpServerProof {
    /// 客户端 M1 校验是否通过（常数时间比较结果）。
    pub verified: bool,
    /// 服务端确认 M2 = H(PAD(A) | M1 | K)（仅在 verified 时有意义）。
    pub m2: [u8; 32],
    /// 共享会话密钥 K = H(S)（敏感，Drop 清零）。
    pub session_key: [u8; 32],
}

impl core::fmt::Debug for SrpServerProof {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SrpServerProof")
            .field("verified", &self.verified)
            .field("m2", &hex_short(&self.m2))
            .field("session_key", &"<redacted>")
            .finish()
    }
}

impl Drop for SrpServerProof {
    fn drop(&mut self) {
        self.session_key.zeroize();
    }
}

/// 服务端 finish：算 S / K，校验客户端 M1，算 M2（RFC 5054 §2.6）。
///
/// `S = (A · v^u)^b mod N`，`K = H(S)`。M1 用 [`subtle::ConstantTimeEq`] 常数
/// 时间比较；错误密码与缺 Secret Key 走同一失败路径，不可区分。
///
/// 参数：
/// - `b_secret`：[`SrpServerStart::secret_b`] 的字节（一次性私钥 b）。
/// - `a_pub` / `b_pub`：客户端 A 与服务端 B 的字节。
/// - `verifier`：256 字节 PAD 后的 v。
/// - `client_m1`：客户端发来的 M1。
/// - `salt` / `identity`：认证盐与身份（进 M1 transcript，须与注册一致）。
///
/// # Errors
///
/// 当客户端 A ≡ 0 (mod N)（RFC 5054 §2.6 要求 abort）时返回
/// [`Error::AeadAuthentication`]。M1 不匹配**不**返回 Err，而是
/// `verified == false`（让调用方统一处理拒绝）。
pub fn srp_server_finish(
    b_secret: &[u8],
    a_pub: &[u8],
    b_pub: &[u8],
    verifier: &[u8],
    client_m1: &[u8],
    salt: &[u8],
    identity: &[u8],
) -> Result<SrpServerProof> {
    let n = group_n();
    let g = group_g();

    let b_priv = BigUint::from_bytes_be(b_secret);
    let a = BigUint::from_bytes_be(a_pub);
    let b = BigUint::from_bytes_be(b_pub);
    let v = BigUint::from_bytes_be(verifier);

    // RFC 5054 §2.6：A % N == 0 必须 abort。
    if (&a % &n) == BigUint::ZERO {
        return Err(Error::AeadAuthentication);
    }

    let u = compute_u(&a, &b);
    // S = (A * v^u)^b mod N
    let base = (&a * v.modpow(&u, &n)) % &n;
    let s = base.modpow(&b_priv, &n);

    let session_key = hash(&[&pad(&s)]);
    let expected_m1 = compute_m1(&g, identity, salt, &a, &b, &session_key);

    let verified: bool = expected_m1.ct_eq(client_m1).into();
    // M2 始终基于客户端实际发来的 M1 计算（RFC：M2 = H(A | M1 | K)）。
    let mut m1_arr = [0u8; 32];
    if client_m1.len() == 32 {
        m1_arr.copy_from_slice(client_m1);
    }
    let m2 = compute_m2(&a, &m1_arr, &session_key);

    Ok(SrpServerProof {
        verified,
        m2,
        session_key,
    })
}

/// 调试用：返回摘要前 4 字节的十六进制（不泄露敏感量，仅用于公开证明）。
fn hex_short(d: &[u8; 32]) -> String {
    let mut s = String::with_capacity(11);
    for byte in &d[..4] {
        s.push_str(&format!("{byte:02x}"));
    }
    s.push_str("..");
    s
}

// ---- 测试辅助：用固定 ephemeral 重算 A / B，锁定 K/M1/M2 字节向量 ----

/// 测试用：A = g^a mod N（PAD 256 字节）。仅供 crate 内 KAT 向量使用。
#[cfg(test)]
pub(crate) fn derive_a_pub_for_test(a_secret: &[u8]) -> Vec<u8> {
    let n = group_n();
    let g = group_g();
    let a = BigUint::from_bytes_be(a_secret);
    pad(&g.modpow(&a, &n)).to_vec()
}

/// 测试用：B = (k·v + g^b) mod N（PAD 256 字节）。仅供 crate 内 KAT 向量使用。
#[cfg(test)]
pub(crate) fn derive_b_pub_for_test(b_secret: &[u8], verifier: &[u8]) -> Vec<u8> {
    let n = group_n();
    let g = group_g();
    let v = BigUint::from_bytes_be(verifier);
    let k = compute_k(&g);
    let b = BigUint::from_bytes_be(b_secret);
    let b_pub = ((&k * &v) % &n + g.modpow(&b, &n)) % &n;
    pad(&b_pub).to_vec()
}

// ---- WASM 第五端薄绑定（仅 feature=wasm 编入；不污染原生编译图）----

/// WASM：注册 verifier。返回 256 字节 PAD 后的 v。
///
/// # Errors
///
/// x 长度非法时抛出 JsError。
#[cfg(feature = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn wasm_srp_register(x_bytes: &[u8], salt: &[u8]) -> core::result::Result<Vec<u8>, wasm_bindgen::JsError> {
    srp_register(x_bytes, salt)
        .map(|r| r.verifier)
        .map_err(|e| wasm_bindgen::JsError::new(&e.to_string()))
}

/// WASM：客户端 start。返回 `a(32) || A(256)`（共 288 字节）。
///
/// # Errors
///
/// OS CSPRNG 失败时抛出 JsError。
#[cfg(feature = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn wasm_srp_client_start() -> core::result::Result<Vec<u8>, wasm_bindgen::JsError> {
    let start = srp_client_start().map_err(|e| wasm_bindgen::JsError::new(&e.to_string()))?;
    let mut out = Vec::with_capacity(crate::KEY_SIZE + N_BYTE_LEN);
    out.extend_from_slice(start.secret_a());
    out.extend_from_slice(&start.a_pub);
    Ok(out)
}

/// WASM：客户端 finish。返回 `M1(32) || K(32)`（共 64 字节）。
///
/// # Errors
///
/// x 长度非法或 B ≡ 0 时抛出 JsError。
#[cfg(feature = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn wasm_srp_client_finish(
    a_secret: &[u8],
    a_pub: &[u8],
    b_pub: &[u8],
    x_bytes: &[u8],
    salt: &[u8],
    identity: &[u8],
) -> core::result::Result<Vec<u8>, wasm_bindgen::JsError> {
    let proof = srp_client_finish(a_secret, a_pub, b_pub, x_bytes, salt, identity)
        .map_err(|e| wasm_bindgen::JsError::new(&e.to_string()))?;
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(&proof.m1);
    out.extend_from_slice(&proof.session_key);
    Ok(out)
}
