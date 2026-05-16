import { useEffect } from "react";
import { Events } from "@wailsio/runtime";
import { useLockStore } from "@/stores/lock";
import { useUIStore } from "@/stores/ui";
import { useVaultStore, type VaultItemType } from "@/stores/vault";

interface VaultChangedPayload {
	kind?: string;
	itemId?: string;
	itemType?: VaultItemType;
	updatedAt?: number;
}

export function VaultEventSync() {
	useEffect(() => {
		let timer: number | null = null;

		const scheduleLoad = (payload: VaultChangedPayload) => {
			if (useLockStore.getState().locked) return;
			if (timer) window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				timer = null;
				void useVaultStore
					.getState()
					.load()
					.catch((err) => {
						console.error("[VaultEventSync] reload vault failed:", err);
					});
			}, 120);

			if (payload.kind === "create" && payload.itemType === "passkey") {
				useUIStore.getState().pushToast({
					text: "Passkey 已保存到 ZPass",
					icon: "key",
					duration: 2600,
				});
			}
		};

		const off = Events.On("vault:changed", (event: { data?: VaultChangedPayload } | VaultChangedPayload) => {
			const payload = ("data" in event && event.data ? event.data : event) as VaultChangedPayload;
			scheduleLoad(payload);
		});

		return () => {
			if (timer) window.clearTimeout(timer);
			if (typeof off === "function") off();
		};
	}, []);

	return null;
}

export default VaultEventSync;
