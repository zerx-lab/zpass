---
name: add-sse-endpoint
description: Add a Server-Sent Events (SSE) endpoint that stays inside the OpenAPI-driven contract. Use when the user wants streaming/long-lived push from Go to the renderer and WebSocket is not required. Covers registering `text/event-stream` in Huma, declaring a discriminated-union event schema, and writing the thin TS parser since `openapi-typescript` only types the stream body as `string`.
---

## When to use SSE vs WebSocket

Default to SSE. Choose WS only if you need client-to-server frames or binary frames. SSE stays inside OpenAPI (so types flow through `schema.ts`); WS does not (see the `add-ws-frames` skill for the WS escape hatch).

## Workflow

### 1. Define the event payload as a named OneOf schema in Go

Declare each event variant as its own struct, then a wrapper that Huma will register as a discriminated union. Use a `type` discriminator field so the TS parser can switch on it.

```go
// internal/api/<feature>_events.go
type ProgressEvent struct {
    Type    string  `json:"type" enum:"progress" doc:"Discriminator."`
    Percent float64 `json:"percent" minimum:"0" maximum:"100"`
}

type DoneEvent struct {
    Type   string `json:"type" enum:"done" doc:"Discriminator."`
    Result string `json:"result"`
}

type ErrorEvent struct {
    Type    string `json:"type" enum:"error" doc:"Discriminator."`
    Message string `json:"message"`
}
```

### 2. Register the operation with `text/event-stream`

Huma supports streaming responses. The body type for SSE is conventionally written as a sealed interface or a `oneOf` schema; consult Huma's current docs for the exact registration helper before coding. Register the variant structs as named components so they end up in `openapi.yaml` and are emitted into `schema.ts`. The HTTP response content type must be `text/event-stream`.

Key requirements:
- Operation `Method: http.MethodGet`, `Path: "/feature/stream"`.
- Response `Content-Type: text/event-stream`.
- Each event payload **must** match one of the registered variant schemas, encoded as JSON in the `data:` field.
- Flush after every event (`http.Flusher`) or buffering kills the stream.

### 3. Write the TS parser (this is the manual part)

`openapi-typescript` emits the SSE body as `string`. We must split the stream into events ourselves and narrow to the discriminated union. Put the parser next to the call site under `electron/src/api/`. Import the variant types from the generated `schema.ts` — do **not** redeclare them.

Sketch:

```ts
import type { components } from "./schema";

type StreamEvent =
  | components["schemas"]["ProgressEvent"]
  | components["schemas"]["DoneEvent"]
  | components["schemas"]["ErrorEvent"];

export async function* readSseEvents(
  resp: Response,
): AsyncGenerator<StreamEvent> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    // SSE event separator is a blank line.
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = raw
        .split("\n")
        .find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      if (!json) continue;
      yield JSON.parse(json) as StreamEvent;
    }
  }
}
```

The caller switches on `event.type` and gets full type narrowing because the variant types each fix `type` to a string literal via the `enum:` tag.

### 4. Calling from the renderer

`openapi-fetch` returns `Response` for non-JSON bodies. Pass that to the parser:

```ts
const client = await getClient();
const { response } = await client.GET("/feature/stream", { parseAs: "stream" });
for await (const ev of readSseEvents(response)) {
  switch (ev.type) {
    case "progress": /* … */ break;
    case "done":     /* … */ break;
    case "error":    /* … */ break;
  }
}
```

### 5. Regenerate and verify

```
task openapi && task codegen
task verify
```

Inspect `electron/src/api/schema.ts` to confirm each event variant appears under `components.schemas` and the operation's response uses the union.

## Hard rules

- The variant schemas **must** be registered as named OpenAPI components. Inline anonymous structs produce ugly TS types and break narrowing.
- Discriminator field is `type` with a string literal (`enum:"progress"` etc). Do not use a numeric tag.
- TS parser is the **only** TS code allowed to interpret raw stream text. Everything downstream consumes the discriminated union.
- If you find yourself wanting bidirectional messaging, stop and switch to WS (see `add-ws-frames`).

## Definition of done

- `openapi.yaml` contains the operation with `text/event-stream` response and named OneOf payload.
- `schema.ts` reflects the variant components and the operation.
- Parser yields a discriminated union; renderer code typechecks under `task typecheck`.
- `task verify` passes.
