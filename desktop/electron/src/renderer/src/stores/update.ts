// 自动更新状态 store —— 会话内瞬时态,不持久化。
//
// 唯一写入方是 app/UpdateEventSync.tsx(订阅主进程 zpass:update:event 后 apply）;
// 读取方是 features/settings/sections/AboutSection.tsx(行内状态展示）。
// 实际的 check / install / openDownloadPage 调用直接走 window.desktop.update.*,
// 不经此 store —— store 只保存"当前更新状态"供 UI 反映。

import { create } from "zustand";
import type { UpdateEvent } from "@/compat/window-globals";

type Status =
	| "idle"
	| "checking"
	| "available"
	| "downloading"
	| "downloaded"
	| "none"
	| "error";

interface UpdateState {
	status: Status;
	/** 新版本号(available / downloaded 时有值)。 */
	version: string | null;
	/** 下载进度 0–100(downloading 时有值)。 */
	percent: number;
	/** macOS/Linux available 时的 Release 页地址。 */
	downloadUrl: string | null;
	/** available 的来源:auto = Windows 自动下载;manual-open = 仅提示跳转。 */
	mode: "auto" | "manual-open" | null;
	/** 根据主进程事件推进状态。 */
	apply: (ev: UpdateEvent) => void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
	status: "idle",
	version: null,
	percent: 0,
	downloadUrl: null,
	mode: null,
	apply: (ev) => {
		switch (ev.kind) {
			case "checking":
				set({ status: "checking" });
				break;
			case "available":
				set({
					status: "available",
					version: ev.version,
					mode: ev.mode,
					downloadUrl: ev.downloadUrl ?? null,
				});
				break;
			case "progress":
				set({ status: "downloading", percent: ev.percent });
				break;
			case "downloaded":
				set({ status: "downloaded", version: ev.version });
				break;
			case "none":
				set({ status: "none" });
				break;
			case "error":
				set({ status: "error" });
				break;
		}
	},
}));
