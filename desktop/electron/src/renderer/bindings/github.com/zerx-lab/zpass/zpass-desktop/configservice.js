// ConfigService bindings — Dir / Read / Write / Remove.
//
// All four methods are routed to `Call.ByName("main.ConfigService.<X>", ...)`
// by the Proxy returned from make-service.js. See README.md for the why.

import { makeService } from "./make-service.js";

const svc = makeService("ConfigService");
export const Dir = svc.Dir;
export const Read = svc.Read;
export const Write = svc.Write;
export const Remove = svc.Remove;
