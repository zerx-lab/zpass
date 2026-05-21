// Factory that returns a binding-shaped module for a Go service.
//
// Wails 3's bindings module exposed every Go method as a top-level named
// export. We achieve the same surface via a Proxy that forwards any
// property access through the wailscompat shim:
//
//   import * as VaultService from ".../vaultservice.js";
//   VaultService.Status();           // -> Call.ByName("main.VaultService.Status")
//   VaultService.Unlock("pw");       // -> Call.ByName("main.VaultService.Unlock", "pw")
//
// The Proxy reports `typeof === "function"` only for property access; static
// inspection (e.g. `Object.keys`) returns nothing because we don't want the
// caller to think a specific surface is enumerable — we have no static list.
//
// Defined as a plain .js file (not .ts) to match what the old wails-generated
// modules looked like, so existing `import * as Foo from "....js"` calls
// resolve naturally under bundler moduleResolution.

import { Call } from "@wailsio/runtime";

/**
 * @param {string} service Bare service name as registered with the Go
 *   wailscompat.Registry (no `main.` prefix; we add it here so the wire
 *   format stays uniform).
 */
export function makeService(service) {
	return new Proxy(Object.create(null), {
		get(_target, prop) {
			if (typeof prop !== "string") return undefined;
			// React DevTools / inspector probes; return undefined so they
			// stop, rather than handing back a function that does nothing.
			if (prop === "then" || prop === "Symbol(Symbol.toPrimitive)") {
				return undefined;
			}
			return (...args) => Call.ByName(`main.${service}.${prop}`, ...args);
		},
	});
}
