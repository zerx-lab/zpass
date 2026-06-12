package services_test

// This test exercises the EXACT reflection-dispatch path the frontend uses:
// POST /wails/call {method:"main.CloudService.X", args:[...]} through the
// wailscompat Registry.CallHandler. Go unit tests elsewhere call the service
// methods directly; only this one proves the method SIGNATURES survive the
// reflection layer (struct-return-without-error like Status()/ListConflicts(),
// multi-arg calls, (T,error) flattening) and that the JSON result shapes match
// what the TS cloud-api expects. A mismatch here is invisible to tsc/biome.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zerx-lab/zpass/internal/services"
	"github.com/zerx-lab/zpass/internal/wailscompat"
)

func dispatch(t *testing.T, h http.Handler, method string, args ...any) (json.RawMessage, string) {
	t.Helper()
	rawArgs := make([]json.RawMessage, 0, len(args))
	for _, a := range args {
		b, err := json.Marshal(a)
		if err != nil {
			t.Fatalf("marshal arg: %v", err)
		}
		rawArgs = append(rawArgs, b)
	}
	body, _ := json.Marshal(map[string]any{"method": method, "args": rawArgs})
	req := httptest.NewRequest(http.MethodPost, "/wails/call", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("%s: HTTP %d: %s", method, rec.Code, rec.Body.String())
	}
	var resp struct {
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("%s: decode response %q: %v", method, rec.Body.String(), err)
	}
	return resp.Result, resp.Error
}

func TestCloudServiceWailsDispatch(t *testing.T) {
	reg := wailscompat.NewRegistry()
	reg.Register("CloudService", services.NewCloudService(nil))
	h := reg.CallHandler()

	// Status() CloudStatus — single non-error struct return. The riskiest shape
	// for the reflection layer; must produce a JSON object with the documented
	// fields the TS CloudStatus reads.
	res, errMsg := dispatch(t, h, "main.CloudService.Status")
	if errMsg != "" {
		t.Fatalf("Status error: %s", errMsg)
	}
	var status map[string]any
	if err := json.Unmarshal(res, &status); err != nil {
		t.Fatalf("Status result not an object: %s", res)
	}
	for _, key := range []string{"configured", "baseUrl", "signedIn", "storeBackend", "storePersist", "hasCachedToken"} {
		if _, ok := status[key]; !ok {
			t.Fatalf("Status JSON missing %q: %v", key, status)
		}
	}

	// Configure(string) error — one string arg, error return; success => null.
	if res, errMsg := dispatch(t, h, "main.CloudService.Configure", "http://127.0.0.1:1"); errMsg != "" || string(res) != "null" {
		t.Fatalf("Configure = (%s, %q), want (null, \"\")", res, errMsg)
	}

	// ListConflicts() []SyncConflict — single non-error slice return. Empty must
	// marshal to [] (the TS side does `arr ?? []`).
	if res, errMsg := dispatch(t, h, "main.CloudService.ListConflicts"); errMsg != "" || string(res) != "[]" {
		t.Fatalf("ListConflicts = (%s, %q), want ([], \"\")", res, errMsg)
	}

	// SyncNow() (CloudSyncSummary, error) — struct + error tuple. With vault==nil
	// it returns the clean "vault service unavailable" error, proving the error
	// half of the 2-return flatten (the struct half is proven by Status above).
	if _, errMsg := dispatch(t, h, "main.CloudService.SyncNow"); errMsg == "" {
		t.Fatalf("SyncNow(no vault) should error via dispatch")
	}

	// LinkedSpaces() ([]LinkedSpace, error) — slice+error tuple; vault==nil => nil
	// slice, no error, which the dispatch marshals as JSON null.
	if _, errMsg := dispatch(t, h, "main.CloudService.LinkedSpaces"); errMsg != "" {
		t.Fatalf("LinkedSpaces error: %s", errMsg)
	}

	// ResolveConflict(string,string) error — two args; invalid resolution errors.
	if _, errMsg := dispatch(t, h, "main.CloudService.ResolveConflict", "id", "bogus"); errMsg == "" {
		t.Fatalf("ResolveConflict(bogus) should error via dispatch")
	}

	// CreateCloudVault(string) (string,error) — arg decode + (string,error) flatten.
	// vault==nil here, so it returns a clean error (validating the error path).
	if _, errMsg := dispatch(t, h, "main.CloudService.CreateCloudVault", "space-x"); errMsg == "" {
		t.Fatalf("CreateCloudVault(no vault) should error via dispatch")
	}

	// SignOut() error — zero args, error return; success => null.
	if res, errMsg := dispatch(t, h, "main.CloudService.SignOut"); errMsg != "" || string(res) != "null" {
		t.Fatalf("SignOut = (%s, %q), want (null, \"\")", res, errMsg)
	}

	// PokeRealtime() — zero args, no return; the system-resume / network-online
	// frontend hook calls this. Signed out it is a clean no-op (null result).
	if res, errMsg := dispatch(t, h, "main.CloudService.PokeRealtime"); errMsg != "" || string(res) != "null" {
		t.Fatalf("PokeRealtime = (%s, %q), want (null, \"\")", res, errMsg)
	}

	// SignIn(string,string,string) (AccountResult,error) — three args; a bad
	// secret key errors before any network, proving 3-arg decode works.
	if _, errMsg := dispatch(t, h, "main.CloudService.SignIn", "user@example.com", "a strong password", "not-a-key"); errMsg == "" {
		t.Fatalf("SignIn(bad key) should error via dispatch")
	}
}
