// 空间自动镜像 —— 1Password 模型:登录后云端 vault ↔ 本地空间保持一致
//
// 用户不再需要理解"绑定"概念。规则:
//   1. 云端有、本地无       → 自动创建同名本地空间并绑定(名称来自加密 meta)
//   2. 本地有、云端无       → 自动上传为新云端 vault(套餐限额挡住则标记并停止)
//   3. 同名唯一匹配         → 直接绑定(同账户多设备同名空间不重复创建)
//   4. 登录状态下新建空间   → 自动建云 vault;重命名 → 自动同步 meta;
//      删除空间(owner)     → 同步删除云端 vault
//   5. 云端 vault 被其他设备删除 → 本地空间与数据保留,标记 detached;
//      重新上云必须用户显式操作(防止删除在设备间来回复活)
//   6. 无名旧 vault(meta 未回填)→ 跳过自动镜像,设置页保留手动绑定兜底;
//      已绑定的旧 vault 由本设备自动回填 meta
//
// 触发点:
//   - cloud.ts refresh() 检测到登录态从无到有(启动恢复会话 / 登录)
//   - CloudSyncSection 挂载时(进设置页顺手对账)
//   - initCloudMirror() 订阅 spaces store,处理新建/重命名/删除
//
// 边界:
//   - 套餐限额(403 plan_limit_exceeded):mirror.limitBlocked 置位,UI 提示,
//     不重试热循环;下次 reconcile 再尝试
//   - 同名歧义(>1 个未绑定同名本地空间):跳过,留手动兜底
//   - 删除云端 vault 失败(非 owner / 服务端拒删最后一个):vaultId 进
//     ignoredVaultIds,reconcile 不再把它镜像回本地

import {
	bindCloudVault,
	createCloudVault,
	deleteRemoteVault,
	getCloudEntitlements,
	isPlanLimitError,
	type LinkedSpace,
	listDeletedVaults,
	listLinkedSpaces,
	listRemoteVaults,
	setVaultMeta,
	syncNow,
	unlinkSpace,
} from "@/lib/cloud-api";
import { purgeSpace } from "@/lib/vault-api";
import { useCloudStore } from "@/stores/cloud";
import { type Space, useSpacesStore } from "@/stores/spaces";

function messageOf(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e ?? "unknown error");
}

/**
 * 压制深度:>0 时 initCloudMirror 的订阅忽略"新空间 → 建云 vault"联动。
 * zustand 的 subscribe 在 set() 内同步触发,所以必须在 createSpace 调用
 * 之前置位 —— 用包装函数保证时序,而不是事后按 id 标记。
 */
let suppressDepth = 0;

/**
 * 创建本地空间但不触发"自动建云 vault"联动。
 * 供 reconcile(空间来自云端镜像)与无名旧 vault 手动绑定兜底使用 ——
 * 两种场景里新空间都会立刻绑到一个已存在的 vault,不能再 mint 新的。
 */
export function createSpaceWithoutAutoLink(patch: {
	name: string;
	glyph?: string;
	tag?: string;
}): string {
	suppressDepth++;
	try {
		return useSpacesStore.getState().createSpace(patch);
	} finally {
		suppressDepth--;
	}
}

let inflight: Promise<void> | null = null;

/**
 * 对账一次:云端 vault 与本地空间互相镜像。任何单项失败不中断整体
 * (套餐限额除外 —— 后续上传必然同样失败,直接停)。
 *
 * 并发调用共享同一个 in-flight promise —— 首启登录页要 await "空间已镜像
 * 完成"再导航,而 cloud store 的登录态跃迁也会触发一次;合并成一次执行,
 * 两边 await 到的都是真实完成时刻。
 */
export function reconcileCloudSpaces(): Promise<void> {
	if (inflight) return inflight;
	inflight = doReconcile().finally(() => {
		inflight = null;
	});
	return inflight;
}

/**
 * 删除墓碑传播(增量): 拉取本账户 seq>游标 的 vault 删除墓碑,命中本地绑定者
 * 物理删本地空间(purgeSpace 删条目+解绑) + 从 store 移除。把"主动删除"与
 * "失去访问"区分开 —— 只有进了墓碑的才自动删;仅"失踪但无墓碑"的留给 doReconcile
 * 的 step1 走 detached 保留。游标按 accountId 持久化推进(只增)。
 *
 * 任何单步失败都不抛出:拉取失败本轮跳过下轮再试;单个 purge 失败的空间因其
 * vault 已删,会在后续 reconcile 落入 detached 兜底(数据保留)。返回是否有改动。
 */
async function processDeletionTombstones(accountId: string): Promise<boolean> {
	if (!accountId) return false;
	let changed = false;
	// 多页时一次抽干(删除少见,通常 0~1 页);guard 防御异常死循环。
	for (let guard = 0; guard < 100; guard++) {
		const cursor = useCloudStore.getState().tombstoneCursors[accountId] ?? 0;
		let page: Awaited<ReturnType<typeof listDeletedVaults>>;
		try {
			page = await listDeletedVaults(cursor);
		} catch {
			return changed; // 拉墓碑失败:本轮跳过,不影响其余对账
		}
		if (page.deleted.length === 0) break;

		const linked: LinkedSpace[] = await listLinkedSpaces().catch(() => []);
		const spaceByVault = new Map<string, string>(linked.map((l) => [l.vaultId, l.spaceId]));

		for (const d of page.deleted) {
			const spaceId = spaceByVault.get(d.vaultId);
			if (!spaceId) continue; // 本地无此 vault 绑定:忽略(从未同步过)
			try {
				// 物理删本地条目 + 解绑。解绑后下面 removeSpace 触发的 onSpaceRemoved
				// 因找不到 binding 而空跑,不会再对已删 vault 重复发删除。
				await purgeSpace(spaceId);
				useCloudStore.getState().setSpaceDetached(spaceId, false);
				useSpacesStore.getState().removeSpace(spaceId);
				changed = true;
			} catch {
				// 单个失败留给 detached 兜底(vault 已删,数据保留),不卡住游标。
			}
		}
		// 推进游标到本页末尾(失败项也推进:已读到,靠 detached 兜底,避免反复重拉)。
		useCloudStore.getState().setTombstoneCursor(accountId, page.nextCursor);
		if (!page.hasMore) break;
	}
	return changed;
}

async function doReconcile(): Promise<void> {
	const cloud = useCloudStore.getState();
	if (!cloud.status?.signedIn) return;
	cloud.setMirror({ running: true, error: undefined });
	let limitBlocked = false;
	let changed = false;

	try {
		// ── 0. 删除墓碑传播(先于其余对账): 命中本地绑定的"主动删除"墓碑 → 物理删
		//    本地空间。放最前,使下面 listLinkedSpaces 拿到的是已清理过的绑定,
		//    被自动删的空间不会再落入 step1 的 detached 分支。
		const accountId = useCloudStore.getState().status?.accountId ?? "";
		// 账户守卫:整轮 reconcile 含多次 await,期间用户可能登出/切账户。
		// 任一关键写入(解绑/绑定/建空间/删云端/还原焦点)前确认仍是同一在线账户,
		// 否则中止本轮 —— 切换后的新账户会以自己的 accountId 重新对账,避免把
		// 旧账户的对账结果(空间增删、焦点还原)误施加到新账户的空间集上。
		const sameAccount = (): boolean => {
			const st = useCloudStore.getState().status;
			return !!st?.signedIn && (st.accountId ?? "") === accountId;
		};
		if (await processDeletionTombstones(accountId)) changed = true;
		if (!sameAccount()) return;

		// ── 重试待删的云端 vault(此前删除失败的;幂等)。删除必达的兜底:确保删除
		//    最终到达服务端、写出墓碑、传到其他设备。
		for (const vid of [...useCloudStore.getState().pendingRemoteDeletes]) {
			try {
				await deleteRemoteVault(vid);
				useCloudStore.getState().clearPendingRemoteDelete(vid);
				changed = true;
			} catch (e) {
				// 404=已不存在(视作成功清理);403=非本人 owner(重试无意义,清理)。
				// 其余(网络等)保留,下轮再试。
				const msg = e instanceof Error ? e.message : String(e);
				if (msg.includes("http 404") || msg.includes("http 403")) {
					useCloudStore.getState().clearPendingRemoteDelete(vid);
				}
			}
		}

		const [linked, remote] = await Promise.all([listLinkedSpaces(), listRemoteVaults()]);
		const linkedBySpace = new Map(linked.map((l) => [l.spaceId, l.vaultId]));
		const remoteIds = new Set(remote.map((v) => v.vaultId));
		const ignored = new Set(useCloudStore.getState().ignoredVaultIds);
		// 待删的 vault 不可在 step2 被重新镜像回本地(否则刚删的空间复活)。
		const pending = new Set(useCloudStore.getState().pendingRemoteDeletes);

		// reconcile 中途 createSpace 会自动切换激活空间;结束后还原,
		// 避免后台对账偷走用户当前的空间焦点。
		const prevActive = useSpacesStore.getState().activeSpaceId;
		// listLinkedSpaces/listRemoteVaults 的 await 期间可能切了账户:此后所有
		// 解绑/绑定/建空间都基于上面拉取的旧账户视图,中止以免污染新账户空间集。
		if (!sameAccount()) return;

		// ── 1. 绑定指向的云端 vault 已不存在(其他设备删除)→ 解绑 + 标记 detached
		for (const l of linked) {
			if (remoteIds.has(l.vaultId)) continue;
			try {
				await unlinkSpace(l.spaceId);
				linkedBySpace.delete(l.spaceId);
				useCloudStore.getState().setSpaceDetached(l.spaceId, true);
				changed = true;
			} catch {
				// 解绑失败留待下次
			}
		}

		// ── 2. 云端 vault → 本地镜像
		for (const v of remote) {
			if (v.boundSpaceId) {
				// 已绑定:旧 vault 缺 meta 时回填,让其他设备也能自动镜像
				if (!v.name) {
					const sp = useSpacesStore.getState().spaces.find((s) => s.id === v.boundSpaceId);
					if (sp) await setVaultMeta(v.vaultId, sp.name, sp.glyph, sp.tag ?? "").catch(() => {});
				}
				continue;
			}
			if (ignored.has(v.vaultId) || pending.has(v.vaultId)) continue;
			if (!v.name) continue; // 无名旧 vault → 留给设置页手动绑定兜底

			const candidates = useSpacesStore
				.getState()
				.spaces.filter((s) => s.name === v.name && !linkedBySpace.has(s.id));
			try {
				if (candidates.length === 1) {
					await bindCloudVault(candidates[0].id, v.vaultId);
					linkedBySpace.set(candidates[0].id, v.vaultId);
					useCloudStore.getState().setSpaceDetached(candidates[0].id, false);
					changed = true;
				} else if (candidates.length === 0) {
					const id = createSpaceWithoutAutoLink({
						name: v.name,
						glyph: v.glyph || undefined,
						tag: v.tag || undefined,
					});
					await bindCloudVault(id, v.vaultId);
					linkedBySpace.set(id, v.vaultId);
					changed = true;
				}
				// >1 同名候选:歧义,跳过(手动兜底)
			} catch {
				// 单个 vault 镜像失败不影响其余
			}
		}

		// ── 3. 本地空间云端没有 → 自动上传(detached 的除外:需用户显式重新上云)
		const detached = new Set(useCloudStore.getState().detachedSpaceIds);
		for (const s of useSpacesStore.getState().spaces) {
			if (linkedBySpace.has(s.id) || detached.has(s.id)) continue;
			try {
				const vid = await createCloudVault(s.id, s.name, s.glyph, s.tag ?? "");
				linkedBySpace.set(s.id, vid);
				changed = true;
			} catch (e) {
				if (isPlanLimitError(e)) {
					limitBlocked = true;
					break; // 后续上传必然同样超限
				}
				// 其他错误:跳过该空间,下次 reconcile 再试
			}
		}

		// 还原对账前的激活空间(仅当仍是同账户且它仍存在;首次登录本地无空间时保持
		// 新激活)。切了账户则不还原:prevActive 属于旧账户,不能抢新账户的焦点。
		if (sameAccount() && prevActive && useSpacesStore.getState().spaces.some((s) => s.id === prevActive)) {
			useSpacesStore.getState().switchSpace(prevActive);
		}

		// ── 4. 降级冻结的已绑定空间(服务端 frozen 标记 → 本地空间 id)
		const frozenSpaceIds = remote
			.filter((v) => v.frozen && v.boundSpaceId)
			.map((v) => v.boundSpaceId);

		// 套餐配额(事前提示用)。旧服务端没有该端点时静默跳过。
		let spaceLimit: number | null | undefined;
		let spaceUsed: number | undefined;
		try {
			const ent = await getCloudEntitlements();
			const dim = ent.dimensions.find((d) => d.dimension === "max_vaults");
			spaceLimit = dim?.limit ?? null;
			spaceUsed = dim?.current;
		} catch {
			// 不可用就维持"撞 403 才知道"的旧行为
		}

		useCloudStore
			.getState()
			.setMirror({ running: false, limitBlocked, frozenSpaceIds, spaceLimit, spaceUsed });
		if (changed) void syncNow().catch(() => {});
	} catch (e) {
		useCloudStore.getState().setMirror({ running: false, limitBlocked, error: messageOf(e) });
	}
}

/* ----------------------------------------------------------------------------
 * spaces store 联动 —— 新建 / 重命名 / 删除空间时同步云端
 * -------------------------------------------------------------------------- */

async function onSpaceCreated(s: Space): Promise<void> {
	try {
		await createCloudVault(s.id, s.name, s.glyph, s.tag ?? "");
		useCloudStore.getState().setMirror({ limitBlocked: false });
		void syncNow().catch(() => {});
	} catch (e) {
		if (isPlanLimitError(e)) useCloudStore.getState().setMirror({ limitBlocked: true });
		// 失败的空间保持本地;下次 reconcile 再试
	}
}

async function onSpaceRenamed(s: Space): Promise<void> {
	const linked = await listLinkedSpaces().catch(() => []);
	const l = linked.find((x) => x.spaceId === s.id);
	if (!l) return;
	await setVaultMeta(l.vaultId, s.name, s.glyph, s.tag ?? "").catch(() => {});
}

async function onSpaceRemoved(spaceId: string): Promise<void> {
	const linked = await listLinkedSpaces().catch(() => []);
	const l = linked.find((x) => x.spaceId === spaceId);
	useCloudStore.getState().setSpaceDetached(spaceId, false); // 清理残留标记
	if (!l) return;
	await unlinkSpace(spaceId).catch(() => {});
	try {
		await deleteRemoteVault(l.vaultId);
		// 删除成功:服务端已写墓碑(其他设备据此自动删本地同名空间)。立即再对账
		// 一次,让被套餐配额挡住的本地空间马上重试上云 —— free 套餐"删旧腾配额给
		// 新空间"的换槽由此闭环,不必等下个同步周期。
		void reconcileCloudSpaces().catch(() => {});
	} catch {
		// 删不掉(离线 / 瞬时错误)→ 记入待删队列,reconcile 持续幂等重试直至成功。
		// 不再用 ignoredVaultIds 永久焊死,避免删除到不了服务端、传不到其他设备。
		useCloudStore.getState().addPendingRemoteDelete(l.vaultId);
	}
}

let mirrorInitialized = false;

/** 挂一次 spaces store 订阅(App 启动时由 CloudEventSync 调用)。 */
export function initCloudMirror(): void {
	if (mirrorInitialized) return;
	mirrorInitialized = true;

	useSpacesStore.subscribe((state, prev) => {
		if (state.spaces === prev.spaces) return;
		if (!useCloudStore.getState().status?.signedIn) return;

		const prevById = new Map(prev.spaces.map((s) => [s.id, s]));
		const nextIds = new Set(state.spaces.map((s) => s.id));

		for (const s of state.spaces) {
			const before = prevById.get(s.id);
			if (!before) {
				if (suppressDepth > 0) continue;
				void onSpaceCreated(s);
			} else if (before.name !== s.name || before.glyph !== s.glyph || before.tag !== s.tag) {
				void onSpaceRenamed(s);
			}
		}
		for (const s of prev.spaces) {
			if (!nextIds.has(s.id)) void onSpaceRemoved(s.id);
		}
	});
}
