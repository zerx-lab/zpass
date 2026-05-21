package services

// qrservice.go — QRService
// ---------------------------------------------------------------------------
// 把"识别一张图像中的二维码内容"封装成 Wails 3 Service 供前端调用。
//
// 为什么放后端：
//   1. 跨平台一致 —— Wails 三个目标平台的 WebView 引擎对 BarcodeDetector
//      的支持参差不齐（WebView2/Chromium 有；WKWebView/WebKitGTK 没有），
//      纯前端方案会让 macOS / Linux 用户掉回 jsQR 这种弱识别器
//   2. 识别率显著高 —— gozxing 是 ZXing 的 Go 移植，对带中心 logo（Microsoft
//      Authenticator / Authy 配置二维码）、轻度倾斜、低对比度的 QR 都明显
//      比 jsQR 鲁棒
//   3. 前端 bundle 缩小 —— 移除 qr-scanner（~16KB gzip）与 worker chunk
//   4. 进程隔离 —— 图像解码在 Go 进程内完成，不污染前端 React state
//
// 协议：
//   前端把 Blob/File 转 base64 字符串经 Wails IPC 传给 DecodeQR(b64)。
//   选 base64 而非 number[] 是因为：
//     - Wails 3 alpha 对大数组 JSON 反序列化体积膨胀（每个 byte 占 ~4 字符）
//     - base64 仅 +33% 膨胀，且浏览器 FileReader.readAsDataURL 原生支持，
//       不必前端手写 chunk 化的 btoa
//
// 解码流程：
//   raw bytes
//     ↓ image.Decode (PNG/JPEG/GIF 标准库自动识别)
//   image.Image
//     ↓ gozxing.NewBinaryBitmapFromImage
//   gozxing.BinaryBitmap
//     ↓ qrcode.NewQRCodeReader().Decode(hints={TRY_HARDER: true})
//   gozxing.Result.GetText()
//
// 错误语义：
//   - 输入 base64 不合法                → ErrQRImageInvalid
//   - 字节流不是受支持的图像格式         → ErrQRImageInvalid
//   - 图像合法但找不到 QR 码             → ErrQRNotFound
//   - 找到 QR 但解码内部异常             → ErrQRNotFound（向用户呈现为"没找到"）
//
// 前端把任何错误统一映射到"未识别到二维码"提示——区分"图像问题"vs"找不到
// QR"对用户视角无意义，且实际界面已经在 UI 层拦了"非图像文件 / 太大"两种
// 前置错误，到这一层都是合法图像。

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"

	// blank import 注册常见图片解码器到 image 标准库。
	// 标准库覆盖 PNG / JPEG / GIF；x/image 补 BMP / WebP，保持与前端
	// <input accept="image/png,image/jpeg,image/webp,image/gif,image/bmp">
	// 一致，避免用户选了 UI 声称支持的格式但后端拒绝。
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"

	"github.com/makiuchi-d/gozxing"
	"github.com/makiuchi-d/gozxing/qrcode"
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/webp"
)

// ErrQRImageInvalid 输入 base64 解码失败 / 字节流不是受支持的图像格式
var ErrQRImageInvalid = errors.New("qr image data is invalid or unsupported format")

// ErrQRNotFound 图像合法但未识别到二维码
var ErrQRNotFound = errors.New("no qr code detected in image")

// QRService 暴露给前端的二维码解码服务
//
// 当前仅一个方法 DecodeQR。后续若需要扩展（如批量识别多张图、识别其它
// 条码类型、生成二维码图像）也加在这里，与 vaultservice / fontservice
// 同级注册。
type QRService struct{}

// NewQRService 创建 QRService 实例
//
// 无依赖；保留构造函数形式是为了与 main.go 里其它 service 注册风格统一
// （application.NewService(NewXxxService())）。
func NewQRService() *QRService {
	return &QRService{}
}

// DecodeQR 解码 base64 编码的图像字节流中的二维码
//
// 入参：
//   - b64 ：标准 base64 编码的图像字节（不带 "data:image/...;base64," 前缀）
//
// 返回：
//   - 二维码内容字符串（典型为 otpauth:// URI，但本服务不做内容格式校验，
//     由前端 parseOtpauth 决定如何使用）
//   - 任意错误（ErrQRImageInvalid / ErrQRNotFound / 内部异常）
//
// 此方法是无副作用的纯计算 —— 不读文件、不写状态、不依赖锁定状态。
// 即便 vault 未解锁也能调用（前端 ItemDialog 在锁定后根本进不到这里，
// 但接口语义上不依赖 vault 状态，便于未来在登录前流程（如导入向导）复用）。
func (s *QRService) DecodeQR(b64 string) (string, error) {
	if b64 == "" {
		return "", ErrQRImageInvalid
	}

	// 步骤 1：base64 → []byte
	//
	// 用 StdEncoding（标准 base64，含 padding）而非 URLEncoding ——
	// 前端 FileReader.readAsDataURL 输出的就是标准 base64。
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", ErrQRImageInvalid
	}

	// 步骤 2：bytes → image.Image
	//
	// image.Decode 根据 magic number 自动选解码器；只有 _ import 注册过
	// 的格式才会被识别（当前 PNG/JPEG/GIF）。
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return "", ErrQRImageInvalid
	}

	// 步骤 3：image.Image → gozxing.BinaryBitmap
	//
	// 内部做灰度 + 全局阈值二值化。BinaryBitmap 是 gozxing 所有 reader 的
	// 通用输入。这里默认用 HybridBinarizer（gozxing 内部默认），对大多数
	// 真实场景（带 logo、轻度阴影）表现良好。
	bmp, err := gozxing.NewBinaryBitmapFromImage(img)
	if err != nil {
		return "", ErrQRImageInvalid
	}

	// 步骤 4：解码
	//
	// TRY_HARDER hint：让 reader 用更耗时但更鲁棒的扫描策略 ——
	// 多次旋转、多种 finder pattern 启发式。截图 / 拖入图片这种"一次性"
	// 解码场景下时间成本可以忽略（毫秒级）。
	//
	// 不启用 PURE_BARCODE hint —— 那个 hint 假设图像里只有完美对齐的
	// QR 码 + 白边，截图通常达不到这个假设。
	reader := qrcode.NewQRCodeReader()
	hints := map[gozxing.DecodeHintType]interface{}{
		gozxing.DecodeHintType_TRY_HARDER: true,
	}
	result, err := reader.Decode(bmp, hints)
	if err != nil {
		// gozxing 找不到 QR 时返回的是 NotFoundException，包装成统一 sentinel
		return "", ErrQRNotFound
	}
	text := result.GetText()
	if text == "" {
		return "", ErrQRNotFound
	}
	return text, nil
}
