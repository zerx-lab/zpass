// 空间（Workspace / Space）store —— 多账户空间状态管理
// ---------------------------------------------------------------------------
// 场景：
//   一个用户（同一台设备）可能有多个独立账户空间，比如：
//     - "个人" —— 日常登录、银行卡、私人笔记
//     - "工作" —— 公司 SSO、运维 SSH、共享凭证
//   类似概念在其它产品里对应：
//     - 1Password "Accounts"
//     - Bitwarden "Organizations"
//     - Notion "Workspaces"
//     - Slack 的工作区切换器
//
// 本 store 负责：
//   1. 空间列表（id / name / glyph / tag）
//   2. 当前激活的空间 id（activeSpaceId）
//   3. 增删改 + 切换
//   4. 首次启动引导标记（hasCompletedOnboarding）
//
// ---------------------------------------------------------------------------
// 设计决策：
//   - 空间之间是逻辑隔离的"视图容器"，真实 vault 数据隔离在后续 Tauri 端落地；
//     当前原型层只负责 UI 切换，不动 vault store 数据，避免这一 PR 体积过大。
//   - 持久化 activeSpaceId：用户下次启动应该回到上次的空间，而不是每次回到第一个。
//   - 不把 lock / prefs 放进 Space —— 锁定是会话态，偏好是设备级（一台设备一套主题），
//     不随空间切换变化。这与 1Password 的行为一致。
//
// ---------------------------------------------------------------------------
// v2 变更（首次使用引导）：
//   之前版本预置了 "Personal" + "Work" 两个空间作为 onboarding 捷径，
//   但产品决策调整：首次启动应该由 <OnboardingPage /> 引导用户**亲自命名**
//   第一个空间（类似 Notion / Linear 的首跑体验），理由：
//     1. 预置名字与用户真实心智模型错位（中文用户看到 "Personal" 感觉割裂）
//     2. "创建自己的空间"这一动作本身让用户理解空间概念，比读文档有效
//     3. 留白的空间列表是"用户从未完成配置"的可靠信号，路由守卫据此分流
//
//   因此：
//     - 默认 spaces 列表为空
//     - 默认 activeSpaceId 为空串
//     - 新增 hasCompletedOnboarding 字段：首个空间创建后置 true
//     - 路由层（OnboardingGuard）据此决定是否把用户送去 /onboarding
//
// ---------------------------------------------------------------------------
// 存储后端：
//   通过 createTauriConfigStorage 落盘到 ~/.config/zpass/zpass.spaces.json，
//   严禁使用 localStorage / IndexedDB（产品硬性约束）。详见
//   src/lib/config-storage.ts 头部注释。

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createTauriConfigStorage } from "@/lib/config-storage";

/**
 * 单个空间定义
 * ---------------------------------------------------------------------------
 * - `id`：稳定标识（生成后不变），用于持久化与引用
 * - `name`：用户可见名称，可编辑
 * - `glyph`：2 个字符以内的"空间字形"，显示在 Sidebar 顶部方块里
 *   取代原来固定的 "Z" 标志。默认用 name 首字母。
 * - `tag`：副标题，像 brand_tag 那样的一句话，随空间切换改变 Sidebar 的 tag 行文案
 * - `avatarDataUrl`：用户上传的自定义头像（base64 data URL）。有值时
 *   优先于 glyph 渲染为图片头像；没有则回落到 glyph 文字方块。
 *   选 base64 落 spaces.json 的原因：
 *     1. 与现有持久化通道（Tauri 配置文件）天然兼容，不引入额外的
 *        二进制资源管理 / 文件路径系统
 *     2. 头像通常 < 100KB，落 JSON 不会引发可感知的 IO 抖动
 *     3. 跨平台行为一致，无需为 Windows / macOS / Linux 各自实现
 *        资源解析逻辑
 *   上传时在前端做 resize + 压缩到 ≤256×256 + JPEG 0.85 质量，避免
 *   用户上传 4K 原图把配置文件撑爆。
 * - `createdAt`：纯信息字段，用于空间列表排序与"最近创建"指示
 */
export interface Space {
	id: string;
	name: string;
	glyph: string;
	tag?: string;
	avatarDataUrl?: string;
	createdAt: number;
}

export interface SpacesState {
	/** 所有空间列表（按 createdAt 升序） */
	spaces: Space[];
	/**
	 * 当前激活的空间 id
	 *
	 * 为空串（""）表示"还没有任何空间"（首次安装未完成 onboarding）。
	 * 有值时一定是 `spaces` 中某一项的 id（由 onRehydrateStorage 兜底校验）。
	 */
	activeSpaceId: string;
	/**
	 * 是否已完成首次引导（创建了至少一个空间）
	 *
	 * - `false`：首次安装，路由应该把用户送到 /onboarding
	 * - `true`：已经创建过至少一个空间，正常进入 /vault
	 *
	 * 为什么不用 `spaces.length > 0` 推断：
	 *   - 用户可能手动删除所有空间（虽然 UI 禁止删最后一个，极端情况配置
	 *     文件被外部编辑）；此时仍应视为"已完成引导"，避免重复 onboarding
	 *     打扰用户。
	 *   - 显式字段 = 显式意图，与 prefs 的 langFollowSystem 同理。
	 */
	hasCompletedOnboarding: boolean;

	/** 切换到指定空间 —— 找不到时静默忽略（防止 persist 过期数据把 UI 打崩） */
	switchSpace: (id: string) => void;
	/**
	 * 新建空间；返回新空间 id
	 *
	 * 副作用：
	 *   - 新空间被自动激活（activeSpaceId = 新 id）
	 *   - 如果是第一个空间，hasCompletedOnboarding 置 true
	 *
	 * @param patch 可指定 name / glyph / tag，缺省会根据 name 生成
	 */
	createSpace: (patch: { name: string; glyph?: string; tag?: string }) => string;
	/** 重命名 / 改 glyph / 改 tag */
	updateSpace: (id: string, patch: Partial<Omit<Space, "id" | "createdAt">>) => void;
	/**
	 * 删除空间；若删除的是当前激活空间，会自动切到列表第一个
	 * 禁止删除最后一个空间（UI 层也要隐藏删除按钮）
	 */
	removeSpace: (id: string) => void;
	/**
	 * 显式标记引导完成
	 *
	 * 一般不需要手动调用 —— createSpace 会自动翻转。保留此方法供测试与
	 * "导入已有配置"场景使用。
	 */
	completeOnboarding: () => void;
}

/** 默认 glyph：取 name 首字符大写；中文直接原样取第一个字符 */
function deriveGlyph(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "·";
	// 为避免 emoji / 组合字符被截断，用 Array.from 拿第一个"可视字符"
	const first = Array.from(trimmed)[0] ?? "·";
	return first.toUpperCase();
}

/** 生成空间 id —— 短随机，足够本地唯一 */
function genSpaceId(): string {
	return `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 初始空间列表
 * ---------------------------------------------------------------------------
 * v2 起不再预置任何空间。首次安装走 /onboarding 路径，让用户亲手创建
 * 第一个空间（详见本文件顶部的 v2 设计注释）。
 *
 * 保留一个单独的工厂函数（而不是直接写 `spaces: []`）是为了：
 *   1. onRehydrateStorage 兜底重置时复用同一路径
 *   2. 未来如果产品决策改回"预置示例空间"，改这一个地方即可
 */
function getInitialSpaces(): Space[] {
	return [];
}

export const useSpacesStore = create<SpacesState>()(
	persist(
		(set, get) => ({
			spaces: getInitialSpaces(),
			activeSpaceId: "",
			hasCompletedOnboarding: false,

			switchSpace: (id) => {
				const exists = get().spaces.some((s) => s.id === id);
				if (!exists) return;
				set({ activeSpaceId: id });
			},

			createSpace: ({ name, glyph, tag }) => {
				const id = genSpaceId();
				const next: Space = {
					id,
					name: name.trim() || "Untitled",
					glyph: (glyph?.trim() || deriveGlyph(name)).slice(0, 2),
					tag: tag?.trim() || undefined,
					createdAt: Date.now(),
				};
				set((s) => ({
					spaces: [...s.spaces, next],
					// 新建后自动切过去 —— 用户通常希望立即开始用新空间
					activeSpaceId: id,
					// 任何一次成功创建都视为完成引导（无论之前状态如何）
					hasCompletedOnboarding: true,
				}));
				return id;
			},

			updateSpace: (id, patch) =>
				set((s) => ({
					spaces: s.spaces.map((sp) => {
						if (sp.id !== id) return sp;
						// glyph 解析规则（按优先级）：
						//   1. patch 显式传了 glyph —— 用户在编辑面板里手动改字符，
						//      去 trim + slice(0, 2)；空串回落原值（避免出现"·"占位）
						//   2. patch 改了 name 但没传 glyph —— 自动跟随新名字派生
						//      （这是最常见路径：用户在重命名对话框里只改了名字，
						//      期望头像也跟着变成新首字母。原实现保留旧 glyph
						//      会导致截图里 "T 头像 + zerx 名字" 的不一致 bug）
						//   3. patch 既没传 glyph 也没改 name —— 保持原 glyph 不变
						let nextGlyph = sp.glyph;
						if (patch.glyph !== undefined) {
							const trimmed = patch.glyph.trim().slice(0, 2);
							nextGlyph = trimmed || sp.glyph;
						} else if (patch.name !== undefined && patch.name !== sp.name) {
							nextGlyph = deriveGlyph(patch.name);
						}
						return {
							...sp,
							...patch,
							glyph: nextGlyph,
						};
					}),
				})),

			removeSpace: (id) =>
				set((s) => {
					// 禁止删最后一个 —— UI 层也会隐藏删除入口，这里做一次兜底
					if (s.spaces.length <= 1) return s;
					const nextSpaces = s.spaces.filter((sp) => sp.id !== id);
					// 若删的是当前激活，落到第一个
					const nextActive = s.activeSpaceId === id ? nextSpaces[0].id : s.activeSpaceId;
					return { spaces: nextSpaces, activeSpaceId: nextActive };
				}),

			completeOnboarding: () => set({ hasCompletedOnboarding: true }),
		}),
		{
			// name 同时是 Rust 侧 namespace，落盘到 ~/.config/zpass/zpass.spaces.json
			name: "zpass.spaces",
			// 走 Tauri 配置文件存储，严禁使用浏览器 store（产品硬性约束）
			// 详见 src/lib/config-storage.ts 头部注释
			storage: createTauriConfigStorage<Partial<SpacesState>>(),
			version: 3,
			partialize: (state) => ({
				spaces: state.spaces,
				activeSpaceId: state.activeSpaceId,
				hasCompletedOnboarding: state.hasCompletedOnboarding,
			}),
			/**
			 * 迁移链
			 * ---------------------------------------------------------------
			 * v1 → v2：引入 `hasCompletedOnboarding` 字段，默认空间列表清空。
			 *   v1 的老用户已经在使用预置的 "Personal" / "Work" 空间，不应
			 *   被回退到 onboarding 页。迁移策略：
			 *     - 保留 v1 的 spaces / activeSpaceId
			 *     - hasCompletedOnboarding 置 true（他们已经在用，当然算完成引导）
			 *   只有从未启动过的新用户（没有持久化文件）才会拿到空列表的默认值
			 *   并进入 /onboarding。
			 *
			 * v2 → v3：Space 增加可选字段 `avatarDataUrl`（自定义头像图片）。
			 *   纯加字段、未删未改，老存档原样可读 —— `avatarDataUrl` 默认
			 *   undefined，UI 自动回落到 glyph 文字头像。无须任何迁移动作，
			 *   仅升 version 号让未来加迁移时有清晰起点。
			 */
			migrate: (persisted, version) => {
				const state = (persisted ?? {}) as Partial<SpacesState>;
				let next: Partial<SpacesState> = state;
				if (version < 2) {
					next = {
						...next,
						hasCompletedOnboarding: true,
					};
				}
				// v2 → v3 仅是可选字段新增，无需主动迁移
				return next as SpacesState;
			},
			/**
			 * 恢复后兜底校验：
			 *   - spaces 为空时，activeSpaceId 必须是空串，hasCompletedOnboarding
			 *     也应该是 false（未完成引导的干净状态）
			 *   - spaces 非空时，activeSpaceId 必须存在于 spaces 中，否则回落到第一个
			 *
			 * 这一步避免"持久化数据损坏时整个侧边栏空白"或"路由守卫无限重定向"。
			 */
			onRehydrateStorage: () => (state) => {
				if (!state) return;
				if (!state.spaces || state.spaces.length === 0) {
					state.spaces = [];
					state.activeSpaceId = "";
					// 注意：不强制把 hasCompletedOnboarding 置 false —— 用户可能
					// 手动清空了所有空间（虽然 UI 禁止删最后一个，配置文件被外部
					// 编辑时仍可能发生），此时仍视为已完成引导，避免重复引导打扰。
					return;
				}
				const has = state.spaces.some((s) => s.id === state.activeSpaceId);
				if (!has) {
					state.activeSpaceId = state.spaces[0].id;
				}
			},
		},
	),
);

/**
 * 便捷 selector —— 读取当前激活的空间对象
 *
 * 组件里：`const active = useActiveSpace();`
 * 避免每个消费者都写一遍 `spaces.find(s => s.id === activeSpaceId)`。
 *
 * 返回 `Space | null`：
 *   - `null` 表示"还没有任何空间"（首次安装未完成 onboarding）
 *   - 非 null 时保证是 `spaces` 中的有效项（onRehydrateStorage 校验）
 *
 * 老版本该 selector 返回 `Space`（非 null），消费方在首启空列表场景下
 * 会直接崩。现在消费方（WorkspaceSwitcher / Sidebar 的品牌区）必须
 * 处理 null 分支 —— 正常产品流程下路由守卫会把用户挡在 /onboarding，
 * 不会出现 null 的 UI 态；但类型系统保留这个可能性作为防御。
 */
export function useActiveSpace(): Space | null {
	return useSpacesStore((s) => {
		if (s.spaces.length === 0) return null;
		const found = s.spaces.find((sp) => sp.id === s.activeSpaceId);
		// spaces 非空但 activeSpaceId 失效时兜底回第一个（onRehydrateStorage
		// 理论上已经保证，这里做一次运行时防御）
		return found ?? s.spaces[0];
	});
}
