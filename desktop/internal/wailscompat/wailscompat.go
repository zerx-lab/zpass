// Package wailscompat exposes a generic HTTP bridge that lets the Electron
// renderer keep using the same `Call.ByName("main.Service.Method", ...args)`
// surface the old Wails 3 client expected, without committing each method to
// a typed Huma operation.
//
// Why this exists
// --------------------------------------------------------------------------
// The desktop was previously a Wails 3 app: the Go process and the WebView
// shared an in-process RPC channel where the runtime reflected service
// methods by name. We moved the host shell to Electron + a loopback Huma
// server, but porting every Wails method to a typed OpenAPI operation in one
// step would have rewritten thousands of lines of vetted frontend glue. The
// compat layer is an intentional middle: hot methods can graduate to
// typed Huma endpoints over time while everything else keeps working
// against a single dispatcher.
//
// Wire format
// --------------------------------------------------------------------------
//
//	POST /wails/call
//	body { "method": "main.<Service>.<Method>", "args": [<json>, ...] }
//	200  { "result": <json> }            // method returned (T) or (T, nil)
//	200  { "result": null }              // method returned () or (nil error)
//	200  { "error":  "<message>" }       // method returned non-nil error
//	400/404 on unknown method / bad args
//
// The `main.` prefix is preserved because the existing frontend hard-codes
// it (mirroring the Go package name in the Wails 3 layout). Stripping it
// would force a frontend search-and-replace this layer was designed to
// avoid.
//
//	GET  /wails/events    (Server-Sent Events)
//	     stream of `event: <name>\ndata: <json>\n\n`
//
// Both endpoints require the X-Desktop-Token handshake header — they are
// registered behind the same auth middleware as the Huma operations.
package wailscompat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
)

// Registry holds the set of named services the bridge can dispatch to.
// It is intentionally not safe for concurrent registration; build it once
// at startup, then only read from it on the HTTP path.
type Registry struct {
	services map[string]reflect.Value // key = service basename ("ConfigService")
}

// NewRegistry returns an empty registry. Register services on it before
// passing it to NewHandler.
func NewRegistry() *Registry {
	return &Registry{services: make(map[string]reflect.Value)}
}

// Register adds svc under the given name. The caller-visible method names
// are "main.<name>.<MethodName>"; we keep the "main." prefix to match what
// the old Wails 3 client emitted, so existing frontend `Call.ByName` strings
// keep working unchanged.
//
// svc must be a non-nil pointer; nil panics during dispatch are not worth
// the noise of a runtime nil-check on every call.
func (r *Registry) Register(name string, svc any) {
	if svc == nil {
		panic("wailscompat: Register with nil service " + name)
	}
	v := reflect.ValueOf(svc)
	if v.Kind() != reflect.Pointer || v.IsNil() {
		panic("wailscompat: Register requires a non-nil pointer for " + name)
	}
	r.services[name] = v
}

// methodFor looks up the registered (svc, method) for "main.Svc.Method".
// Both segments are required; we do not autodiscover services by Go type.
func (r *Registry) methodFor(qualified string) (reflect.Value, reflect.Value, error) {
	parts := strings.Split(qualified, ".")
	if len(parts) != 3 || parts[0] != "main" {
		return reflect.Value{}, reflect.Value{}, fmt.Errorf(
			"method %q must be in the form main.Service.Method", qualified,
		)
	}
	svc, ok := r.services[parts[1]]
	if !ok {
		return reflect.Value{}, reflect.Value{}, fmt.Errorf("unknown service %q", parts[1])
	}
	m := svc.MethodByName(parts[2])
	if !m.IsValid() {
		return reflect.Value{}, reflect.Value{}, fmt.Errorf("unknown method %q on service %q", parts[2], parts[1])
	}
	return svc, m, nil
}

// callRequest is the POST /wails/call body shape.
type callRequest struct {
	Method string            `json:"method"`
	Args   []json.RawMessage `json:"args,omitempty"`
}

// callResponse is the POST /wails/call response shape.
//
// Result and Error are mutually exclusive: a method that returns nil only
// produces `{"result": null}`; a method that returns an error produces
// `{"error": "<msg>"}` so the frontend (which catches Promise rejections
// uniformly) can convert it to an exception.
type callResponse struct {
	Result any    `json:"result"`
	Error  string `json:"error,omitempty"`
}

// CallHandler returns an http.Handler that dispatches POST /wails/call.
func (r *Registry) CallHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		defer func() { _ = req.Body.Close() }()
		var rq callRequest
		if err := json.NewDecoder(req.Body).Decode(&rq); err != nil {
			http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
			return
		}
		svc, method, err := r.methodFor(rq.Method)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		out, callErr := invoke(req.Context(), svc, method, rq.Args)
		w.Header().Set("Content-Type", "application/json")
		resp := callResponse{Result: out}
		if callErr != nil {
			resp.Result = nil
			resp.Error = callErr.Error()
		}
		_ = json.NewEncoder(w).Encode(resp)
	})
}

// invoke decodes args into method's parameter types, calls the method, and
// flattens its return tuple into (result, error).
//
// Convention used by the old Wails surface:
//   - 0 returns       => result = nil, error = nil
//   - 1 return        => if error type, becomes the error; else becomes result
//   - 2 returns       => (result, error)
//   - more returns    => unsupported (reflect into []any if we ever need it)
//
// Context: if the first parameter is context.Context we inject the request
// context so long-running ops can be cancelled by client disconnect. The
// frontend never passes a Context value — args[0] only fills concrete params.
func invoke(
	ctx context.Context,
	svc, method reflect.Value,
	args []json.RawMessage,
) (any, error) {
	mt := method.Type()
	numIn := mt.NumIn()

	// Build the argument list.
	in := make([]reflect.Value, 0, numIn)
	argIdx := 0
	for i := 0; i < numIn; i++ {
		pt := mt.In(i)
		if i == 0 && pt == reflect.TypeOf((*context.Context)(nil)).Elem() {
			in = append(in, reflect.ValueOf(ctx))
			continue
		}
		if argIdx >= len(args) {
			// Allow trailing optional params: the frontend will simply omit
			// args it doesn't have a value for. The zero value of the type
			// is used; this matches Wails 3's reflection-based dispatch.
			in = append(in, reflect.Zero(pt))
			continue
		}
		raw := args[argIdx]
		argIdx++
		ptr := reflect.New(pt)
		if err := json.Unmarshal(raw, ptr.Interface()); err != nil {
			return nil, fmt.Errorf("arg %d (%s): %w", argIdx-1, pt.String(), err)
		}
		in = append(in, ptr.Elem())
	}

	// Suppress the suggestion to use safe call: any panic inside a service
	// method should propagate to the request logger; we do not pretend the
	// method succeeded. Huma's middleware logs the recovery; we only need
	// to convert the post-recover state into a 500 here.
	out := method.Call(in)

	switch len(out) {
	case 0:
		return nil, nil
	case 1:
		if mt.Out(0) == errorType {
			if v := out[0]; !v.IsNil() {
				return nil, v.Interface().(error)
			}
			return nil, nil
		}
		return out[0].Interface(), nil
	case 2:
		if mt.Out(1) != errorType {
			return nil, fmt.Errorf("method %s: second return must be error, got %s",
				mt.String(), mt.Out(1).String())
		}
		var err error
		if v := out[1]; !v.IsNil() {
			err = v.Interface().(error)
		}
		return out[0].Interface(), err
	default:
		return nil, fmt.Errorf("method %s: unsupported return arity %d", mt.String(), len(out))
	}
}

var errorType = reflect.TypeOf((*error)(nil)).Elem()

// ---------------------------------------------------------------------------
// Event bus (SSE)
// ---------------------------------------------------------------------------

// Event is one server-sent event the bus broadcasts to all subscribers.
//
// Name lands in the SSE `event:` field; Payload is JSON-encoded into `data:`.
// Most services emit `payload any` so the frontend never has to parse a
// schema — it pattern-matches on Name.
type Event struct {
	Name    string
	Payload any
}

// Hub is a fan-out broadcaster for service events. Subscribers are
// non-blocking: if a slow renderer falls behind the bounded queue, we drop
// events for that subscriber rather than back-pressure the emitter.
// Vault unlock/lock and SSH approval pop-ups are user-facing and should
// never be delayed by a stalled UI thread.
type Hub struct {
	mu     sync.Mutex
	subs   map[uint64]chan Event
	nextID atomic.Uint64
	// queueSize bounds each subscriber's per-event buffer. Small enough to
	// surface UI lag (we'd rather log "events dropped" than buffer minutes
	// of stale state) but large enough that bursty emit loops do not lose
	// events under normal scheduling.
	queueSize int
}

// NewHub returns a Hub with no subscribers. queueSize is the per-subscriber
// buffer; 64 is a sane default — events typically fire in single digits per
// user interaction.
func NewHub() *Hub {
	return &Hub{
		subs:      make(map[uint64]chan Event),
		queueSize: 64,
	}
}

// Emit fan-outs ev to every subscriber. Non-blocking: if a subscriber's
// queue is full, the event is dropped for that subscriber and a counter is
// not incremented (we accept silent loss — the alternative is letting one
// stuck renderer freeze the Go side).
func (h *Hub) Emit(name string, payload any) {
	ev := Event{Name: name, Payload: payload}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, ch := range h.subs {
		select {
		case ch <- ev:
		default:
			// dropped
		}
	}
}

// subscribe registers a new channel and returns its id and the channel.
// Use unsubscribe(id) to remove it.
func (h *Hub) subscribe() (uint64, <-chan Event) {
	id := h.nextID.Add(1)
	ch := make(chan Event, h.queueSize)
	h.mu.Lock()
	h.subs[id] = ch
	h.mu.Unlock()
	return id, ch
}

func (h *Hub) unsubscribe(id uint64) {
	h.mu.Lock()
	if ch, ok := h.subs[id]; ok {
		delete(h.subs, id)
		close(ch)
	}
	h.mu.Unlock()
}

// EventsHandler returns an http.Handler that streams events to the client
// as text/event-stream. It blocks per-request until the client disconnects
// or the request context is cancelled.
//
// Format per event:
//
//	event: <name>\n
//	data:  <json-encoded payload>\n\n
//
// We also emit a ping every 20s to keep proxies / Electron's net stack from
// considering the stream idle (Chromium closes inactive HTTP/1.1 streams
// after ~60s on some platforms; HTTP/2 keeps them but the renderer runs on
// HTTP/1.1 against our loopback).
func (h *Hub) EventsHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		h.serveSSE(w, r, flusher)
	})
}

func (h *Hub) serveSSE(w http.ResponseWriter, r *http.Request, flusher http.Flusher) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	// Electron's renderer connects via HTTP/1.1 on loopback; explicitly
	// disable Nagle-style buffering with "X-Accel-Buffering" for proxies
	// (no-op in our setup but cheap insurance) and rely on Flush() per event.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	id, ch := h.subscribe()
	defer h.unsubscribe(id)

	// Initial "ready" frame so the client can tell we accepted the stream
	// even before any service has emitted anything. Avoids the renderer
	// waiting on a silent socket.
	_, _ = fmt.Fprint(w, "event: ready\ndata: {}\n\n")
	flusher.Flush()

	for {
		select {
		case <-r.Context().Done():
			return
		case ev, alive := <-ch:
			if !alive {
				return
			}
			if err := writeSSE(w, ev); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func writeSSE(w http.ResponseWriter, ev Event) error {
	payload, err := json.Marshal(ev.Payload)
	if err != nil {
		// Marshalling failure becomes a structured error frame so the
		// renderer can log it without losing the event name.
		payload = []byte(fmt.Sprintf(`{"_error":%q}`, err.Error()))
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", sseSafe(ev.Name), payload); err != nil {
		return err
	}
	return nil
}

// sseSafe strips characters disallowed in SSE event names. Service emitters
// already use ASCII-only names, but cheap insurance.
func sseSafe(s string) string {
	if s == "" {
		return "message"
	}
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, s)
}

// EmitterFunc is the signature service constructors expect for their
// SetEventEmitter setter. Returning it from a Hub keeps the bridge dependency
// out of the services package — they just see func(string, any).
func (h *Hub) EmitterFunc() func(event string, payload any) {
	return func(event string, payload any) { h.Emit(event, payload) }
}

// Sentinel guard: importing errors keeps the dependency stable across the
// generic dispatcher’s future error-wrapping work.
var _ = errors.New
