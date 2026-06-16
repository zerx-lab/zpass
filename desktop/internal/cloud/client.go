// Package cloud is the typed HTTP wire client for the ZPass cloud server
// (zero-knowledge account + sync API). It is a leaf package: it depends only on
// the standard library and carries the exact wire contract verified against the
// running Rust/axum server — base64 is STANDARD with padding, the JWT field is
// "session_token", SRP fields are "A"/"B"/"M1"/"M2", and the /changes CAS
// conflict is an HTTP 200 with body status:"conflict" (NOT an HTTP error).
//
// The client holds no crypto: callers (internal/services.CloudService) drive
// the SRP / keyset / sealed-box math via internal/cloudcrypto and hand this
// package only the already-encoded base64 strings. Keeping the wire types here,
// pure and httptest-friendly, isolates "did the bytes match the server" from
// "did the crypto chain derive the right bytes".
package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultTimeout bounds a single request. Sync loops layer their own backoff on
// top of this; auth calls (which run an interactive Argon2id before the request
// and a server-side modexp during it) get the same ceiling.
const DefaultTimeout = 30 * time.Second

// Client is a configured connection to one cloud server base URL. It is safe for
// concurrent use; SetToken swaps the bearer token under a short lock.
type Client struct {
	baseURL string
	http    *http.Client
	token   atomicString
}

// NewClient builds a client for baseURL (e.g. "https://api.zpass.app"). A
// trailing slash is tolerated. http is optional; nil installs a default client
// with DefaultTimeout.
func NewClient(baseURL string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: DefaultTimeout}
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    httpClient,
	}
}

// BaseURL returns the configured server origin (no trailing slash).
func (c *Client) BaseURL() string { return c.baseURL }

// SetToken installs the bearer JWT used for protected endpoints. Pass "" to
// clear it (e.g. on sign-out or after a 401).
func (c *Client) SetToken(token string) { c.token.Store(token) }

// HasToken reports whether a bearer token is currently set.
func (c *Client) HasToken() bool { return c.token.Load() != "" }

// APIError is a non-2xx response carrying the server's {"error":"..."} body.
//
// PlanLimitRaw holds the raw response body for 403 responses only, so the
// attachment layer can recover the plan_limit_exceeded sibling fields
// (dimension/limit/current/plan) that Message (= the "error" value) drops. It
// is nil for every other status to avoid retaining bodies unnecessarily.
type APIError struct {
	Status       int
	Message      string
	PlanLimitRaw []byte
}

func (e *APIError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("cloud: http %d", e.Status)
	}
	return fmt.Sprintf("cloud: http %d: %s", e.Status, e.Message)
}

// IsStatus reports whether err is an APIError with the given HTTP status.
func IsStatus(err error, status int) bool {
	var apiErr *APIError
	if as(err, &apiErr) {
		return apiErr.Status == status
	}
	return false
}

// IsUnauthorized reports a 401 (expired/invalid token → re-login required).
func IsUnauthorized(err error) bool { return IsStatus(err, http.StatusUnauthorized) }

// IsVaultFrozen reports a 403 vault_frozen — the vault fell outside the
// plan's active quota after a downgrade (writes rejected, reads still served).
func IsVaultFrozen(err error) bool {
	var apiErr *APIError
	if as(err, &apiErr) {
		return apiErr.Status == http.StatusForbidden && apiErr.Message == "vault_frozen"
	}
	return false
}

// ---------------------------------------------------------------------------
// kdf_params (shared by register / login)
// ---------------------------------------------------------------------------

// KdfParams is the account KDF descriptor stored opaquely by the server and
// echoed back on login so a second device can re-derive AUK (salt_enc) and
// SRP-x (srp_salt). Field names match the server's JSON exactly.
type KdfParams struct {
	Alg     string `json:"alg"`      // "argon2id"
	M       uint32 `json:"m"`        // memory KiB (65536 = 64 MiB)
	T       uint32 `json:"t"`        // iterations
	P       uint32 `json:"p"`        // parallelism
	SaltEnc string `json:"salt_enc"` // base64(STANDARD) 32B — AUK slow-KDF salt
	// SkVersion is the Secret Key encoding tag. The cloud reference client stores
	// the STRING "Z1" here (not a number), so this must be a string to decode the
	// kdf_params the server echoes back at login.
	SkVersion string `json:"sk_version"`
}

// ---------------------------------------------------------------------------
// Auth: register / login (unauthenticated)
// ---------------------------------------------------------------------------

// RegisterRequest is POST /v1/auth/register. All byte fields are base64 STANDARD.
type RegisterRequest struct {
	Email       string    `json:"email"`
	SrpSalt     string    `json:"srp_salt"`     // = derive_srp_x salt_auth
	SrpVerifier string    `json:"srp_verifier"` // v = g^x mod N (256B padded)
	KdfParams   KdfParams `json:"kdf_params"`
}

// RegisterResponse is the 200 body. SessionToken is the bearer JWT (24h).
type RegisterResponse struct {
	UserID       string `json:"user_id"`
	TenantID     string `json:"tenant_id"`
	SessionToken string `json:"session_token"`
}

// Register creates an account. The server stores only srp_salt/srp_verifier/
// kdf_params (+ email); it never sees the password, Secret Key, AUK or SRP-x.
func (c *Client) Register(ctx context.Context, req RegisterRequest) (RegisterResponse, error) {
	var out RegisterResponse
	err := c.do(ctx, http.MethodPost, "/v1/auth/register", false, req, &out)
	return out, err
}

// LoginStartRequest is POST /v1/auth/login/start. APub is the client ephemeral
// A = g^a mod N; its JSON key is "A".
type LoginStartRequest struct {
	Email string `json:"email"`
	APub  string `json:"A"` // base64(STANDARD)
}

// LoginStartResponse carries the server ephemeral B and the salts/params needed
// to derive SRP-x and AUK. LoginID is one-shot (consumed by login/finish).
type LoginStartResponse struct {
	SrpSalt   string    `json:"srp_salt"` // = salt_auth (DeriveSRPx salt)
	BPub      string    `json:"B"`        // base64(STANDARD)
	KdfParams KdfParams `json:"kdf_params"`
	LoginID   string    `json:"login_id"`
}

// LoginStart begins the SRP-6a handshake. A 401 "invalid credentials" means the
// email is unknown.
func (c *Client) LoginStart(ctx context.Context, req LoginStartRequest) (LoginStartResponse, error) {
	var out LoginStartResponse
	err := c.do(ctx, http.MethodPost, "/v1/auth/login/start", false, req, &out)
	return out, err
}

// LoginFinishRequest is POST /v1/auth/login/finish. M1 is the client proof; its
// JSON key is "M1".
type LoginFinishRequest struct {
	LoginID string `json:"login_id"`
	M1      string `json:"M1"` // base64(STANDARD)
}

// LoginFinishResponse: M2 is always present (verify it before trusting the
// server). SessionToken is present when no MFA is required; otherwise
// MfaRequired is true and MfaToken carries the second-factor challenge id.
type LoginFinishResponse struct {
	M2           string `json:"M2"` // base64(STANDARD)
	SessionToken string `json:"session_token"`
	MfaRequired  bool   `json:"mfa_required"`
	MfaToken     string `json:"mfa_token"`
}

// LoginFinish submits M1 and (on success, no MFA) returns the session token. A
// 401 "invalid credentials" means the M1 proof failed (wrong password / Secret
// Key). A 410 means the login attempt expired or was already consumed.
func (c *Client) LoginFinish(ctx context.Context, req LoginFinishRequest) (LoginFinishResponse, error) {
	var out LoginFinishResponse
	err := c.do(ctx, http.MethodPost, "/v1/auth/login/finish", false, req, &out)
	return out, err
}

// ---------------------------------------------------------------------------
// Keyset (JWT-protected)
// ---------------------------------------------------------------------------

// KeysetRequest is POST /v1/keyset. Algo MUST be "x25519".
type KeysetRequest struct {
	PublicKey           string `json:"public_key"`            // base64 32B
	EncryptedPrivateKey string `json:"encrypted_private_key"` // base64 72B
	Algo                string `json:"algo"`                  // "x25519"
}

// KeysetResponse is GET /v1/keyset.
type KeysetResponse struct {
	PublicKey           string `json:"public_key"`
	EncryptedPrivateKey string `json:"encrypted_private_key"`
	Algo                string `json:"algo"`
}

// PutKeyset uploads the account X25519 keyset (public key + AUK-wrapped private
// key). Idempotent (ON CONFLICT upsert server-side).
func (c *Client) PutKeyset(ctx context.Context, req KeysetRequest) error {
	return c.do(ctx, http.MethodPost, "/v1/keyset", true, req, nil)
}

// GetKeyset fetches the account keyset so a second device can unwrap the
// private key with its locally derived AUK. A 404 means no keyset uploaded yet.
func (c *Client) GetKeyset(ctx context.Context) (KeysetResponse, error) {
	var out KeysetResponse
	err := c.do(ctx, http.MethodGet, "/v1/keyset", true, nil, &out)
	return out, err
}

// ---------------------------------------------------------------------------
// Vaults (JWT-protected)
// ---------------------------------------------------------------------------

// CreateVaultRequest is POST /v1/vaults. The vault_id is server-assigned.
type CreateVaultRequest struct {
	WrappedVaultKey string `json:"wrapped_vault_key"` // base64 sealed-box
	// EncryptedMeta is the vault's name/glyph sealed with the vault key
	// (base64 AEAD blob, opaque to the server). Optional.
	EncryptedMeta string `json:"encrypted_meta,omitempty"`
}

// CreateVaultResponse returns the server-assigned vault UUID.
type CreateVaultResponse struct {
	VaultID string `json:"vault_id"`
}

// CreateVault creates a private vault with the caller as owner+member. The
// wrapped_vault_key is seal_to_pubkey(ownerPub, vaultKey).
func (c *Client) CreateVault(ctx context.Context, req CreateVaultRequest) (CreateVaultResponse, error) {
	var out CreateVaultResponse
	err := c.do(ctx, http.MethodPost, "/v1/vaults", true, req, &out)
	return out, err
}

// memberSelfResponse is GET /v1/vaults/{id}/members/self.
type memberSelfResponse struct {
	WrappedVaultKey string `json:"wrapped_vault_key"`
}

// GetVaultMemberSelf returns the caller's wrapped_vault_key for vaultID, to be
// unwrapped with the account private key. A 404 means the caller is not a
// member of that vault.
func (c *Client) GetVaultMemberSelf(ctx context.Context, vaultID string) (string, error) {
	var out memberSelfResponse
	path := "/v1/vaults/" + url.PathEscape(vaultID) + "/members/self"
	err := c.do(ctx, http.MethodGet, path, true, nil, &out)
	return out.WrappedVaultKey, err
}

// VaultSummary is one entry of GET /v1/vaults.
type VaultSummary struct {
	VaultID    string `json:"vault_id"`
	CreatedAt  string `json:"created_at"`
	CurrentSeq int64  `json:"current_seq"`
	ItemCount  int64  `json:"item_count"`
	Role       string `json:"role"`
	// EncryptedMeta is the base64 AEAD blob holding the vault's name/glyph
	// (sealed with the vault key). "" for legacy vaults not yet backfilled.
	EncryptedMeta string `json:"encrypted_meta"`
	// Frozen marks a vault outside the plan's active quota after a downgrade:
	// reads still work, writes are rejected with 403 vault_frozen.
	Frozen bool `json:"frozen"`
}

type listVaultsResponse struct {
	Vaults []VaultSummary `json:"vaults"`
}

// ListVaults returns the vaults the caller is a member of, with each vault's
// current_seq (sync high-water mark) and item_count.
func (c *Client) ListVaults(ctx context.Context) ([]VaultSummary, error) {
	var out listVaultsResponse
	err := c.do(ctx, http.MethodGet, "/v1/vaults", true, nil, &out)
	return out.Vaults, err
}

// updateVaultMetaRequest is PUT /v1/vaults/{id}/meta.
type updateVaultMetaRequest struct {
	EncryptedMeta string `json:"encrypted_meta"`
}

// UpdateVaultMeta replaces a vault's encrypted metadata blob (any member).
// Used to backfill legacy vaults and propagate local space renames.
func (c *Client) UpdateVaultMeta(ctx context.Context, vaultID, encryptedMeta string) error {
	path := "/v1/vaults/" + url.PathEscape(vaultID) + "/meta"
	return c.do(ctx, http.MethodPut, path, true, updateVaultMetaRequest{EncryptedMeta: encryptedMeta}, nil)
}

// DeleteVault deletes an entire server vault (owner only; the server refuses
// to delete the account's last vault with 409).
func (c *Client) DeleteVault(ctx context.Context, vaultID string) error {
	path := "/v1/vaults/" + url.PathEscape(vaultID)
	return c.do(ctx, http.MethodDelete, path, true, nil, nil)
}

// ActivateVault pins a vault as plan-active (POST /v1/vaults/{id}/activate).
// Under a max_vaults downgrade this swaps which vault stays writable: the
// pinned vault enters the active set and the displaced one freezes. Data is
// never touched; the call is a no-op for unlimited plans.
func (c *Client) ActivateVault(ctx context.Context, vaultID string) error {
	path := "/v1/vaults/" + url.PathEscape(vaultID) + "/activate"
	return c.do(ctx, http.MethodPost, path, true, nil, nil)
}

// EntitlementDimension is one quota dimension of GET /v1/entitlements.
// Limit nil = unlimited. Units: bytes for storage_quota_mb, counts otherwise.
type EntitlementDimension struct {
	Dimension string `json:"dimension"`
	Limit     *int64 `json:"limit"`
	Current   int64  `json:"current"`
}

// Entitlements is the response of GET /v1/entitlements: effective plan quota,
// per-dimension usage, and vaults frozen by a plan downgrade (read-only).
type Entitlements struct {
	Plan           string                 `json:"plan"`
	Dimensions     []EntitlementDimension `json:"dimensions"`
	FrozenVaultIDs []string               `json:"frozen_vault_ids"`
}

// GetEntitlements fetches the account's plan quota and usage so clients can
// warn about limits up front instead of only reacting to 403s.
func (c *Client) GetEntitlements(ctx context.Context) (Entitlements, error) {
	var out Entitlements
	err := c.do(ctx, http.MethodGet, "/v1/entitlements", true, nil, &out)
	return out, err
}

// ---------------------------------------------------------------------------
// Sync: snapshot (pull) + changes (push, CAS)
// ---------------------------------------------------------------------------

// SnapshotItem is one item in a snapshot page (latest version per item_id).
// Tombstones are filtered out server-side unless the request asked for them
// with include_deleted=true, in which case Deleted marks them (with an empty
// Ciphertext).
type SnapshotItem struct {
	ItemID      string `json:"item_id"`
	Seq         int64  `json:"seq"`
	Ciphertext  string `json:"ciphertext"`   // base64(STANDARD); "" for tombstones
	ContentHash string `json:"content_hash"` // hex or "" (null → "")
	UpdatedAt   int64  `json:"updated_at"`
	Revision    int64  `json:"revision"`
	Deleted     bool   `json:"deleted"` // only with include_deleted=true
}

// SnapshotResponse is GET /v1/vaults/{id}/snapshot. NOTE: has_more is computed
// server-side as len(items)==limit AFTER tombstone filtering, so it can
// false-negative; callers must page until next_cursor >= current_seq rather
// than trusting has_more alone.
type SnapshotResponse struct {
	Items      []SnapshotItem `json:"items"`
	HasMore    bool           `json:"has_more"`
	NextCursor int64          `json:"next_cursor"`
	CurrentSeq int64          `json:"current_seq"`
}

// Snapshot fetches one page of the latest-version-per-item snapshot starting
// after cursor (0 for first page). limit is clamped server-side to [1,500].
// includeDeleted=true asks the server to include tombstones (Deleted=true,
// empty ciphertext) — the incremental-pull path needs them to propagate remote
// deletes; the full-reconcile path keeps the historical filtered view. A
// 410 means the cursor fell below the server's oldest retained seq and the
// client must discard its cache and full-resync from cursor 0.
func (c *Client) Snapshot(ctx context.Context, vaultID string, cursor, limit int64, includeDeleted bool) (SnapshotResponse, error) {
	var out SnapshotResponse
	q := url.Values{}
	q.Set("cursor", strconv.FormatInt(cursor, 10))
	if limit > 0 {
		q.Set("limit", strconv.FormatInt(limit, 10))
	}
	if includeDeleted {
		q.Set("include_deleted", "true")
	}
	path := "/v1/vaults/" + url.PathEscape(vaultID) + "/snapshot?" + q.Encode()
	err := c.do(ctx, http.MethodGet, path, true, nil, &out)
	return out, err
}

// ChangeRequest is POST /v1/vaults/{id}/changes — a single optimistic-CAS
// mutation. BaseSeq is the last seq this client saw for ItemID (0 for a brand
// new item). Deleted=true marks a tombstone (Ciphertext omitted).
// ClientMutationID is a client UUIDv4 idempotency key.
type ChangeRequest struct {
	ItemID           string `json:"item_id"`
	BaseSeq          int64  `json:"base_seq"`
	Deleted          bool   `json:"deleted"`
	Ciphertext       string `json:"ciphertext,omitempty"`
	ContentHash      string `json:"content_hash,omitempty"`
	UpdatedAt        int64  `json:"updated_at"`
	Revision         int64  `json:"revision"`
	ClientMutationID string `json:"client_mutation_id"`
}

// ServerItem is the authoritative server version returned on a CAS conflict
// (nil when the item has no server history yet).
type ServerItem struct {
	Seq         int64  `json:"seq"`
	Ciphertext  string `json:"ciphertext"`   // base64 or "" (null)
	ContentHash string `json:"content_hash"` // hex or "" (null)
	Deleted     bool   `json:"deleted"`
	UpdatedAt   int64  `json:"updated_at"`
	Revision    int64  `json:"revision"`
}

// ChangeResponse is the 200 body. Status is "ok" (AssignedSeq valid) or
// "conflict" (ExpectedBaseSeq + Server describe the authoritative state). The
// CAS conflict is HTTP 200 by design — never an error.
type ChangeResponse struct {
	Status          string      `json:"status"`
	AssignedSeq     int64       `json:"assigned_seq"`
	ExpectedBaseSeq int64       `json:"expected_base_seq"`
	Server          *ServerItem `json:"server"`
}

// IsConflict reports a CAS rejection (caller must merge against Server).
func (r ChangeResponse) IsConflict() bool { return r.Status == "conflict" }

// PostChange pushes one mutation. A "conflict" status is returned in-band (not
// as an error); transport/auth failures still come back as errors.
func (c *Client) PostChange(ctx context.Context, vaultID string, req ChangeRequest) (ChangeResponse, error) {
	var out ChangeResponse
	path := "/v1/vaults/" + url.PathEscape(vaultID) + "/changes"
	err := c.do(ctx, http.MethodPost, path, true, req, &out)
	return out, err
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

// do executes one request: JSON-encode body (if non-nil), attach the bearer
// token (if authed), decode a 2xx JSON body into out (if non-nil), or parse the
// {"error":...} body into an *APIError on non-2xx.
func (c *Client) do(ctx context.Context, method, path string, authed bool, body, out any) error {
	var reqBody io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("cloud: marshal request: %w", err)
		}
		reqBody = bytes.NewReader(buf)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return fmt.Errorf("cloud: build request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	if authed {
		tok := c.token.Load()
		if tok == "" {
			return &APIError{Status: http.StatusUnauthorized, Message: "no session token"}
		}
		req.Header.Set("Authorization", "Bearer "+tok)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("cloud: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	// Cap the body to guard against a pathological server; 8 MiB dwarfs any
	// real auth/sync response (a 500-item snapshot page is well under 1 MiB).
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("cloud: read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		apiErr := &APIError{Status: resp.StatusCode, Message: parseErrorBody(raw)}
		// Keep the raw 403 body so the attachment layer can recover the
		// plan_limit_exceeded dimensions (limit/current/plan) that Message drops.
		if resp.StatusCode == http.StatusForbidden {
			apiErr.PlanLimitRaw = raw
		}
		return apiErr
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("cloud: decode response: %w", err)
		}
	}
	return nil
}

// parseErrorBody extracts the server's {"error":"..."} message, falling back to
// a trimmed raw body when the shape is unexpected.
func parseErrorBody(raw []byte) string {
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &e) == nil && e.Error != "" {
		return e.Error
	}
	s := strings.TrimSpace(string(raw))
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}
