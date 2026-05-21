// Package api registers all HTTP operations on a Huma API instance.
//
// Adding a new endpoint:
//  1. Define request/response structs in this package.
//  2. Call huma.Register(api, op, handler) inside Register().
//  3. Re-run `task codegen` so the TS client picks up the new types.
//
// The Wails compatibility surface (POST /wails/call, GET /wails/events) is
// not registered with Huma — it is wired onto the underlying mux by the
// server package so the catch-all reflection dispatcher does not pollute
// the typed OpenAPI document. See internal/wailscompat for details.
package api

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
)

// Register wires every typed operation onto the provided Huma API.
// Keep handlers small; push real logic into sub-packages under /internal.
func Register(api huma.API) {
	huma.Register(api, huma.Operation{
		OperationID: "get-health",
		Method:      http.MethodGet,
		Path:        "/health",
		Summary:     "Health probe",
		Description: "Returns ok when the Go backend is reachable.",
		Tags:        []string{"system"},
	}, healthHandler)
}

// --- health ---

type HealthOutput struct {
	Body struct {
		Status string    `json:"status" example:"ok" doc:"Always 'ok' when the server is healthy."`
		Time   time.Time `json:"time" doc:"Server time in RFC3339."`
	}
}

func healthHandler(_ context.Context, _ *struct{}) (*HealthOutput, error) {
	out := &HealthOutput{}
	out.Body.Status = "ok"
	out.Body.Time = time.Now().UTC()
	return out, nil
}
