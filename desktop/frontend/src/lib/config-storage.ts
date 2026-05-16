// Wails 配置文件存储适配器 —— zustand persist 后端
// ---------------------------------------------------------------------------
// 把 zustand 的 `PersistStorage<T>` 接口对接到 Go 侧 `ConfigService` 的
// Read / Write / Remove / Dir 方法，最终落盘到 `~/.config/zpass/<ns>.json`。
//
// 为什么不能直接用 `createJSONStorage(() => localStorage)`：
//   1. 产品硬性要求：配置严禁使用浏览器 store（localStorage / sessionStorage /
//      IndexedDB）。所有偏好、空间列表、账户登录态必须落到用户目录下的
//      真实文件，用户"看得见、可删除、可备份"。
//   2. 零知识架构的直觉：密码管理器的元数据放在 WebView 沙盒里，意味着用户
//      没有可感知的副本路径，换 WebView 运行时（WebView2 / WKWebView /
//      WebKitGTK）还会导致数据丢失 —— 不符合产品定位。
//
// 为什么用 `PersistStorage` 而不是 `createJSONStorage`：
//   - `createJSONStorage` 只接受"同步风格"的 Storage（getItem 直接返回字符串），
//     而 Wails 的 Call.ByName 天然是 Promise<T>，无法伪装成同步。
//   - zustand v5 的 `PersistStorage<T>` 接口明确允许 getItem 返回 Promise，
//     persist 中间件内部会 await；这是官方推荐的异步持久化写法。
//   - 代价：首次 hydrate 存在一段"默认值 → 持久化值"的切换。通过
//     `onFinishHydration` 订阅点可以在前端对 hydrate 完成做出反应
//     （例如 OnboardingGuard 等待完成后再做路由判断）。
//
// ---------------------------------------------------------------------------
// 为什么用 `wails3 generate bindings` 产物（而不是 `Call.ByName`）：
//   1. 生成的 JS 走 `Call.ByID(<numeric>)`，Wails 3 在 webview 启动时把
//      ID → 方法的路由表注册好，调用零字符串解析、零反射，性能更好。
//   2. JS 文件含 JSDoc 类型注释，在 TS 项目里能自动获得参数与返回值类型，
//      重命名 / 改签名时编译期就能发现破裂调用。
//   3. 与 Wails 3 官方推荐的工作流一致：开发流程 `wails3 generate bindings`
//      → vite 插件检测到 bindings/ 存在 → 构建通过。Vite 插件本身就要求
//      `bindings/` 目录可用（否则 `npm run build` 会失败）。
//
// 调用约定：
//   - bindings 路径形如 `bindings/<go-module>/<package>` —— 我们的 Go
//     module 在 go.mod 是 `github.com/zerx-lab/zpass/zpass-desktop`，主包
//     就是 `zpass-desktop`，所以 ConfigService 落在
//     `bindings/github.com/zerx-lab/zpass/zpass-desktop/`。
//   - 相对路径较长，但 vite 别名扩展不必要 —— 只在本文件单点引用。
//
// ---------------------------------------------------------------------------
// 容错策略：
//   - Go 方法失败（I/O 错误、JSON 非法）时 getItem 返回 null，persist
//     会回落到 store 的默认值 —— 比把错误往上抛让整个 app 白屏友好。
//   - 错误写到 console.error 保留诊断信息，但不弹 UI（配置存储失败不该
//     打断主流程，用户下一次操作会再次触发写入尝试）。
//   - SSR / 测试环境（没有 Wails 运行时）下自动降级：探测
//     `window._wails` 是否存在；不在 Wails 环境中时用一个纯内存 Map 顶替，
//     让单元测试 / vite preview 不至于崩。

import type { PersistStorage, StorageValue } from "zustand/middleware";
// 由 `wails3 generate bindings` 自动生成；切勿手动编辑。
// 路径反映 Go module 路径 + 包名（见本文件头部注释）。
import * as ConfigService from "@/../bindings/github.com/zerx-lab/zpass/zpass-desktop/configservice.js";

/**
 * 运行时是否处于 Wails 环境
 *
 * Wails 3 在 webview 启动早期把 `window._wails`（含 environment / clientId
 * 等内部字段）注入页面。只要这个对象存在，就认为 Call.ByName 路由可用。
 *
 * 非 Wails 环境（`vite preview`、Vitest、Storybook 等）下走内存 fallback，
 * 避免 Call.ByName 抛"cannot communicate with backend"。
 */
function isWailsRuntime(): boolean {
	if (typeof window === "undefined") return false;
	return Boolean((window as unknown as { _wails?: unknown })._wails);
}

/**
 * 非 Wails 环境下的内存 fallback
 *
 * 仅用于开发 / 测试：在纯浏览器 `vite preview` 场景下让 app 不至于直接崩。
 * 真实生产环境始终走 Go 侧 `ConfigService.Read/Write/Remove`。
 *
 * 不用 localStorage 顶替：那会违背"严禁使用浏览器 store"的产品约束；
 * 内存 Map 的副作用仅限当前 tab，刷新后即清空，正好是"配置未落盘"的
 * 诚实表现，便于开发期发现"忘了在 Wails 里跑"的问题。
 */
const memoryStore = new Map<string, string>();

/**
 * 调用 Go `ConfigService.Read(namespace)` 方法
 *
 * 返回：文件内容字符串 / null（文件不存在 / 出错，已 log）
 *
 * 任何错误都被降级为 null，让上层 persist 自然回落到默认值 —— 这比把
 * 异常往上抛让 React 组件崩溃友好得多。
 */
async function readConfigFile(namespace: string): Promise<string | null> {
	if (!isWailsRuntime()) {
		return memoryStore.get(namespace) ?? null;
	}
	try {
		// Go 侧返回 (string, error)；当文件不存在时返回 ("", nil)，本模块
		// 仍把空串视为"无内容"——zustand persist 会拿空串再 JSON.parse 失败，
		// 我们提前转 null 避免误判。
		const result = await ConfigService.Read(namespace);
		if (result == null || result === "") return null;
		return result;
	} catch (err) {
		console.error(`[config-storage] Read(${namespace}) failed:`, err);
		return null;
	}
}

/**
 * 调用 Go `ConfigService.Write(namespace, value)` 方法
 *
 * 写入失败不抛出 —— 仅 log.error。理由：
 *   - zustand persist 的 setItem 在每次 state 变更时触发，如果抛错会导致
 *     React 状态更新链条中断，用户操作表面上"无反应"，排查成本高。
 *   - 落盘失败通常是权限 / 磁盘满等罕见问题，静默 + 日志 + 下次尝试
 *     是更稳妥的策略；真正需要强一致的写入由 vault 加密层单独处理。
 */
async function writeConfigFile(
	namespace: string,
	value: string,
): Promise<void> {
	if (!isWailsRuntime()) {
		memoryStore.set(namespace, value);
		return;
	}
	try {
		await ConfigService.Write(namespace, value);
	} catch (err) {
		console.error(`[config-storage] Write(${namespace}) failed:`, err);
	}
}

/**
 * 调用 Go `ConfigService.Remove(namespace)` 方法
 *
 * zustand 正常流程不会触发 removeItem（persist 通过 setItem 覆盖），
 * 但实现完整是为了给"恢复默认设置 / 退出账户时清空"等未来能力留接口。
 */
async function removeConfigFile(namespace: string): Promise<void> {
	if (!isWailsRuntime()) {
		memoryStore.delete(namespace);
		return;
	}
	try {
		await ConfigService.Remove(namespace);
	} catch (err) {
		console.error(`[config-storage] Remove(${namespace}) failed:`, err);
	}
}

/**
 * 创建一个 zustand `PersistStorage<T>` 实现，底层走 Wails 服务方法
 *
 * 典型用法：
 *
 * ```ts
 * import { createWailsConfigStorage } from "@/lib/config-storage";
 *
 * usePrefsStore = create<State>()(
 *   persist(
 *     (set) => ({ ... }),
 *     {
 *       name: "zpass.prefs",
 *       storage: createWailsConfigStorage<PartialPersistedState>(),
 *       ...
 *     },
 *   ),
 * );
 * ```
 *
 * 注意：
 *   - `name`（第一个参数）会被直接用作 Go 侧的 namespace，落到
 *     `~/.config/zpass/<name>.json`。必须匹配 Go 的 namespace 校验规则：
 *     `[A-Za-z0-9_.-]{1,64}`，否则写入会被后端拒绝（错误被静默 log）。
 *     约定 `zpass.<slice>` 格式。
 *   - 泛型 `T` 通常设为 store 中**参与 persist 的字段**的联合类型
 *     （即 `partialize` 返回值的类型）。
 */
export function createWailsConfigStorage<T>(): PersistStorage<T> {
	return {
		/**
		 * 读取持久化数据
		 *
		 * zustand persist 协议：
		 *   - 返回 `null` → 没有持久化数据，使用 store 默认值（首次启动）
		 *   - 返回 `StorageValue<T>` → hydrate 到该状态
		 *   - 返回 Promise → persist 会 await，期间 hasHydrated=false
		 *
		 * 解析失败（JSON 损坏）同样回落到 null —— 比让 React 树崩溃好。
		 * 该场景下用户会看到"设置被重置"，这已经比白屏友好得多。
		 */
		getItem: async (name: string): Promise<StorageValue<T> | null> => {
			const raw = await readConfigFile(name);
			if (raw == null) return null;
			try {
				return JSON.parse(raw) as StorageValue<T>;
			} catch (err) {
				console.error(
					`[config-storage] malformed JSON in ${name}.json, falling back to defaults:`,
					err,
				);
				return null;
			}
		},

		/**
		 * 写入持久化数据
		 *
		 * zustand 会在每次 state 变更后调用此方法，传入完整的
		 * `{ state, version }` 结构（partialize 已经过滤过字段）。
		 * 我们按原样 JSON.stringify 后交给 Go 原子写。
		 *
		 * 写入频率：zustand persist 不做合并 / 节流，所以每一次 setState
		 * 都会触发写盘。这对配置文件来说完全够用（用户 UI 操作频率远
		 * 低于 IO 带宽），未来如果 hot-path store（如 vault 全量同步）
		 * 需要节流，可在这里加 debounce —— 当前保持最简。
		 */
		setItem: async (name: string, value: StorageValue<T>): Promise<void> => {
			const serialized = JSON.stringify(value);
			await writeConfigFile(name, serialized);
		},

		/**
		 * 清空某 namespace 对应的持久化数据
		 *
		 * zustand 正常 persist 流程不会主动调用 removeItem（通过 setItem
		 * 覆盖即可表达"置空"），但暴露给调用方用作"恢复默认设置"等
		 * 显式清空场景。
		 */
		removeItem: async (name: string): Promise<void> => {
			await removeConfigFile(name);
		},
	};
}

/**
 * 兼容旧名 —— desktop 子项目里既有 store 还在导入 createTauriConfigStorage。
 * 保留同名导出，避免迁移过程中要去改十几个 store 文件；后续可逐步替换为
 * createWailsConfigStorage。两者完全等价。
 */
export const createTauriConfigStorage = createWailsConfigStorage;

/**
 * 直接暴露底层操作，供 persist 之外的场景使用
 *
 * 典型用途：
 *   - Settings 页"关于"区展示配置目录路径
 *   - 开发面板显示原始 JSON 内容便于诊断
 *   - "恢复默认设置"按钮显式删除文件
 *
 * 这些函数都做了错误降级，不会抛异常打断调用方。
 */
export const configStorage = {
	/** 读取 ~/.config/zpass/ 的绝对路径（不创建目录） */
	async dir(): Promise<string | null> {
		if (!isWailsRuntime()) return null;
		try {
			return await ConfigService.Dir();
		} catch (err) {
			console.error("[config-storage] Dir failed:", err);
			return null;
		}
	},
	/** 按 namespace 读取原始 JSON 文本 */
	read: readConfigFile,
	/** 按 namespace 原子写入 JSON 文本 */
	write: writeConfigFile,
	/** 按 namespace 删除文件（幂等） */
	remove: removeConfigFile,
	/** 运行时环境探测 —— 组件里可用于分支文案 */
	isWails: isWailsRuntime,
	/** 兼容旧名 —— 等同于 isWails */
	isTauri: isWailsRuntime,
};

export default createWailsConfigStorage;
