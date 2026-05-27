// ItemIcon — Vault 条目的"网站 icon + 字形回退"统一组件
// ---------------------------------------------------------------------------
// 行为：
//   - 优先用 host 解析出域名,从 DuckDuckGo icons CDN 加载 favicon
//   - 加载失败 / 无 host / 非可联网类型 → 回退到 tint 渐变 + 首字母字形
//
// 隐私 trade-off（zero-knowledge 项目背景下）：
//   favicon 通过 https://icons.duckduckgo.com/ip3/<domain>.ico 取,会向第三方
//   暴露用户访问的站点列表(host 维度)。选 DuckDuckGo 而非 Google s2 是因为
//   DuckDuckGo 明确不做 tracking; 即便如此仍是 trade-off。后续可加 Settings
//   开关让用户关闭外部 favicon 加载（feedback 决定）。
//
// 视觉：
//   - 与 .zpass-glyph / .zpass-hero-glyph 一致,继承外层圆角与阴影
//   - favicon 加载完成前 / 失败后 都显示字形,无白屏 / broken image
//   - 加载成功后 favicon 占满方块（object-fit: cover）

import { clsx } from "clsx";
import { useEffect, useMemo, useState } from "react";
import type { VaultItemType } from "@/stores/vault";

interface ItemIconProps {
	/** 条目类型,决定 tint 渐变与是否尝试 favicon */
	type: VaultItemType;
	/** 条目显示名,用于 fallback 字形 */
	name: string;
	/** 站点 host / URL / rpId,用于 favicon 加载;可选 */
	host?: string | null;
	/** 视觉变体: list-row(32px)或 hero(64px) */
	variant?: "row" | "hero";
}

/**
 * 从 url / host 字符串中提取规范的 host
 * - "https://github.com/login" → "github.com"
 * - "github.com/foo" → "github.com"
 * - "GitHub.com" → "github.com"
 * - 空字符串 / 无效 → null
 */
function extractHost(input: string | null | undefined): string | null {
	if (!input) return null;
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const withScheme = /^https?:\/\//i.test(trimmed)
			? trimmed
			: `https://${trimmed}`;
		const u = new URL(withScheme);
		const host = u.hostname.toLowerCase();
		// host 至少包含一个点（避免 "localhost" / 单词 这种）
		if (!host.includes(".")) return null;
		return host;
	} catch {
		return null;
	}
}

/** 只对"可联网"类型尝试 favicon —— card / note / identity / ssh / totp 不可联网 */
const FAVICON_TYPES: ReadonlySet<VaultItemType> = new Set([
	"login",
	"passkey",
] satisfies VaultItemType[]);

// 模块级"本次会话内已成功加载过的 favicon URL"集合。
//
// 解决"切换条目时 hero icon 闪烁"问题：详情区 hero ItemIcon 在每次 selectedId
// 变动时都会被重新挂载,组件内部 status state 总是从 "idle" 起步,走完
// useEffect → new Image() → onload → setState 之后才会切到 "loaded"。即便
// 浏览器已经把这张 favicon 缓存在 HTTP cache 里,React 仍然会先渲染一帧
// fallback 字形再切到 favicon —— 肉眼即是"闪一下灰底字形"。
//
// 把"加载成功过的 URL"提到模块作用域,新挂载的 ItemIcon 若发现 URL 已在
// 集合中,就把初始 status 设为 "loaded",直接渲染 <img>,跳过 idle 帧。
// HTTP cache 即便过期或失效,<img> 的 onError 兜底会把状态降级回 "error"
// 显示 fallback,不会留下 broken image。
const LOADED_FAVICONS = new Set<string>();

export function ItemIcon({ type, name, host, variant = "row" }: ItemIconProps) {
	const glyph = (Array.from(name)[0] ?? "·").toUpperCase();
	const resolvedHost = useMemo(() => extractHost(host), [host]);
	const canFetchFavicon = FAVICON_TYPES.has(type) && resolvedHost !== null;

	const faviconUrl =
		canFetchFavicon && resolvedHost
			? `https://icons.duckduckgo.com/ip3/${resolvedHost}.ico`
			: null;

	// 三态切换 + 预加载（关键：fallback 与 img 不允许共存）
	//   idle   —— 没尝试加载 / 正在 new Image() 异步加载,渲染 tint 渐变 + 字形
	//   loaded —— 预加载完成,仅渲染 <img>,fallback 不出现在 DOM 里
	//   error  —— 预加载失败 / 不支持类型,仅渲染 fallback
	// 用 new Image() 预加载而非直接 <img onLoad>,是因为 onLoad/onError 触发期间
	// fallback 和 img 会短暂共存于 DOM(absolute 叠加),favicon 透明边缘会漏出
	// fallback 的 tint 渐变与字形 —— 用户截图就是这个问题。预加载完成后再"原子"
	// 切换 DOM 结构,二者绝不重叠,任意 favicon(含透明 PNG / 小尺寸放大)都干净。
	//
	// 初始 status 用 lazy initializer 查 LOADED_FAVICONS：本次会话内已成功
	// 加载过的 URL 直接初始化为 "loaded",跳过 idle 闪烁帧（详见集合声明处注释）。
	const [status, setStatus] = useState<"idle" | "loaded" | "error">(() =>
		faviconUrl && LOADED_FAVICONS.has(faviconUrl) ? "loaded" : "idle",
	);
	useEffect(() => {
		if (!faviconUrl) {
			setStatus("error");
			return;
		}
		if (LOADED_FAVICONS.has(faviconUrl)) {
			setStatus("loaded");
			return;
		}
		setStatus("idle");
		let cancelled = false;
		const probe = new Image();
		probe.referrerPolicy = "no-referrer";
		probe.onload = () => {
			if (cancelled) return;
			LOADED_FAVICONS.add(faviconUrl);
			setStatus("loaded");
		};
		probe.onerror = () => {
			if (!cancelled) setStatus("error");
		};
		probe.src = faviconUrl;
		return () => {
			cancelled = true;
			probe.onload = null;
			probe.onerror = null;
		};
	}, [faviconUrl]);

	const sizeClass = variant === "hero" ? "h-16 w-16" : "h-8 w-8";
	const textClass = variant === "hero" ? "text-[26px]" : "text-[12px]";
	const fallbackBaseClass =
		variant === "hero" ? "zpass-hero-glyph" : "zpass-glyph";
	const minimalRadiusClass =
		variant === "hero" ? "rounded-(--radius-xl)" : "rounded-(--radius)";

	// 加载完成 → "macOS app icon 装在小卡片"观感（对标 Bitwarden 列表）：
	//   - 浅底 + 1px 软描边构成"图标卡",让 favicon 不直接贴 selected 行底色
	//   - 内边距(row 4px / hero 12px)让 favicon 像 app icon 有外留白
	//   - 不挂 box-shadow / 渐变 / 字形 —— 由 favicon 像素自表达
	// favicon CDN 返回的图本身没 padding（裸 logo）,容器加 padding 才不"顶满"。
	if (status === "loaded" && faviconUrl) {
		const padClass = variant === "hero" ? "p-3" : "p-1";
		return (
			<div
				className={clsx(
					"shrink-0 overflow-hidden border border-(--line-soft) bg-(--bg-elev-2)",
					sizeClass,
					minimalRadiusClass,
					padClass,
				)}
			>
				<img
					src={faviconUrl}
					alt=""
					aria-hidden="true"
					draggable={false}
					referrerPolicy="no-referrer"
					onError={() => {
						// 兜底：LOADED_FAVICONS 命中但 HTTP cache 已失效/损坏时
						// 把状态降级回 error,显示 fallback 字形,避免 broken image
						LOADED_FAVICONS.delete(faviconUrl);
						setStatus("error");
					}}
					style={{
						display: "block",
						width: "100%",
						height: "100%",
						objectFit: "contain",
					}}
				/>
			</div>
		);
	}

	// 加载中 / 失败 / 不支持类型 → 渲染 tint 渐变方块 + 字形 fallback
	return (
		<div
			className={clsx(
				"shrink-0",
				sizeClass,
				fallbackBaseClass,
				`zpass-tint-${type}`,
				textClass,
			)}
		>
			<span aria-hidden>{glyph}</span>
		</div>
	);
}

export default ItemIcon;
