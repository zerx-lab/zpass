// 保险库数据 store —— 由 Go 后端 VaultService 驱动的真实加密保险库
// ---------------------------------------------------------------------------
// 与早期"内置 mock 数据"版本的根本差异：
//   - items 不再来自 src/data/vault.ts 的硬编码 ITEMS，而是通过
//     vaultApi.listItems() 从 ~/.config/zpass/vault.db 解密读出
//   - 增删改全部走 vaultApi.{createItem,updateItem,deleteItem}，
//     落到加密数据库；store 只是"内存视图 + UI 状态"的薄缓存
//   - 仅在 vault 已解锁时才 load —— 锁定状态下保持 items=[]，避免上层
//     UI 误以为"没有条目"和"还没加载"是同一回事；用 status 字段区分
//
// 设计原则：
//   1. 永不把明文条目落到 zustand persist —— 整个 store 不挂 persist 中间件，
//      任何持久化都必须经过 vaultApi 的加密路径。这是"零知识"约定的底线。
//   2. 真实数据来自后端，UI 状态（selectedId / filter / query）是纯前端
//      运行时态。混在同一个 store 里是为了让组件订阅一处即可，但严格区分
//      职责：load() / create() / update() / remove() 触发后端 IPC，
//      其余 setter 只动 UI 字段。
//   3. CRUD 操作完成后**重新拉取整个列表**而不是局部 patch state。理由：
//        - 后端是事实来源，时间戳 / 排序由后端决定
//        - 列表通常 < 几百条，全量重拉成本可忽略
//        - 避免"前端乐观更新与后端结果分歧"导致的 UI 显示错乱
//      代价是每次写都多一次 ListItems IPC，桌面端可接受。
//   4. 错误对外暴露但不抛出：每次操作都把 error 塞到 store.error，
//      让组件订阅展示，避免组件自己处理 try/catch 流程。错误会在下次
//      成功操作时清空。
//
// ---------------------------------------------------------------------------
// 与原 mock 的兼容
//
// 早期 store 暴露的 VaultItem / LoginItem / CardItem 等 union 类型来自
// `src/data/vault.ts`，是为了 mock 数据建模。真实后端只关心 ItemPayload
// 的扁平形状（id / type / name / fields / createdAt / updatedAt），所有
// 类型特定字段（username / password / cardholder / number ...）都在
// `fields` 字段袋里。
//
// 为了让侧边栏 / 详情页迁移过程中不大爆炸，本 store 直接用 vault-api 的
// VaultItemSummary / VaultItemPayload 作为对外类型，原 mock 数据文件
// `src/data/vault.ts` 仍可保留作为占位 / 测试 fixture，但不再被本 store
// 引用。

import { create } from "zustand";
import {
	type BatchTOTPResult,
	type BreachResult,
	type VaultItemInput,
	type VaultItemPayload,
	type VaultItemSummary,
	type VaultItemType,
	vaultApi,
	vaultErrorKind,
} from "@/lib/vault-api";

// ---------------------------------------------------------------------------
// 类型 —— 重新导出方便组件层引用
// ---------------------------------------------------------------------------

export type {
	VaultItemInput,
	VaultItemPayload,
	VaultItemSummary,
	VaultItemType,
};

/**
 * 列表过滤器 —— 与原 mock 版本的 VaultFilter 保持兼容
 *
 * - "all"：不过滤，展示全部条目
 * - VaultItemType：仅展示该类型条目
 * - "fav"：仅展示收藏条目（fields.fav 为真的 login）。当前后端不专门
 *   建索引，过滤在前端解密后内存里做 —— 与设计预期一致（< 10k 条目）
 */
export type VaultFilter = "all" | VaultItemType | "fav";

/**
 * Vault store 加载状态机
 *
 * - "idle"：还没尝试加载（vault 未解锁 / app 刚启动）
 * - "loading"：正在调 vaultApi.listItems()
 * - "ready"：已成功加载，items 反映 DB 当前状态
 * - "error"：上一次加载失败，error 字段含原因；items 保留上一次成功的快照
 *
 * UI 据此区分"列表为空"vs"还在加载"vs"加载失败" —— 三种态在 UX 上
 * 应该呈现完全不同的提示，不能用 `items.length === 0` 一刀切。
 */
export type VaultLoadStatus = "idle" | "loading" | "ready" | "error";

export interface VaultState {
	// ---- 后端数据 ----
	/** 列表摘要（不含 password / totp 等敏感字段）；详情用 fetchItem 拉 */
	items: VaultItemSummary[];
	/**
	 * 已经拉取过完整 payload 的条目缓存
	 *
	 * 详情页 / 编辑表单需要 fields，列表 API 不返回这些字段。fetchItem
	 * 拉到后塞进这里，避免连续点同一条目反复 IPC。任何写操作（update /
	 * remove / lock）都会清空缓存，确保不展示陈旧数据。
	 *
	 * 不持久化，纯运行时缓存。
	 */
	itemDetails: Record<string, VaultItemPayload>;

	/**
	 * 页面级 OTP 快照缓存 —— 跨路由导航保留，避免每次进身份验证器页重新拉码
	 *
	 * key = itemId，value = BatchTOTPResult；
	 * lock/clear 时随其他数据一并清空。
	 */
	otpSnapshots: Record<string, BatchTOTPResult>;

	// ---- UI 状态 ----
	/** 当前选中条目 id（详情面板显示哪条） */
	selectedId: string | null;
	/** 类型 / 收藏过滤器 */
	filter: VaultFilter;
	/** 搜索关键字（name / fields.username / fields.url / tags 等都参与匹配） */
	query: string;

	// ---- 状态机 ----
	status: VaultLoadStatus;
	/** 上一次操作错误的人类可读消息；操作成功时清空 */
	error: string | null;
	/**
	 * 空间切换的单调 epoch —— 防多触发点 load 竞态
	 *
	 * 切空间时 reloadForSpace 递增它；每次 load 在开始时记下当时的 epoch，
	 * 结果回写前若 epoch 已过期（用户又切了空间 / 飞行中的旧 load 后到）则
	 * 丢弃结果，避免旧空间的数据盖回新空间的列表。
	 */
	spaceEpoch: number;

	// ---- Actions ----
	/**
	 * 从后端加载（或重新加载）所有条目
	 *
	 * 调用时机：
	 *   - 解锁成功后（UnlockPage 在 navigate 前 await 一次保证 vault 进入
	 *     主界面时数据已就绪，避免列表闪空）
	 *   - 用户主动刷新（未来加"刷新"按钮）
	 *   - CRUD 操作内部调（保持 items 与 DB 一致）
	 *
	 * vault 未解锁时调用会触发后端返回 "vault is locked"，本方法把状态
	 * 切到 error，items 保持空数组。上层路由守卫应该在锁定状态阻止本调用，
	 * 这里的兜底是为了"组件自我恢复"——比如 Lock 后不刷新页面，下次解锁
	 * 进 vault 列表会重新走 load。
	 */
	load: () => Promise<void>;

	/**
	 * 切换空间后重载：清空当前空间的内存视图（items / 详情缓存 / 选中 / OTP
	 * 快照）→ 递增 spaceEpoch → 重新 load 新空间的数据
	 *
	 * 由 SpaceSync 在 activeSpaceId 变化时调用（已先 setActiveSpace 推送后端）。
	 * 必须清缓存：itemDetails / otpSnapshots / selectedId 都是上一个空间的，
	 * 留着会让详情面板短暂显示旧空间条目。
	 */
	reloadForSpace: () => Promise<void>;

	/**
	 * 拉取单条完整 payload（含 fields）；结果缓存到 itemDetails
	 *
	 * 列表 API 出于性能考虑只返回摘要；详情页 / 编辑表单要 fields 才能
	 * 渲染密码 / 用户名等。fetchItem 强制走 IPC，不会从 itemDetails 缓存
	 * 返回 —— 因为缓存可能陈旧（外部进程改了 DB？另一个会话写入？）。
	 *
	 * 找不到 id 返回 null（与 vaultApi.getItem 契约一致）。
	 */
	fetchItem: (id: string) => Promise<VaultItemPayload | null>;

	/**
	 * 创建新条目；成功后重新 load 整个列表
	 *
	 * 返回新建条目的 id —— 调用方（表单提交）可据此把 selectedId 切到
	 * 新条目，让用户立刻看到刚创建的内容。
	 */
	create: (input: VaultItemInput) => Promise<string>;

	/**
	 * 批量导入条目（用于 Bitwarden / CXF 等外部格式导入）
	 *
	 * 内部循环调用 vaultApi.createItem 逐条加密落库（与单条 create 走同样的
	 * 路径，避免后端再加一个批量接口；代价是 N 次 IPC，但对 1k 内的导入
	 * 完全可接受）。最后只 load 一次，避免每条都重拉列表。
	 *
	 * 返回 { ok, fail, errors }：成功条目数 + 失败条目数 + 错误样本数组
	 * （最多前 5 条，"<name>: <message>" 形式）。失败条目会把错误塞到
	 * state.error 但不会中断后续导入 —— 让用户最大化保留可入库的数据；
	 * errors 同时回传给调用方，便于在 UI 上直接展示失败明细而非只有数字。
	 */
	importMany: (
		inputs: VaultItemInput[],
	) => Promise<{ ok: number; fail: number; errors: string[] }>;

	/**
	 * 整体覆盖现有条目；成功后重新 load 整个列表
	 *
	 * 字段级 patch 由调用方组合：先 fetchItem 拿全量 → 改 fields → 调 update。
	 */
	update: (input: VaultItemInput & { id: string }) => Promise<void>;

	/**
	 * 删除条目；成功后重新 load 整个列表
	 *
	 * 删除后如果 selectedId 正好指向被删条目，自动清空 selectedId（让
	 * 详情面板回到"未选中"占位状态，而不是显示"条目已不存在"错误）。
	 */
	remove: (id: string) => Promise<void>;

	/**
	 * 清空所有内存数据 —— 锁定 / 退出账户时调用
	 *
	 * 不只是 setItems([])，还要把 itemDetails / selectedId / query / filter
	 * 一起复位，避免锁定后下次解锁仍残留旧选中态 / 旧搜索词。
	 *
	 * 这一步是"锁定即清空内存视图"的安全约定 —— 即便后端已经把 DEK 抹零，
	 * 前端也不应该把上次解锁时拿到的明文留在 store 里。
	 */
	clear: () => void;

	// ---- Breach 安全检测 ----
	/**
	 * 上次泄露检测的完整结果列表（含 checkedAt 时间戳）
	 * null = 从未检测过（含重启后缓存尚未读取）
	 */
	breachResults: BreachResult[] | null;
	/** 当前是否正在扫描中 */
	breachScanning: boolean;
	/**
	 * 上次全量扫描完成时间（Unix 毫秒）
	 * null = 从未扫描
	 */
	breachLastScanAt: number | null;

	/**
	 * 触发一次全量泄露扫描
	 * force=true 时先清后端内存缓存再扫（用于手动"重新扫描"）
	 */
	runBreachScan: (force?: boolean) => Promise<void>;
	/**
	 * 对单条 login 条目做即时泄露检测，更新 breachResults 里对应条目
	 * 用于 create / update 后的即时刷新
	 */
	checkItemBreach: (itemId: string) => Promise<void>;

	// ---- Health 安全中心 ----
	/**
	 * 安全中心检测到的问题总数（弱密码 + 已泄露，去重后）
	 *
	 * null = 尚未扫描过（从未进入安全中心页面），与"0个问题"区分。
	 * Sidebar badge 仅在非 null 且 > 0 时显示数字。
	 */
	healthIssueCount: number | null;
	setHealthIssueCount: (count: number) => void;

	/** 批量写入 OTP 快照（TotpPage 调 batchGenerateTOTP 成功后调用） */
	setOtpSnapshots: (results: BatchTOTPResult[]) => void;
	/** 单条更新 OTP 快照（倒计时归零时单条刷新后调用） */
	setOtpSnapshot: (result: BatchTOTPResult) => void;

	// ---- UI setters ----
	selectItem: (id: string | null) => void;
	setFilter: (filter: VaultFilter) => void;
	setQuery: (query: string) => void;
}

/**
 * Vault store 实例
 *
 * **不挂 persist 中间件**：
 *   任何 vault 内容（即便是摘要 name）都不应落到 zustand persist 的 JSON
 *   配置文件里 —— 那会绕过加密层，把明文写到 ~/.config/zpass/zpass.vault.json，
 *   彻底破坏"零知识"约定。所有持久化必须经过 vaultApi 走加密 DB。
 *
 *   UI 临时状态（filter / query / selectedId）不持久化也是有意：
 *     - selectedId 在 vault 锁定时本来就该清；恢复后让用户从头选更安全
 *     - filter / query 是会话级状态，重启后回到默认 ALL / 空串符合直觉
 */
export const useVaultStore = create<VaultState>()((set, get) => ({
	items: [],
	itemDetails: {},
	otpSnapshots: {},
	selectedId: null,
	filter: "all",
	query: "",
	status: "idle",
	error: null,
	healthIssueCount: null,
	breachResults: null,
	breachScanning: false,
	breachLastScanAt: null,
	spaceEpoch: 0,

	load: async () => {
		// 记下本次 load 归属的 epoch；若期间用户切了空间（reloadForSpace 递增
		// epoch），结果回写前会被丢弃，避免旧空间数据盖回新空间列表。
		const epoch = get().spaceEpoch;
		set({ status: "loading", error: null });
		try {
			const items = await vaultApi.listItems();
			if (get().spaceEpoch !== epoch) return; // 已切空间，丢弃过期结果
			set((state) => {
				// 选中态校验：如果之前选中的条目在新列表里已经不存在了
				// （被外部进程删了？多设备同步还没接入但留好接口），自动
				// 回退到第一条 —— 与原 mock 版本的 setItems 行为一致
				let nextSelected = state.selectedId;
				if (nextSelected && !items.some((i) => i.id === nextSelected)) {
					nextSelected = items[0]?.id ?? null;
				} else if (!nextSelected && items.length > 0) {
					// 首次加载且尚未选中：选第一条，让详情面板有内容可显示
					nextSelected = items[0].id;
				}
				// 详情缓存失效:itemDetails 是按需缓存,云/局域网同步落库后这里
				// 是唯一的失效点。缓存里已不在列表中的条目(被远端删除)直接清;
				// 列表摘要 updatedAt 比缓存新的条目随后后台重拉(原位覆盖,
				// 打开中的详情面板无闪烁地实时更新)。
				const nextDetails = { ...state.itemDetails };
				let detailsChanged = false;
				for (const id of Object.keys(nextDetails)) {
					if (!items.some((i) => i.id === id)) {
						delete nextDetails[id];
						detailsChanged = true;
					}
				}
				return {
					items,
					selectedId: nextSelected,
					status: "ready",
					error: null,
					...(detailsChanged ? { itemDetails: nextDetails } : {}),
				};
			});
			// 后台重拉过期详情(对比列表摘要与缓存 payload 的 updatedAt)。
			// fetchItem 原位覆盖缓存,正在查看该条目的组件随 store 更新即时刷新。
			const cached = get().itemDetails;
			for (const it of items) {
				const det = cached[it.id];
				if (det && it.updatedAt > (det.updatedAt ?? 0)) {
					void get().fetchItem(it.id);
				}
			}
			// 加载完成后，异步读取持久化的泄露检测快照
			// 放在单独的 void 块里，失败不影响 vault 加载结果
			void (async () => {
				try {
					const snapshot = await vaultApi.loadBreachSnapshot();
					if (snapshot && snapshot.length > 0) {
						const lastScanAt = Math.max(
							...snapshot.map((r) => r.checkedAt ?? 0),
						);
						set({ breachResults: snapshot, breachLastScanAt: lastScanAt });
						// 若缓存距今超过 6 小时，后台静默触发全量重扫
						const SIX_HOURS = 6 * 60 * 60 * 1000;
						if (Date.now() - lastScanAt > SIX_HOURS) {
							void get().runBreachScan(false);
						}
					}
				} catch {
					// 读取快照失败静默处理，不影响主流程
				}
			})();
		} catch (err) {
			if (get().spaceEpoch !== epoch) return; // 已切空间，丢弃过期错误
			const kind = vaultErrorKind(err);
			set({
				status: "error",
				error: err instanceof Error ? err.message : String(err),
				// 锁定 / 未初始化是"预期内"错误，不应该把已有 items 清掉
				// （否则解锁后短暂空列表会让 UI 闪一下）；保留旧快照
				items:
					kind === "locked" || kind === "not-initialized" ? [] : get().items,
			});
		}
	},

	reloadForSpace: async () => {
		// 清空上一个空间的内存视图，并递增 epoch 让飞行中的旧 load 失效。
		set((state) => ({
			items: [],
			itemDetails: {},
			otpSnapshots: {},
			selectedId: null,
			healthIssueCount: null,
			status: "loading",
			error: null,
			spaceEpoch: state.spaceEpoch + 1,
		}));
		await get().load();
	},

	fetchItem: async (id) => {
		try {
			const payload = await vaultApi.getItem(id);
			if (payload) {
				set((state) => ({
					itemDetails: { ...state.itemDetails, [id]: payload },
					error: null,
				}));
			} else {
				// 后端返回 null = 条目不存在；从缓存里也清一下，避免组件
				// 仍然渲染陈旧数据
				set((state) => {
					const next = { ...state.itemDetails };
					delete next[id];
					return { itemDetails: next };
				});
			}
			return payload;
		} catch (err) {
			set({
				error: err instanceof Error ? err.message : String(err),
			});
			throw err; // 详情拉取失败让调用方知道，UI 据此显示错误占位
		}
	},

	create: async (input) => {
		try {
			const summary = await vaultApi.createItem(input);
			// 重拉列表保证排序 / 时间戳与 DB 一致 —— 不在前端做乐观更新
			await get().load();
			// 自动选中新条目，让用户提交后立即看到刚创建的内容
			set({ selectedId: summary.id, error: null });
			// 若是 login 类型，异步触发单条泄露检测
			if (input.type === "login" && input.fields.password) {
				void get().checkItemBreach(summary.id);
			}
			return summary.id;
		} catch (err) {
			set({ error: err instanceof Error ? err.message : String(err) });
			throw err;
		}
	},

	importMany: async (inputs) => {
		if (inputs.length === 0) return { ok: 0, fail: 0, errors: [] };
		const errors: string[] = [];
		let ok = 0;
		let fail = 0;
		try {
			// 单次 IPC + 单事务：替代原来串行 N 次 createItem
			const summaries = await vaultApi.batchCreateItems(inputs);
			ok = summaries.length;
			fail = inputs.length - ok;
		} catch (err) {
			// 整批失败时降级为逐条重试，收集错误样本
			for (const it of inputs) {
				try {
					await vaultApi.createItem(it);
					ok += 1;
				} catch (e) {
					fail += 1;
					const msg = e instanceof Error ? e.message : String(e);
					// 只保留前 5 条错误样本，避免 error 字段无限堆积
					if (errors.length < 5) errors.push(`${it.name}: ${msg}`);
				}
			}
			if (errors.length === 0) {
				// batchCreateItems 抛错但逐条全部成功（不太可能，保守处理）
				const batchMsg = err instanceof Error ? err.message : String(err);
				errors.push(`batch: ${batchMsg}`);
			}
		}
		// 一次性 load —— 不在循环里反复重拉
		try {
			await get().load();
		} catch (err) {
			// load 失败也别让导入结果丢失，但记录到 error
			errors.push(
				`load after import: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		set({ error: errors.length > 0 ? errors.join("\n") : null });
		return { ok, fail, errors };
	},

	update: async (input) => {
		try {
			const summary = await vaultApi.updateItem(input);
			// 乐观回填详情缓存,而不是删除后等重拉:
			// 后端 UpdateItem 是"完整对象替换"语义(见 vault-api 注释),所以
			// 提交的 input.fields 就是落库后的权威内容,直接写进缓存与 getItem
			// 结果一致。若沿用旧的"先 delete 再 load",详情面板会在重拉 fields
			// 的异步窗口里短暂落到 `!detail` 分支闪出空白(尤其绑定云端时
			// vault:changed 多次触发 load,闪烁更明显)。
			set((state) => {
				const prev = state.itemDetails[input.id];
				const nextPayload: VaultItemPayload = {
					id: input.id,
					type: input.type,
					name: input.name,
					fields: { ...input.fields },
					createdAt: prev?.createdAt ?? summary.createdAt,
					updatedAt: summary.updatedAt,
				};
				return {
					itemDetails: { ...state.itemDetails, [input.id]: nextPayload },
					error: null,
				};
			});
			await get().load();
			// 若是 login 类型，异步触发单条泄露检测（密码可能已修改）
			if (input.type === "login" && input.fields.password) {
				void get().checkItemBreach(input.id);
			}
		} catch (err) {
			set({ error: err instanceof Error ? err.message : String(err) });
			throw err;
		}
	},

	remove: async (id) => {
		try {
			await vaultApi.deleteItem(id);
			set((state) => {
				const nextDetails = { ...state.itemDetails };
				delete nextDetails[id];
				// 删的是当前选中条目 → 清 selectedId，等 load 后由列表
				// 自动选第一条；否则保持原选中
				const nextSelected = state.selectedId === id ? null : state.selectedId;
				return {
					itemDetails: nextDetails,
					selectedId: nextSelected,
					error: null,
				};
			});
			await get().load();
			// 从 breachResults 里删除已删条目
			set((state) => ({
				breachResults: state.breachResults
					? state.breachResults.filter((r) => r.itemId !== id)
					: null,
			}));
		} catch (err) {
			// 删除时若后端返回 not-found，调用方通常希望视为成功
			// （目的"让条目消失"已达成）。我们仍把状态切到 ready 而非 error，
			// 但保留 error message 让 dev console 能看到。
			const kind = vaultErrorKind(err);
			if (kind === "not-found") {
				set((state) => {
					const nextDetails = { ...state.itemDetails };
					delete nextDetails[id];
					return { itemDetails: nextDetails };
				});
				await get().load();
				return;
			}
			set({ error: err instanceof Error ? err.message : String(err) });
			throw err;
		}
	},

	runBreachScan: async (force = false) => {
		if (get().breachScanning) return; // 防重入
		set({ breachScanning: true });
		try {
			if (force) await vaultApi.clearBreachCache();
			const results = await vaultApi.checkBreachedPasswords();
			set({
				breachResults: results,
				breachLastScanAt: Date.now(),
				breachScanning: false,
			});
			// healthIssueCount 由 HealthPage 的 useMemo 精确计算后再写回
			// 这里只做 breach 部分的快速估算（不含弱密码）
			// 实际精确值仍由 HealthPage 的 setHealthIssueCount 写入
		} catch {
			set({ breachScanning: false });
		}
	},

	checkItemBreach: async (itemId: string) => {
		try {
			const result = await vaultApi.checkItemBreach(itemId);
			if (!result) return; // 非 login 类型，无需更新
			set((state) => {
				const prev = state.breachResults ?? [];
				const idx = prev.findIndex((r) => r.itemId === itemId);
				const next =
					idx >= 0
						? prev.map((r, i) => (i === idx ? result : r))
						: [...prev, result];
				return { breachResults: next };
			});
		} catch {
			// 单条检测失败静默处理
		}
	},

	clear: () =>
		set({
			items: [],
			itemDetails: {},
			otpSnapshots: {},
			selectedId: null,
			filter: "all",
			query: "",
			status: "idle",
			error: null,
			healthIssueCount: null,
			breachResults: null,
			breachScanning: false,
			breachLastScanAt: null,
		}),

	setOtpSnapshots: (results) =>
		set((state) => {
			const next = { ...state.otpSnapshots };
			for (const r of results) next[r.itemId] = r;
			return { otpSnapshots: next };
		}),

	setOtpSnapshot: (result) =>
		set((state) => ({
			otpSnapshots: { ...state.otpSnapshots, [result.itemId]: result },
		})),

	selectItem: (id) => set({ selectedId: id }),
	setFilter: (filter) => set({ filter }),
	setQuery: (query) => set({ query }),
	setHealthIssueCount: (count) => set({ healthIssueCount: count }),
}));

// ---------------------------------------------------------------------------
// Selectors —— 派生状态计算函数
// ---------------------------------------------------------------------------

/**
 * 选择器：应用 filter / query 后的可见条目列表
 *
 * 对外形状仍是 VaultItemSummary[]（与原 mock 版本兼容）。过滤逻辑：
 *   1. type 过滤：filter==="all" 全部；filter==="fav" 仅 login 且 fav 真值
 *      （需要先从 itemDetails 拿到 fields；缓存未命中时跳过该条 ——
 *      这是已知"性能-准确"权衡，未来若需要稳定准确的收藏过滤，可以让
 *      backend 在 ItemSummary 里多导一个 isFav bit）
 *   2. 关键字搜索：name 永远参与；fields.username / fields.url / fields.email
 *      等可能存在的文本字段从 itemDetails 取（同样可能缓存未命中）
 *
 * 注意：itemDetails 是按需 fetchItem 拉的稀疏缓存，多数条目命中不到。
 * 这意味着收藏过滤 / 关键字搜索"对未展开过的条目不生效"。这不是 bug
 * 是当前实现上限 —— 真要全量精准搜索得在解锁时一次性拉全部 payload，
 * 设计上未来可以加 `vaultApi.listItemsFull()` 但当前阶段不做。
 */
export function selectVisibleItems(state: VaultState): VaultItemSummary[] {
	let list = state.items;

	if (state.filter !== "all") {
		if (state.filter === "fav") {
			list = list.filter((i) => {
				if (i.type !== "login") return false;
				const detail = state.itemDetails[i.id];
				if (!detail) return false;
				return Boolean(detail.fields.fav);
			});
		} else {
			list = list.filter((i) => i.type === state.filter);
		}
	}

	const q = state.query.trim().toLowerCase();
	if (q) {
		list = list.filter((i) => {
			const parts: string[] = [i.name];
			const detail = state.itemDetails[i.id];
			if (detail) {
				const f = detail.fields;
				const grab = (k: string) => {
					const v = f[k];
					if (typeof v === "string") parts.push(v);
				};
				grab("username");
				grab("url");
				grab("email");
				const tags = f.tags;
				if (Array.isArray(tags)) {
					for (const t of tags) {
						if (typeof t === "string") parts.push(t);
					}
				}
			}
			return parts.join(" ").toLowerCase().includes(q);
		});
	}

	return list;
}

/**
 * 选择器：当前选中条目摘要（不含 fields）
 *
 * 详情字段（password / totp / notes ...）通过 useVaultStore.fetchItem 拉，
 * 在 itemDetails[selectedId] 取，本 selector 只回 summary。
 */
export function selectCurrentItem(
	state: VaultState,
): VaultItemSummary | undefined {
	if (!state.selectedId) return undefined;
	return state.items.find((i) => i.id === state.selectedId);
}

/**
 * 选择器：当前选中条目的完整 payload（如已缓存）
 *
 * 未缓存时返回 undefined —— 组件应触发 fetchItem(selectedId) 拉一次。
 */
export function selectCurrentItemDetail(
	state: VaultState,
): VaultItemPayload | undefined {
	if (!state.selectedId) return undefined;
	return state.itemDetails[state.selectedId];
}

/**
 * 谓词：判断条目是否被标记为收藏
 *
 * 与原 mock 版本签名兼容（接受 summary 但只对 login 类型且缓存里有 detail
 * 的条目返回 true）。组件在 Sidebar 计数时调用。
 *
 * 由于 summary 自身不含 fav 信息，这个函数需要 itemDetails 配合；
 * 改成 `(state, id) => boolean` 更准确，但保持单参数签名能让调用方
 * 当成普通 array filter 用。返回的"已知收藏"是保守集合（缓存里有的
 * 才能判断），与 selectVisibleItems("fav") 行为一致。
 */
export function isFav(
	item: VaultItemSummary,
	itemDetails: Record<string, VaultItemPayload>,
): boolean {
	if (item.type !== "login") return false;
	const detail = itemDetails[item.id];
	if (!detail) return false;
	return Boolean(detail.fields.fav);
}
