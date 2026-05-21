// Ambient declarations for the wails3-style binding stubs.
//
// The actual .js files in this directory are tiny — each property forwards
// to `Call.ByName` via a Proxy — so TS cannot infer return types from them.
// We declare loose function signatures here; callers in `lib/vault-api.ts`
// and `lib/config-storage.ts` wrap every result in a typed adaptor anyway,
// so giving up the inner type fidelity costs nothing in practice.
//
// `(...args: any[]) => Promise<any>` is intentional: the dispatcher accepts
// any JSON-able args, the wrapper in vault-api re-validates the shape, and
// using `unknown` here would force a cast at every call site without adding
// any safety we don't already get from the wrapper.

declare module "@/../bindings/github.com/zerx-lab/zpass/zpass-desktop/configservice.js" {
	export const Dir: (...args: any[]) => Promise<string>;
	export const Read: (namespace: string) => Promise<string>;
	export const Write: (namespace: string, value: string) => Promise<void>;
	export const Remove: (namespace: string) => Promise<void>;
}

declare module "@/../bindings/github.com/zerx-lab/zpass/zpass-desktop/vaultservice.js" {
	export const Status: (...args: any[]) => Promise<any>;
	export const IsUnlocked: (...args: any[]) => Promise<boolean>;
	export const Initialize: (...args: any[]) => Promise<any>;
	export const Unlock: (...args: any[]) => Promise<any>;
	export const Lock: (...args: any[]) => Promise<any>;
	export const ChangeMasterPassword: (...args: any[]) => Promise<any>;
	export const VerifyMasterPassword: (...args: any[]) => Promise<any>;

	export const ListItems: (...args: any[]) => Promise<any>;
	export const GetItem: (...args: any[]) => Promise<any>;
	export const CreateItem: (...args: any[]) => Promise<any>;
	export const UpdateItem: (...args: any[]) => Promise<any>;
	export const DeleteItem: (...args: any[]) => Promise<any>;
	export const BatchCreateItems: (...args: any[]) => Promise<any>;

	export const CreatePasskey: (...args: any[]) => Promise<any>;
	export const ListPasskeys: (...args: any[]) => Promise<any>;
	export const GetPasskey: (...args: any[]) => Promise<any>;
	export const SignPasskeyAssertion: (...args: any[]) => Promise<any>;

	export const GenerateTOTP: (...args: any[]) => Promise<any>;
	export const BatchGenerateTOTP: (...args: any[]) => Promise<any>;
	export const AdvanceHOTPCounter: (...args: any[]) => Promise<any>;

	export const CheckBreachedPasswords: (...args: any[]) => Promise<any>;
	export const ClearBreachCache: (...args: any[]) => Promise<any>;
	export const SaveBreachSnapshot: (...args: any[]) => Promise<any>;
	export const LoadBreachSnapshot: (...args: any[]) => Promise<any>;
	export const CheckItemBreach: (...args: any[]) => Promise<any>;

	export const IsTrustedDeviceSupported: (...args: any[]) => Promise<boolean>;
	export const IsTrustedDeviceEnabled: (...args: any[]) => Promise<boolean>;
	export const EnableTrustedDevice: (...args: any[]) => Promise<any>;
	export const DisableTrustedDevice: (...args: any[]) => Promise<any>;
	export const TryUnlockWithTrustedDevice: (...args: any[]) => Promise<any>;

	export const ListAuditEntries: (...args: any[]) => Promise<any>;
	export const InsertAuditEntry: (...args: any[]) => Promise<any>;
	export const PruneAuditEntries: (...args: any[]) => Promise<any>;
	export const DeleteAllAuditEntries: (...args: any[]) => Promise<any>;
}
