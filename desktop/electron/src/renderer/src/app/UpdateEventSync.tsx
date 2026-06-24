// 自动更新事件桥 —— 订阅主进程 zpass:update:event,驱动 useUpdateStore,
// 并对两类「app 级可操作」事件弹全局 toast。
//
// 与 CloudEventSync / VaultEventSync 平级挂在 App 顶层(App.tsx),mount-once、
// 无 DOM 输出。AboutSection 读 useUpdateStore 做行内状态展示;此处只负责把
// 「下载就绪(Windows)」「发现新版(macOS/Linux)」这两个用户无论在哪个页面都
// 应感知的时刻,以带操作按钮的 toast 呈现。其余状态(checking/progress/none/
// error)不弹全局 toast,交由 About 页行内反映。

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "@/stores/ui";
import { useUpdateStore } from "@/stores/update";

export function UpdateEventSync() {
	const { t } = useTranslation();

	useEffect(() => {
		const apply = useUpdateStore.getState().apply;
		const pushToast = useUIStore.getState().pushToast;

		const off = window.desktop.update.onEvent((ev) => {
			apply(ev);

			if (ev.kind === "downloaded") {
				// Windows:更新已后台下载完毕,提示重启安装(点完自动 dismiss)。
				pushToast({
					text: t("update_ready_toast", { version: ev.version }),
					duration: 8000,
					action: {
						label: t("update_restart"),
						onClick: () => {
							void window.desktop.update.install();
						},
					},
				});
			} else if (ev.kind === "available" && ev.mode === "manual-open") {
				// macOS/Linux:发现新版,引导前往 GitHub 下载页。
				const url = ev.downloadUrl;
				pushToast({
					text: t("update_available_toast", { version: ev.version }),
					duration: 8000,
					action: {
						label: t("update_open_page"),
						onClick: () => {
							if (url) void window.desktop.update.openDownloadPage(url);
						},
					},
				});
			}
		});

		return off;
	}, [t]);

	return null;
}

export default UpdateEventSync;
