// 图片处理工具 —— 在浏览器（Tauri WebView）内压缩图片到合理尺寸的 data URL
// ---------------------------------------------------------------------------
// 用途：
//   用户上传"空间头像"时，避免把 4K / RAW 原图直接 base64 写进配置文件
//   把 spaces.json 撑爆。整个流程在前端用 Canvas 完成：
//
//     File / Blob → <img> → drawImage 缩放 → canvas.toDataURL("image/jpeg", q)
//
// 不引入额外依赖（pica / browser-image-compression 等）的原因：
//   1. 头像场景对压缩率要求不高，原生 Canvas 双线性采样的画质已足够
//   2. 减小 bundle —— Tauri 应用启动 JS 体积越小，冷启动越快
//   3. 业务无需透明通道（描边方块本身有底色），JPEG 压缩比足够好
//
// 输出策略：
//   - 最大边 256px：足够 Sidebar 7×7 + 设置页 8×8 的 retina 显示，再大
//     也只是浪费配置文件体积
//   - JPEG 质量 0.85：肉眼无损区间的下沿；多数手机/相机原图压完都在 30KB 内
//   - 强制画白底再绘图：避免上传透明 PNG 时 JPEG 默认黑底导致头像变黑块

/** 最大边长（像素）—— 同时控制宽和高 */
const MAX_EDGE = 256;

/** JPEG 质量参数 —— 0..1，0.85 是肉眼无损区间下沿 */
const JPEG_QUALITY = 0.85;

/** 单文件最大可接受尺寸（字节）—— 超过的让用户先自行裁切，避免 OOM */
const MAX_INPUT_BYTES = 10 * 1024 * 1024;

/**
 * 错误：用户选了非图片或过大文件
 *
 * 调用方应捕获并通过 toast / alert 提示用户重选；不要把这个原始错误
 * 直接抛给 React error boundary（不算 bug，是用户输入问题）。
 */
export class ImageInputError extends Error {
	constructor(
		message: string,
		public reason: "not-image" | "too-large" | "decode-failed",
	) {
		super(message);
		this.name = "ImageInputError";
	}
}

/**
 * 把 File / Blob 缩放压缩成 base64 data URL。
 *
 * @param file 用户从 <input type="file"> 或拖拽拿到的 File 对象
 * @returns Promise<string> 形如 "data:image/jpeg;base64,..." 的 data URL
 *
 * 失败场景：
 *   - 不是图片 MIME → 抛 ImageInputError("not-image")
 *   - 文件 > 10MB → 抛 ImageInputError("too-large")
 *   - 浏览器解码失败（损坏文件）→ 抛 ImageInputError("decode-failed")
 *
 * 注意：本函数完全在主线程执行，对于 ≤10MB 的图片在现代设备上耗时 < 100ms，
 * 不需要 OffscreenCanvas / Web Worker；调用方可以在按钮上显示 loading 让
 * 用户感知。
 */
export async function resizeImageToDataUrl(file: File): Promise<string> {
	if (!file.type.startsWith("image/")) {
		throw new ImageInputError(
			`Not an image: ${file.type || "unknown"}`,
			"not-image",
		);
	}
	if (file.size > MAX_INPUT_BYTES) {
		throw new ImageInputError(
			`File too large: ${file.size} bytes`,
			"too-large",
		);
	}

	// 用 createObjectURL 而非 FileReader.readAsDataURL —— 后者会把整个
	// 文件 base64 化进 JS 字符串，10MB 图片会分配 ~14MB 的 V8 字符串，
	// 浪费内存。Object URL 是 0 拷贝，<img> 直接走浏览器原生解码。
	const objectUrl = URL.createObjectURL(file);
	try {
		const img = await loadImage(objectUrl);
		// 计算缩放比例 —— 保持长宽比，只缩小不放大
		const ratio = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
		const targetW = Math.max(1, Math.round(img.width * ratio));
		const targetH = Math.max(1, Math.round(img.height * ratio));

		const canvas = document.createElement("canvas");
		canvas.width = targetW;
		canvas.height = targetH;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			throw new ImageInputError("Canvas 2D not available", "decode-failed");
		}
		// 先填充白底 —— 防止透明 PNG 转 JPEG 时默认黑底
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, targetW, targetH);
		ctx.drawImage(img, 0, 0, targetW, targetH);
		return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
	} finally {
		// objectURL 必须显式释放，否则浏览器会一直 hold 住 File 引用
		URL.revokeObjectURL(objectUrl);
	}
}

/** 把 Object URL 加载成 <img> 元素，封装事件 → Promise */
function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () =>
			reject(
				new ImageInputError("Failed to decode image", "decode-failed"),
			);
		img.src = src;
	});
}
