//! 密码生成器（spec/11 § 9a）。
//!
//! 纯本地，无 vault 依赖。算法：OS CSPRNG（getrandom）从 ASCII 字符池抽取。

use zeroize::Zeroizing;

/// 生成器选项。
#[derive(Debug, Clone, Copy)]
pub struct GenOpts {
    pub length: usize,
    pub uppercase: bool,
    pub lowercase: bool,
    pub digits: bool,
    pub symbols: bool,
    pub avoid_ambiguous: bool,
}

impl Default for GenOpts {
    fn default() -> Self {
        Self {
            length: 20,
            uppercase: true,
            lowercase: true,
            digits: true,
            symbols: true,
            avoid_ambiguous: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenError {
    NoCharacterClass,
    LengthOutOfRange,
    Rng,
}

const LOWER: &str = "abcdefghijklmnopqrstuvwxyz";
const UPPER: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS: &str = "0123456789";
const SYMBOLS: &str = "!@#$%^&*()-_=+[]{};:,.<>?/";
const AMBIGUOUS: &[char] = &['0', 'O', 'o', '1', 'l', 'I'];

/// 构建当前选项允许的字符池。
fn build_pool(opts: &GenOpts) -> Vec<char> {
    let mut pool: Vec<char> = Vec::new();
    if opts.lowercase {
        pool.extend(LOWER.chars());
    }
    if opts.uppercase {
        pool.extend(UPPER.chars());
    }
    if opts.digits {
        pool.extend(DIGITS.chars());
    }
    if opts.symbols {
        pool.extend(SYMBOLS.chars());
    }
    if opts.avoid_ambiguous {
        pool.retain(|c| !AMBIGUOUS.contains(c));
    }
    pool
}

/// 估计熵 bit 数 = length * log2(pool_size)。
pub fn entropy_bits(opts: &GenOpts) -> u32 {
    let pool = build_pool(opts);
    if pool.is_empty() || opts.length == 0 {
        return 0;
    }
    let bits_per_char = (pool.len() as f64).log2();
    (opts.length as f64 * bits_per_char).round() as u32
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StrengthLevel {
    Weak,
    Fair,
    Strong,
    VeryStrong,
}

pub fn classify_strength(bits: u32) -> StrengthLevel {
    match bits {
        b if b < 40 => StrengthLevel::Weak,
        b if b < 60 => StrengthLevel::Fair,
        b if b < 80 => StrengthLevel::Strong,
        _ => StrengthLevel::VeryStrong,
    }
}

/// 生成密码。返回 `Zeroizing<String>` 让上层在 drop 时抹零。
pub fn generate(opts: &GenOpts) -> Result<Zeroizing<String>, GenError> {
    if !(8..=128).contains(&opts.length) {
        return Err(GenError::LengthOutOfRange);
    }
    let pool = build_pool(opts);
    if pool.is_empty() {
        return Err(GenError::NoCharacterClass);
    }
    let mut bytes = vec![0u8; opts.length];
    getrandom::getrandom(&mut bytes).map_err(|_| GenError::Rng)?;
    let mut out = String::with_capacity(opts.length);
    for b in &bytes {
        out.push(pool[(*b as usize) % pool.len()]);
    }
    // 抹零中间 bytes
    zeroize::Zeroize::zeroize(&mut bytes);
    Ok(Zeroizing::new(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generator_respects_length() {
        for len in [8usize, 16, 32, 64, 128] {
            let opts = GenOpts {
                length: len,
                ..Default::default()
            };
            let pw = generate(&opts).unwrap();
            assert_eq!(pw.chars().count(), len);
        }
    }

    #[test]
    fn generator_uses_only_enabled_classes() {
        // 仅 digits
        let opts = GenOpts {
            length: 32,
            uppercase: false,
            lowercase: false,
            digits: true,
            symbols: false,
            avoid_ambiguous: false,
        };
        let pw = generate(&opts).unwrap();
        for c in pw.chars() {
            assert!(c.is_ascii_digit(), "char {c:?} 不在 digits 集合");
        }
    }

    #[test]
    fn generator_avoid_ambiguous_strips_chars() {
        let opts = GenOpts {
            length: 128,
            uppercase: true,
            lowercase: true,
            digits: true,
            symbols: false,
            avoid_ambiguous: true,
        };
        let pw = generate(&opts).unwrap();
        for c in pw.chars() {
            assert!(!AMBIGUOUS.contains(&c), "char {c:?} 应被排除");
        }
    }

    #[test]
    fn generator_no_class_returns_err() {
        let opts = GenOpts {
            length: 20,
            uppercase: false,
            lowercase: false,
            digits: false,
            symbols: false,
            avoid_ambiguous: false,
        };
        assert_eq!(generate(&opts).unwrap_err(), GenError::NoCharacterClass);
    }

    #[test]
    fn generator_length_out_of_range() {
        let opts = GenOpts {
            length: 7,
            ..Default::default()
        };
        assert_eq!(generate(&opts).unwrap_err(), GenError::LengthOutOfRange);
        let opts = GenOpts {
            length: 129,
            ..Default::default()
        };
        assert_eq!(generate(&opts).unwrap_err(), GenError::LengthOutOfRange);
    }

    /// pool 大小：26+26+10+25 = 87。20 * log2(87) ≈ 128.8 bits。
    #[test]
    fn entropy_bits_known() {
        let opts = GenOpts {
            length: 20,
            uppercase: true,
            lowercase: true,
            digits: true,
            symbols: true,
            avoid_ambiguous: false,
        };
        let bits = entropy_bits(&opts);
        // 允许 ±1 bit 的舍入差
        assert!(
            (127..=130).contains(&bits),
            "expected ~128 bits, got {bits}"
        );
    }

    #[test]
    fn strength_thresholds() {
        assert_eq!(classify_strength(0), StrengthLevel::Weak);
        assert_eq!(classify_strength(39), StrengthLevel::Weak);
        assert_eq!(classify_strength(40), StrengthLevel::Fair);
        assert_eq!(classify_strength(59), StrengthLevel::Fair);
        assert_eq!(classify_strength(60), StrengthLevel::Strong);
        assert_eq!(classify_strength(79), StrengthLevel::Strong);
        assert_eq!(classify_strength(80), StrengthLevel::VeryStrong);
    }
}
