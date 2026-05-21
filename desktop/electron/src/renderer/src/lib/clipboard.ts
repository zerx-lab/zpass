// 剪贴板工具 —— 写入 + 自动清空
// ---------------------------------------------------------------------------
// 提供两个能力：
//
//   1. writeClipboard(text)
//        包装 navigator.clipboard.writeText，做错误归一化（部分浏览器在
//        无焦点时 reject，桌面 WebView 焦点状态由窗口决定，几乎不会触发；
//        但保留兜底以免静默失败让上层困惑）
//
//   2. writeClipboardEphemeral(text, ttlMs)
//        密码管理器的核心安全功能：把字符串写入剪贴板，N 秒后自动清空。
//        对标 1Password / Bitwarden 的"剪贴板自动清空"行为：
//          - 用户复制密码 → 立刻可粘到目标输入框
//          - 30 秒后自动清空 → 防止剪贴板长期驻留敏感数据被其它应用读取
//        清空策略：
//          a. 先比对当前剪贴板内容是否仍是我们写入的字符串 —— 用户在 30s
//             内主动复制了别的东西，就不要去覆盖（避免破坏其它工作流）
//          b. 比对失败（读取被拒 / 不再是原值）则跳过清空
//          c. 比对成功才用空串覆盖
//        这是"礼貌的清空"，不是"霸道的清空"。
//
// ---------------------------------------------------------------------------
// 安全模型
//
// 浏览器剪贴板 API 设计上对"读"很谨慎：navigator.clipboard.readText 在
// 多数环境下需要文档处于聚焦态，且 Chromium 系会发权限弹窗。Wails WebView
// 使用 EdgeWebView2（Windows）/ WKWebView（mac）/ WebKitGTK（Linux），
// 默认对自家应用授予 clipboard-read 权限，所以 readText 一般可用。
//
// 但即便 readText 失败，我们也宁可"少清空"而不是"误清空"——因此 catch
// 后直接 return，不抛错给上层。失败的情况下，剪贴板里的密码确实会驻留
// 更久，但这是一个"防御纵深"功能，不是认证屏障，可以容忍偶发失效。
//
// ---------------------------------------------------------------------------
// 取消语义
//
// 同一会话内连续复制多个密码时，前一次的清空定时器应该被取消 —— 否则
// 用户复制条目 A 的密码、5s 后复制条目 B 的密码，两个定时器各自跑到
// 30s 后都触发清空，第一次会清掉 B（B 才驻留 25s 还在使用）。
//
// 解法：模块内维护一个全局 timer handle，每次新写入先 clearTimeout 旧的，
// 再设置新的。简单，且无需调用方传 controller。

// ---------------------------------------------------------------------------
// 内部状态
// ---------------------------------------------------------------------------

/**
 * 当前活跃的清空定时器 handle
 *
 * 用 number 而非 NodeJS.Timeout —— 浏览器 setTimeout 返回 number，
 * 在 Wails WebView / vite 环境下都是浏览器语义。
 *
 * 不导出 —— 调用方不需要直接访问，自动清空逻辑完全封装。
 */
let pendingClearTimer: number | null = null;

/**
 * 上一次写入剪贴板的内容副本
 *
 * 用于"礼貌清空"的对比 —— 只有当当前剪贴板内容仍然是我们写入的
 * 字符串时，才执行清空。如果用户在 TTL 期间复制了别的内容，对比
 * 失败，跳过清空。
 *
 * 注意：这是字符串明文驻留在 JS 内存里的密码副本。生命周期严格
 * 受限于 TTL —— 定时器触发或被取消时立刻清空 lastWritten。短暂
 * 驻留是不可避免的（要做对比就必须存原值），但不会跨过 TTL 边界。
 */
let lastWritten: string | null = null;

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 取消任何 pending 的剪贴板清空定时器
 *
 * 调用场景：
 *   - 切换账户 / 锁定 vault 时，提前把 lastWritten 抹掉（不再持有
 *     密码副本），并取消定时器（不再尝试读剪贴板）
 *   - 测试用例 cleanup
 */
export function cancelClipboardClear(): void {
	if (pendingClearTimer != null) {
		window.clearTimeout(pendingClearTimer);
		pendingClearTimer = null;
	}
	lastWritten = null;
}

/**
 * 把字符串写入剪贴板，不做自动清空
 *
 * 适用场景：复制非敏感数据（用户名 / URL / 备注）。返回 Promise<boolean>
 * 表示写入是否成功，调用方据此决定要不要给用户成功反馈。
 *
 * 失败原因可能是：
 *   - 浏览器无焦点（罕见，桌面 WebView 几乎不触发）
 *   - 用户拒绝 clipboard 权限（Wails 内默认放行，几乎不触发）
 *   - 浏览器太老不支持 navigator.clipboard（Wails 用 Chromium，不可能）
 *
 * 任何失败都不抛错，统一返回 false —— 让调用方走"复制失败"分支即可，
 * 不需要 try/catch 包一圈。
 */
export async function writeClipboard(text: string): Promise<boolean> {
	if (!navigator.clipboard?.writeText) return false;
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * 写入剪贴板并在 ttlMs 毫秒后自动清空（礼貌策略）
 *
 * 推荐用于：复制密码 / TOTP / API 密钥 / 信用卡 CVV 等敏感数据。
 *
 * 行为：
 *   1. 取消任何已存在的清空定时器（替换语义，详见模块顶部注释）
 *   2. 写入新内容到剪贴板
 *   3. 记录 lastWritten = text，用于到期时的"对比清空"
 *   4. 设置 setTimeout(ttlMs)：
 *        a. 尝试 readText 当前剪贴板内容
 *        b. 若与 lastWritten 一致 → writeText("") 清空
 *        c. 若不一致（用户已复制别的内容）→ 跳过，避免破坏用户工作流
 *        d. 若 read 失败 → 跳过（保守不清空）
 *        e. 无论 a-d 哪个分支，最后清空 lastWritten 与 timer handle
 *
 * 返回 Promise<boolean>：仅反映"写入是否成功"。清空是异步副作用，
 * 不在返回值里报告（成功率 ~99%，失败也不影响安全性 —— 用户可手动
 * 复制空串覆盖）。
 *
 * @param text  要写入的字符串
 * @param ttlMs 清空延迟，默认 30_000（30 秒）。0 表示不清空（等价 writeClipboard）
 */
export async function writeClipboardEphemeral(
	text: string,
	ttlMs: number = 30_000,
): Promise<boolean> {
	// 取消上一次的清空（可能还在排队）
	cancelClipboardClear();

	const ok = await writeClipboard(text);
	if (!ok) return false;

	// ttlMs <= 0 表示不清空（让调用方可以显式选择"长期复制"语义）
	if (ttlMs <= 0) return true;

	lastWritten = text;
	pendingClearTimer = window.setTimeout(() => {
		void clearIfStillOurs();
	}, ttlMs);

	return true;
}

/**
 * 内部：到期时的"礼貌清空"逻辑
 *
 * 所有 fail-safe 分支统一在 finally 里复位状态 —— 即便读/写失败，
 * lastWritten 与 timer handle 也必须被清空，否则下一次复制会被
 * 上一轮残留的状态误导。
 */
async function clearIfStillOurs(): Promise<void> {
	const expected = lastWritten;
	try {
		// readText 在 Wails 内通常可用；浏览器无焦点 / 权限被拒时会 reject
		if (!navigator.clipboard?.readText) return;
		const current = await navigator.clipboard.readText();
		if (current === expected) {
			// 仍是我们写入的内容 → 用空串覆盖
			// 写空串不一定真把 OS 剪贴板"清空"（部分系统会保留 type 但 value 为空，
			// 部分系统会从历史中弹掉一项），但目标"让 paste 拿不到密码"达成即可
			await navigator.clipboard.writeText("");
		}
		// current !== expected：用户复制了别的东西，不动
	} catch {
		// readText / writeText 失败：保守不清空，让用户感知不到异常
		// 这不会导致安全问题 —— 密码本来就是用户自己刚复制的
	} finally {
		// 无论成功失败，状态必须复位
		lastWritten = null;
		pendingClearTimer = null;
	}
}
