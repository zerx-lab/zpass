// VaultService bindings — re-exports every method the ported frontend calls.
//
// We list named exports explicitly (rather than `export * from`) because the
// frontend uses `import * as VaultService` and TS's checkJS would otherwise
// not pick up the dynamic Proxy properties for autocomplete. Each export is
// a function that forwards through `Call.ByName("main.VaultService.<X>", ...)`.
//
// If the Go side gains a new method, add a one-line export here; the Proxy
// in make-service.js handles dispatch automatically.

import { makeService } from "./make-service.js";

const svc = makeService("VaultService");

// vault lifecycle
export const Status = svc.Status;
export const IsUnlocked = svc.IsUnlocked;
export const Initialize = svc.Initialize;
export const Unlock = svc.Unlock;
export const Lock = svc.Lock;
export const ChangeMasterPassword = svc.ChangeMasterPassword;
export const VerifyMasterPassword = svc.VerifyMasterPassword;

// items
export const ListItems = svc.ListItems;
export const GetItem = svc.GetItem;
export const CreateItem = svc.CreateItem;
export const UpdateItem = svc.UpdateItem;
export const DeleteItem = svc.DeleteItem;
export const BatchCreateItems = svc.BatchCreateItems;

// space isolation
export const SetActiveSpace = svc.SetActiveSpace;
export const GetActiveSpace = svc.GetActiveSpace;
export const ClaimOrphanItems = svc.ClaimOrphanItems;
export const CountItemsInSpace = svc.CountItemsInSpace;
export const ClearSpace = svc.ClearSpace;

// passkeys
export const CreatePasskey = svc.CreatePasskey;
export const ListPasskeys = svc.ListPasskeys;
export const GetPasskey = svc.GetPasskey;
export const SignPasskeyAssertion = svc.SignPasskeyAssertion;

// totp / hotp
export const GenerateTOTP = svc.GenerateTOTP;
export const BatchGenerateTOTP = svc.BatchGenerateTOTP;
export const AdvanceHOTPCounter = svc.AdvanceHOTPCounter;

// breach check
export const CheckBreachedPasswords = svc.CheckBreachedPasswords;
export const ClearBreachCache = svc.ClearBreachCache;
export const SaveBreachSnapshot = svc.SaveBreachSnapshot;
export const LoadBreachSnapshot = svc.LoadBreachSnapshot;
export const CheckItemBreach = svc.CheckItemBreach;

// trusted-device unlock
export const IsTrustedDeviceSupported = svc.IsTrustedDeviceSupported;
export const IsTrustedDeviceEnabled = svc.IsTrustedDeviceEnabled;
export const EnableTrustedDevice = svc.EnableTrustedDevice;
export const DisableTrustedDevice = svc.DisableTrustedDevice;
export const TryUnlockWithTrustedDevice = svc.TryUnlockWithTrustedDevice;

// audit (keep these reachable for future SSH-agent audit UI)
export const ListAuditEntries = svc.ListAuditEntries;
export const InsertAuditEntry = svc.InsertAuditEntry;
export const PruneAuditEntries = svc.PruneAuditEntries;
export const DeleteAllAuditEntries = svc.DeleteAllAuditEntries;
