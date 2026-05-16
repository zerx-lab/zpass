// 账户登录态 store —— 登录模式 / 访客模式 / 用户信息
// ---------------------------------------------------------------------------
// 对应产品规格：
//   用户打开 desktop 客户端时，首屏（WelcomePage）提供两个选项：
//     1. 登录云端账户 —— 填写账户密码（非开源，无法自托管，直接登录）
//     2. 跳过 —— 进入访客（本地）模式，不做云端同步
//
//   登录态必须持久化，用户下次启动不应该反复看到欢迎页；跳过也算一种
//   显式选择，同样要持久化（否则每次启动都弹欢迎页是反复打扰）。
//
// ---------------------------------------------------------------------------
// 为什么单独开一个 store 而不塞进 prefs：
//   1. 语义切分：prefs 是"外观偏好"，account 是"身份与登录态"，两类变化
//      频率与敏感度差异大。把登录用户邮箱写进 prefs.json 会让"重置外观"
//      之类的操作误伤账户。
//   2. 未来扩展：account 后续要承载 token / 刷新时间 / 设备 id / 双因子
//      状态等，单独 slice 便于加密字段、做额外的落盘策略（比如 token
//      走系统钥匙串而不是明文 JSON）。
//   3. 当前阶段：登录逻辑未接入真实后端，store 先提供占位字段与切换动作，
//      后续替换为真实 API 返回的会话信息即可，不影响上层 UI。
//
// ---------------------------------------------------------------------------
// 存储后端：
//   走 createTauriConfigStorage，落盘到 ~/.config/zpass/zpass.account.json。
//   严禁使用浏览器 localStorage / IndexedDB（产品硬性约束）。
//
//   注意：token 之类的敏感凭据"长期"不应该放这里 —— 未来接入真实后端时，
//   access_token / refresh_token 应该走操作系统钥匙串（Windows Credential
//   Manager / macOS Keychain / libsecret），这里只保留非敏感的用户标识
//   （邮箱、显示名、头像 URL、登录模式）。当前 user.token 字段仅为占位，
//   真实实现前会迁移走。

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createTauriConfigStorage } from "@/lib/config-storage";

/**
 * 账户模式
 *
 * - `"pending"`：用户尚未做出选择（首次启动，欢迎页未点任何按钮）
 *   路由守卫据此把用户送到 /welcome。
 * - `"guest"`：用户明确选择"跳过登录"，进入本地访客模式。
 *   侧边栏账户区显示"本地模式 / 未登录"，不展示云同步 UI。
 * - `"signed-in"`：用户完成了云端账户登录。
 *   侧边栏展示真实账户信息（邮箱 / 显示名 / 头像）。
 *
 * 为什么需要 "pending" 这个第三态：
 *   - 如果用默认 "guest" 代替 pending，那么用户第一次打开软件会直接
 *     进入访客模式而错过"可以登录获得云同步"的提示，产品意图丢失。
 *   - 用 `null` 表达 pending 虽然省一个字面量，但 TS 下 `null | "guest"
 *     | "signed-in"` 的判空分支比纯字符串联合更啰嗦。显式三态更清晰。
 */
export type AccountMode = "pending" | "guest" | "signed-in";

/**
 * 已登录用户的信息（仅在 mode === "signed-in" 时有值）
 *
 * 字段来源：登录成功后后端返回的用户基本信息。当前登录流程是占位实现，
 * 字段由 signIn() 的入参原样传入；未来接入真实 API 后替换。
 */
export interface SignedInUser {
	/** 后端用户 id —— 稳定标识，不随邮箱变更 */
	id: string;
	/** 登录邮箱 —— 作为用户标识与找回凭据 */
	email: string;
	/** 显示名 —— UI 展示用，用户可在后端侧修改 */
	displayName: string;
	/**
	 * 头像 URL —— 可选；缺省时 UI 用 displayName / email 首字母回退
	 * 不在前端做头像缓存，直接 <img src> 引用（Tauri WebView 有自带的
	 * HTTP 缓存）
	 */
	avatarUrl?: string;
	/**
	 * 占位 token —— 当前仅为 UI 状态判断，真实后端接入时必须迁移到
	 * 操作系统钥匙串（Keychain / Credential Manager / libsecret），
	 * **不应**随本 store 一起落到明文 JSON 配置文件。
	 *
	 * 保留该字段只是让未来迁移时的类型变更更平滑，当前没有任何写入逻辑
	 * 会真正填充它（signIn 里显式忽略）。
	 */
	token?: string;
}

export interface AccountState {
	/** 当前账户模式（pending / guest / signed-in） */
	mode: AccountMode;
	/**
	 * 已登录用户信息；mode !== "signed-in" 时为 null
	 *
	 * 类型上强制配对 —— 消费方做完 mode 判断后可以直接断言非 null。
	 */
	user: SignedInUser | null;

	/**
	 * 切换到访客模式
	 *
	 * 用户在 WelcomePage 点击"跳过"时调用。清空 user，把 mode 置为 "guest"。
	 * 此操作是幂等的，重复调用安全。
	 */
	continueAsGuest: () => void;

	/**
	 * 完成登录 —— 把后端返回的用户信息写入 store
	 *
	 * @param user 登录 API 返回的用户字段。token 字段当前被忽略，预留给
	 *             未来钥匙串迁移；目前 signed-in 态仅用于 UI 展示。
	 *
	 * 副作用：mode 变为 "signed-in"，路由守卫会放行到主界面。
	 */
	signIn: (user: SignedInUser) => void;

	/**
	 * 退出登录
	 *
	 * 退出后回到访客模式（而不是 pending），理由：
	 *   - 用户已经对"是否使用 ZPass"表过态（通过之前的登录动作），退出
	 *     只是不想再同步云端，不等于想重看欢迎页；
	 *   - 想重新看欢迎页的用户可以用"重置应用"（清空 ~/.config/zpass/）
	 *     这种显式动作触发，不应与日常退出登录混淆。
	 *
	 * 如果未来产品决策改变（退出 = 回 pending），改这一个方法即可。
	 */
	signOut: () => void;

	/**
	 * 显式重置到 pending 态 —— 仅供"重置应用"等极端场景使用
	 *
	 * 日常流程不会调用；保留它是为了让"恢复出厂设置"有一个干净入口，
	 * 避免调用方直接 setState 绕过 store API。
	 */
	resetToPending: () => void;
}

/**
 * 默认初始状态 —— 首次启动时所有字段均未决
 *
 * 注意：persist 中间件会在 rehydrate 完成前以此默认值作为首屏渲染的
 * 值。路由守卫必须等 hasHydrated 为 true 后再做分流判断，否则用户会
 * 看到"闪欢迎页 → 瞬间切到主界面"的抖动。见 src/app/OnboardingGuard.tsx。
 */
function getAccountDefaults(): Pick<AccountState, "mode" | "user"> {
	return {
		mode: "pending",
		user: null,
	};
}

export const useAccountStore = create<AccountState>()(
	persist(
		(set) => ({
			...getAccountDefaults(),

			continueAsGuest: () =>
				set({
					mode: "guest",
					user: null,
				}),

			signIn: (user) =>
				set({
					mode: "signed-in",
					// 显式忽略传入的 token —— 当前版本不把 token 写进 store
					// （未来钥匙串迁移准备）。只保留 UI 展示必需的字段。
					user: {
						id: user.id,
						email: user.email,
						displayName: user.displayName,
						avatarUrl: user.avatarUrl,
					},
				}),

			signOut: () =>
				set({
					mode: "guest",
					user: null,
				}),

			resetToPending: () =>
				set({
					mode: "pending",
					user: null,
				}),
		}),
		{
			// name 同时也是 Rust 侧 namespace，落盘到
			// ~/.config/zpass/zpass.account.json
			name: "zpass.account",
			// 走 Tauri 配置文件存储 —— 严禁使用 localStorage / IndexedDB
			// 等浏览器沙盒存储（产品硬性约束，详见 src/lib/config-storage.ts
			// 头部注释）
			storage: createTauriConfigStorage<Partial<AccountState>>(),
			version: 1,
			// 仅持久化数据字段，action 方法不入库
			partialize: (state) => ({
				mode: state.mode,
				user: state.user,
			}),
			/**
			 * 恢复后兜底校验：
			 *   - 如果 mode === "signed-in" 但 user 为 null（配置文件被外部
			 *     编辑或版本迁移出错），回退到 "guest"，避免 Sidebar 读 user
			 *     时的 null 解引用崩溃。
			 *   - 如果 mode 取值不在枚举内（下游新增/删除模式时的老存档），
			 *     回退到 "pending" 让用户重走欢迎页。
			 */
			onRehydrateStorage: () => (state) => {
				if (!state) return;
				const validModes: AccountMode[] = ["pending", "guest", "signed-in"];
				if (!validModes.includes(state.mode)) {
					state.mode = "pending";
					state.user = null;
					return;
				}
				if (state.mode === "signed-in" && !state.user) {
					state.mode = "guest";
					state.user = null;
				}
			},
		},
	),
);

/**
 * 便捷 selector —— 当前是否处于已登录状态
 *
 * 组件里常见的 `const signedIn = useIsSignedIn();` 比 `useAccountStore((s)
 * => s.mode === "signed-in")` 可读性更好，同时订阅粒度也更窄（只在
 * mode 变化时 re-render，不受 user 内字段变更影响）。
 */
export function useIsSignedIn(): boolean {
	return useAccountStore((s) => s.mode === "signed-in");
}

/**
 * 便捷 selector —— 用户在欢迎页是否已经做过选择
 *
 * 用于 OnboardingGuard：mode === "pending" 时把用户送到 /welcome，
 * 其余两种模式（guest / signed-in）都算"已决定"，放行到主应用分支。
 */
export function useHasChosenMode(): boolean {
	return useAccountStore((s) => s.mode !== "pending");
}
