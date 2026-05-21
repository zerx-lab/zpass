//! QR 解码（spec/16 OQ-4）。
//!
//! 范围：仅做"用户选择 / 拖入 QR 图片文件 → 解码出文本"。
//! **不**做桌面截屏（裁裁然按用户决定）。
//!
//! 使用 `rxing`（ZXing 移植），对 base64 / 压缩 logo QR 兼容性最好。

use rxing::common::HybridBinarizer;
use rxing::{BarcodeFormat, BinaryBitmap, DecodeHintType, DecodeHintValue, DecodingHintDictionary};
use rxing::{Luma8LuminanceSource, MultiFormatReader, Reader};

#[derive(Debug)]
pub enum QrError {
    Io(std::io::Error),
    Decode,
    UnsupportedImage,
}

impl From<std::io::Error> for QrError {
    fn from(e: std::io::Error) -> Self {
        QrError::Io(e)
    }
}

/// 从文件路径解 QR 图片。
pub fn decode_qr_file(path: &std::path::Path) -> Result<String, QrError> {
    let img = image::open(path).map_err(|_| QrError::UnsupportedImage)?;
    decode_qr_image(&img)
}

/// 从 bytes（PNG / JPEG）解 QR。
pub fn decode_qr_bytes(bytes: &[u8]) -> Result<String, QrError> {
    let img = image::load_from_memory(bytes).map_err(|_| QrError::UnsupportedImage)?;
    decode_qr_image(&img)
}

fn decode_qr_image(img: &image::DynamicImage) -> Result<String, QrError> {
    let gray = img.to_luma8();
    let (w, h) = gray.dimensions();
    let raw: Vec<u8> = gray.into_raw();

    let source = Luma8LuminanceSource::new(raw, w, h);
    let mut bitmap = BinaryBitmap::new(HybridBinarizer::new(source));

    let mut hints: DecodingHintDictionary = std::collections::HashMap::new();
    hints.insert(
        DecodeHintType::POSSIBLE_FORMATS,
        DecodeHintValue::PossibleFormats(std::collections::HashSet::from([BarcodeFormat::QR_CODE])),
    );
    hints.insert(DecodeHintType::TRY_HARDER, DecodeHintValue::TryHarder(true));

    let mut reader = MultiFormatReader::default();
    let result = reader
        .decode_with_hints(&mut bitmap, &hints)
        .map_err(|_| QrError::Decode)?;
    Ok(result.getText().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个最小 QR 图（用 rxing-cli 生成的二进制）作为测试向量太重；
    /// 这里只测错误路径与空字节。完整解码在 manual smoke 覆盖。
    #[test]
    fn empty_bytes_error() {
        assert!(matches!(
            decode_qr_bytes(&[]),
            Err(QrError::UnsupportedImage)
        ));
    }

    #[test]
    fn garbage_bytes_error() {
        assert!(matches!(
            decode_qr_bytes(&[0u8; 100]),
            Err(QrError::UnsupportedImage)
        ));
    }

    /// 构造一张白色 PNG（没有 QR），decode 路径应返回 Decode 错误。
    #[test]
    fn blank_png_no_qr_decodes_to_error() {
        let img = image::DynamicImage::new_luma8(64, 64);
        let mut buf: Vec<u8> = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        let res = decode_qr_bytes(&buf);
        // rxing 在没有码型时返回 Decode。
        assert!(matches!(res, Err(QrError::Decode)));
    }
}
