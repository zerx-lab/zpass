// Package server builds the HTTP server that hosts the Huma API and the
// generic Wails compatibility surface (POST /wails/call + GET /wails/events).
//
// Security model:
//   - The server binds to 127.0.0.1 on an OS-assigned port. It is never
//     reachable from another host.
//   - A random handshake token is generated on startup and required on every
//     request via the X-Desktop-Token header. The Electron main process reads
//     the token from stdout and forwards it to the renderer through preload.
//   - The Wails-compat endpoints share the same token. The reflection
//     dispatcher itself does not validate inputs beyond JSON-decoding, so the
//     token boundary is what keeps random local processes from poking
//     vault.unlock() at us.
package server

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"

	"github.com/zerx-lab/zpass/internal/api"
	"github.com/zerx-lab/zpass/internal/wailscompat"
)

const (
	// AuthHeader is the request header that must carry the handshake token.
	AuthHeader = "X-Desktop-Token"

	// LoopbackHost is the only address we ever bind to.
	LoopbackHost = "127.0.0.1"
)

// Config controls how the HTTP server is constructed. All fields are optional;
// zero values produce a production-safe default.
type Config struct {
	// Port to bind. 0 means "let the OS pick a free port".
	Port int
	// Token to require. Empty means "generate a fresh random token".
	Token string
	// Registry, when non-nil, is wired to POST /wails/call. Pass nil during
	// `go run . openapi …` where no services are constructed.
	Registry *wailscompat.Registry
	// Hub, when non-nil, is wired to GET /wails/events. Same nil-during-dump
	// convention as Registry.
	Hub *wailscompat.Hub
}

// Built is the result of Build. It exposes everything the caller needs to
// start serving, print the handshake to stdout, or dump the OpenAPI schema.
type Built struct {
	Listener net.Listener
	// Handler is the mux wrapped with CORS. Use this when calling http.Serve.
	Handler http.Handler
	Mux     *http.ServeMux
	API     huma.API
	Token   string
}

// Build constructs the listener, mux, Huma API, and auth middleware without
// starting Serve. Callers decide when (and whether) to block.
func Build(cfg Config) (*Built, error) {
	token := cfg.Token
	if token == "" {
		var err error
		token, err = randomToken(32)
		if err != nil {
			return nil, err
		}
	}

	addr := net.JoinHostPort(LoopbackHost, strconv.Itoa(cfg.Port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	humaCfg := huma.DefaultConfig("Desktop API", "0.3.0")
	humaCfg.Info.Description = "HTTP API exposed by the Go backend to the Electron renderer."
	humaAPI := humago.New(mux, humaCfg)

	// Auth middleware is applied at the mux level (see authedMux below) so it
	// also covers /wails/* — Huma middleware would only cover typed endpoints.
	api.Register(humaAPI)

	// Generic Wails-compat dispatcher. The auth middleware below gates both
	// these and the Huma endpoints; nil-checks let `dumpOpenAPI` build a
	// stripped server that does not require constructing the whole service
	// graph.
	if cfg.Registry != nil {
		mux.Handle("POST /wails/call", cfg.Registry.CallHandler())
	}
	if cfg.Hub != nil {
		mux.Handle("GET /wails/events", cfg.Hub.EventsHandler())
	}

	return &Built{
		Listener: ln,
		Handler:  corsMiddleware(authMux(mux, token)),
		Mux:      mux,
		API:      humaAPI,
		Token:    token,
	}, nil
}

// authMux wraps mux so any unauthenticated request gets a uniform 401,
// regardless of whether the route is a Huma operation or /wails/*.
//
// The token must arrive in the X-Desktop-Token header for normal requests.
// EventSource (used by the renderer's SSE subscription) cannot set custom
// headers, so we additionally accept ?token=<hex> as a fallback. Loopback-
// only binding + per-launch random token make the query-string variant
// equivalent in practice — anything that can read the URL already has
// access to the localhost socket.
//
// Huma has its own UseMiddleware, but it only protects typed endpoints.
// Wrapping the whole mux is simpler and avoids a class of "I forgot the
// auth header on the new route" bugs.
func authMux(mux *http.ServeMux, token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// CORS preflights are short-circuited in corsMiddleware before they
		// reach here, so any OPTIONS that lands here is malformed.
		provided := r.Header.Get(AuthHeader)
		if provided == "" {
			provided = r.URL.Query().Get("token")
		}
		if provided != token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// corsMiddleware allows the Electron renderer (loaded from file:// in packaged
// mode or http://localhost:5173 in dev) to call the loopback backend. The
// server only binds to 127.0.0.1, so reflecting the origin does not widen the
// attack surface — anything that can reach the port could already speak HTTP
// to it directly. Preflight (OPTIONS) requests are short-circuited here so
// they never hit the auth middleware, which rightfully has no token to check.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			origin = "*"
		}
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Vary", "Origin")
		h.Set("Access-Control-Allow-Headers", "Content-Type, "+AuthHeader)
		h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		h.Set("Access-Control-Max-Age", "600")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// trimMainPrefix is a tiny helper used by callers that log handler routes.
// Exported so dev tooling can print the human form of a method name.
func TrimMainPrefix(s string) string { return strings.TrimPrefix(s, "main.") }

func randomToken(nBytes int) (string, error) {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
