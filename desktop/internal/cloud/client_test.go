package cloud

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// newTestServer spins up an httptest server whose handler is the given func and
// returns a client pointed at it.
func newTestServer(t *testing.T, h http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return NewClient(srv.URL, srv.Client()), srv
}

func TestRegisterDecodesSessionToken(t *testing.T) {
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/auth/register" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var req RegisterRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode req: %v", err)
		}
		if req.SrpSalt == "" || req.SrpVerifier == "" || req.KdfParams.SaltEnc == "" {
			t.Errorf("missing fields: %+v", req)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user_id": "u1", "tenant_id": "t1", "session_token": "jwt-abc",
		})
	})
	resp, err := c.Register(context.Background(), RegisterRequest{
		Email: "a@b.c", SrpSalt: "c2FsdA==", SrpVerifier: "dg==",
		KdfParams: KdfParams{Alg: "argon2id", M: 65536, T: 3, P: 4, SaltEnc: "ZW5j", SkVersion: "Z1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.SessionToken != "jwt-abc" {
		t.Fatalf("session_token = %q, want jwt-abc", resp.SessionToken)
	}
}

func TestErrorBodyMapsToAPIError(t *testing.T) {
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid credentials"})
	})
	_, err := c.LoginStart(context.Background(), LoginStartRequest{Email: "x@y.z", APub: "QQ=="})
	if err == nil {
		t.Fatal("expected error")
	}
	if !IsUnauthorized(err) {
		t.Fatalf("IsUnauthorized = false for %v", err)
	}
	var apiErr *APIError
	if !as(err, &apiErr) || apiErr.Message != "invalid credentials" {
		t.Fatalf("APIError not parsed: %v", err)
	}
}

func TestLoginStartFieldNames(t *testing.T) {
	// The client must send JSON key "A" (not "a_pub") and read "B"/"login_id".
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		var raw map[string]any
		_ = json.NewDecoder(r.Body).Decode(&raw)
		if _, ok := raw["A"]; !ok {
			t.Errorf("request missing JSON key \"A\": %v", raw)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"srp_salt": "c2FsdA==", "B": "Qg==",
			"kdf_params": map[string]any{"alg": "argon2id", "m": 65536, "t": 3, "p": 4, "salt_enc": "ZW5j", "sk_version": "Z1"},
			"login_id":   "lid-1",
		})
	})
	resp, err := c.LoginStart(context.Background(), LoginStartRequest{Email: "x@y.z", APub: "QQ=="})
	if err != nil {
		t.Fatal(err)
	}
	if resp.BPub != "Qg==" || resp.LoginID != "lid-1" || resp.KdfParams.SaltEnc != "ZW5j" {
		t.Fatalf("login start decode wrong: %+v", resp)
	}
}

func TestChangeConflictIsInBand(t *testing.T) {
	// A CAS conflict is HTTP 200 with status:"conflict" — must NOT be an error.
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer tok-1" {
			t.Errorf("Authorization = %q, want Bearer tok-1", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "conflict", "expected_base_seq": 7,
			"server": map[string]any{"seq": 7, "ciphertext": "Yw==", "content_hash": "ab", "deleted": false, "updated_at": 100, "revision": 3},
		})
	})
	c.SetToken("tok-1")
	resp, err := c.PostChange(context.Background(), "v1", ChangeRequest{ItemID: "i1", BaseSeq: 5})
	if err != nil {
		t.Fatalf("conflict should be in-band, got error: %v", err)
	}
	if !resp.IsConflict() || resp.ExpectedBaseSeq != 7 || resp.Server == nil || resp.Server.Seq != 7 {
		t.Fatalf("conflict not decoded: %+v", resp)
	}
}

func TestProtectedRequiresToken(t *testing.T) {
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("server should not be hit without a token")
	})
	_, err := c.ListVaults(context.Background())
	if !IsUnauthorized(err) {
		t.Fatalf("ListVaults without token = %v, want 401 short-circuit", err)
	}
}

func TestSnapshotQueryParams(t *testing.T) {
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("cursor") != "42" || q.Get("limit") != "100" {
			t.Errorf("query = %v, want cursor=42 limit=100", q)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{}, "has_more": false, "next_cursor": 42, "current_seq": 42,
		})
	})
	c.SetToken("t")
	resp, err := c.Snapshot(context.Background(), "v1", 42, 100)
	if err != nil {
		t.Fatal(err)
	}
	if resp.CurrentSeq != 42 {
		t.Fatalf("current_seq = %d", resp.CurrentSeq)
	}
}
