---
name: add-ws-frames
description: Add or modify a WebSocket frame type when WS is genuinely required (bidirectional, binary, or true full-duplex). This is the ONLY place where hand-written TS types are allowed in this project. Keeps the Go struct and TS interface in lock-step so the wire format never drifts.
---

## First, reconsider

OpenAPI 3.x has no concept of WS frames. The whole codegen chain (`Go struct → openapi.yaml → schema.ts`) does not apply, which is why this is an exception and not the rule.

Before writing WS code, ask:
- Can this be one or many SSE streams? If yes, use `add-sse-endpoint` instead.
- Is the client-to-server direction just a control command? Then a regular POST + SSE for responses is simpler.

Use WS only when you need either bidirectional streaming with low latency, binary frames, or session state that genuinely belongs on a long-lived socket.

## Where things live

- **Go side**: WS handler under `internal/api/` (or a sub-package). Register it on the mux. Note that bare `mux.HandleFunc` paths are not in OpenAPI — that's expected here.
- **TS side**: frame interfaces under `electron/src/api/ws/`. This directory is the documented escape hatch from the "never hand-write TS types" rule.

## Workflow

### 1. Define frame types in Go

Use a single Go file per logical channel, with one struct per frame variant and a wrapper for the discriminated union. The discriminator field convention is `type`.

```go
// internal/api/ws/<channel>.go
package ws

// IMPORTANT: any change here must be mirrored in
// electron/src/api/ws/<channel>.ts (same file basename).
type ClientFrame struct {
    Type string          `json:"type"` // "subscribe" | "unsubscribe" | "ping"
    Body json.RawMessage `json:"body,omitempty"`
}

type SubscribeBody struct {
    Topic string `json:"topic"`
}

type ServerFrame struct {
    Type string          `json:"type"` // "event" | "pong" | "error"
    Body json.RawMessage `json:"body,omitempty"`
}

type EventBody struct {
    Topic   string          `json:"topic"`
    Payload json.RawMessage `json:"payload"`
}
```

Serialize/deserialize with the standard library's `encoding/json`. Do not introduce a custom framing format — JSON over WS text frames is the contract.

### 2. Mirror in TypeScript

Create `electron/src/api/ws/<channel>.ts` with hand-written interfaces that match the Go file 1:1. Add a header comment referencing the Go file path so future edits can find both sides.

```ts
// electron/src/api/ws/<channel>.ts
//
// MIRROR OF internal/api/ws/<channel>.go
// Any change here must be mirrored on the Go side in the same commit.

export type ClientFrame =
  | { type: "subscribe"; body: { topic: string } }
  | { type: "unsubscribe"; body: { topic: string } }
  | { type: "ping" };

export type ServerFrame =
  | { type: "event"; body: { topic: string; payload: unknown } }
  | { type: "pong" }
  | { type: "error"; body: { message: string } };
```

Prefer discriminated unions over `interface` + optional fields — they narrow correctly on `switch (frame.type)`.

### 3. Cross-link comments

Both files **must** carry a comment pointing at the other. Reviewers and future agents need to know they form a pair. The AGENTS.md rule is explicit: "提交时一并改两侧" — both sides change in the same commit.

### 4. Auth and origin

The Electron renderer must send the `X-Relay-Token` value during the WS handshake (e.g. as a `Sec-WebSocket-Protocol` subprotocol or via a query parameter the server validates). Reuse the token surfaced by `window.relay.handshake()`. Do not put it in the URL path or persist it anywhere.

CORS doesn't apply to WS but origin checking does: validate `r.Header.Get("Origin")` server-side, allowing the same origins the HTTP CORS layer reflects (dev `http://localhost:5173`, packaged `file://`).

### 5. Verify

WS frame types don't go through codegen, so `task verify` won't catch a Go/TS drift between the two files. The verification is the cross-linking comments plus reviewer attention.

What `task verify` **will** catch:
- TS frame types not imported anywhere → `unused` lint.
- Go frame types not used → `unused` from golangci-lint.
- Generic TS errors in handlers/parsers.

## Hard rules

- Hand-written TS types are allowed **only** under `electron/src/api/ws/`. Nowhere else.
- Every WS file pair has reciprocal `// MIRROR OF <path>` comments.
- Both files change in the same commit.
- Do not register the WS handler through Huma; it would just produce noise in `openapi.yaml`.
- Frame discriminator is `type` with string literals — same convention as SSE so both styles look alike.

## Definition of done

- Paired files exist under `internal/api/ws/<name>.go` and `electron/src/api/ws/<name>.ts`.
- Discriminated unions on both sides agree, with reciprocal mirror comments.
- WS handshake validates `X-Relay-Token` and origin.
- `task verify` passes (lint will catch unused symbols on either side).
