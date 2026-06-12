package cloud

// Item attachments wire client (W6,对标 web_vault / Bitwarden 附件).
//
// Zero-knowledge: the file name and contents are sealed client-side with the
// vault key; this package only ever carries the already-base64-encoded
// ciphertext. The server stores the blob (DB-blob backend, <=5 MiB hard cap) or,
// in S3 mode, returns a presigned GET URL the caller must fetch separately.
//
// Wire contract verified against server/src/attachments.rs:
//   POST   /v1/vaults/{vault_id}/items/{item_id}/attachments
//          body  {file_name_enc, blob, size_bytes} (base64 ct + plaintext size)
//          200   {attachment_id, size_bytes}
//          413   blob > 5 MiB
//          403   {"error":"plan_limit_exceeded","dimension","limit","current","plan"}
//   GET    /v1/vaults/{vault_id}/items/{item_id}/attachments
//          200   {attachments:[{id, file_name_enc, size_bytes, created_at}]}
//   GET    /v1/attachments/{att_id}
//          200   {file_name_enc, blob}  (DB-blob backend)
//          200   {file_name_enc, download_url}  (S3 backend → follow-up GET)
//   DELETE /v1/attachments/{att_id}
//          200   {ok:true} / 404
//
// NOTE on auth: like every other method here, these use the client's internally
// stored bearer token (SetToken) via do(authed=true) — the desktop holds one
// shared *Client per session, so threading a token argument through every call
// would just duplicate what SetToken already does. The dossier's token-param
// signature is satisfied by the SetToken model.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// cloudStd / cloudStdDecode are the base64 STANDARD (padded) codec the server
// uses for all ciphertext fields (see client.go header). Defined here because
// the attachment methods take raw []byte while the rest of the package's
// callers pass pre-encoded strings.
func cloudStd(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func cloudStdDecode(s string) ([]byte, error) { return base64.StdEncoding.DecodeString(s) }

// readAllCapped reads up to max bytes from r, erroring if the body would exceed
// it (rather than silently truncating ciphertext into an undecryptable blob).
func readAllCapped(r io.Reader, max int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, max+1))
	if err != nil {
		return nil, fmt.Errorf("cloud: read body: %w", err)
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("cloud: body exceeds %d bytes", max)
	}
	return b, nil
}

// AttachmentMaxBytes mirrors the server's DB-blob hard cap (5 MiB). The desktop
// rejects oversize uploads locally with this same ceiling so the user sees a
// clear error before a wasted round-trip that would 413.
const AttachmentMaxBytes = 5 * 1024 * 1024

// ---------------------------------------------------------------------------
// typed errors
// ---------------------------------------------------------------------------

// PlanLimitError is the typed form of a 403 plan_limit_exceeded response. It
// carries the server's quota dimensions so the UI can tell the user exactly
// which limit was hit (for attachments the dimension is "storage_quota_mb",
// with Limit/Current in BYTES).
type PlanLimitError struct {
	Status    int    // always 403
	Dimension string // e.g. "storage_quota_mb"
	Limit     int64  // limit in the dimension's unit (storage: bytes)
	Current   int64  // current usage in the same unit
	Plan      string // the plan name that imposed the limit
}

func (e *PlanLimitError) Error() string {
	return fmt.Sprintf("cloud: plan limit exceeded: %s (limit=%d current=%d plan=%s)",
		e.Dimension, e.Limit, e.Current, e.Plan)
}

// AsPlanLimitError reports whether err is (or wraps) a *PlanLimitError, and if
// so returns it. Callers use this to roll back a local write and surface the
// quota dimensions to the user.
func AsPlanLimitError(err error) (*PlanLimitError, bool) {
	var pe *PlanLimitError
	if as(err, &pe) {
		return pe, true
	}
	return nil, false
}

// AttachmentTooLargeError is the typed form of a 413 (blob exceeds the 5 MiB
// DB-blob cap). It is distinct from PlanLimitError: 413 is a per-file ceiling,
// 403 is a tenant storage-quota ceiling.
type AttachmentTooLargeError struct {
	Status  int // always 413
	Message string
}

func (e *AttachmentTooLargeError) Error() string {
	if e.Message == "" {
		return "cloud: attachment exceeds size limit"
	}
	return "cloud: " + e.Message
}

// IsAttachmentTooLarge reports whether err is (or wraps) an
// *AttachmentTooLargeError.
func IsAttachmentTooLarge(err error) bool {
	var te *AttachmentTooLargeError
	return as(err, &te)
}

// classifyAttachmentError upgrades a generic *APIError into a typed
// PlanLimit/TooLarge error when the status/body match, so the service layer can
// branch on quota vs oversize without string-matching. Other errors pass
// through unchanged.
func classifyAttachmentError(err error) error {
	var apiErr *APIError
	if !as(err, &apiErr) {
		return err
	}
	switch apiErr.Status {
	case http.StatusForbidden:
		if pe := parsePlanLimit(apiErr); pe != nil {
			return pe
		}
	case http.StatusRequestEntityTooLarge:
		return &AttachmentTooLargeError{Status: apiErr.Status, Message: apiErr.Message}
	}
	return err
}

// parsePlanLimit re-parses the original 403 body for the plan_limit_exceeded
// fields. APIError only kept the "error" string, so we cannot recover the
// dimensions from it — but the message IS the "error" value, so we gate on it
// and, when present, return a PlanLimitError with the raw fields we did keep.
// Because APIError discards the sibling fields, do() stashes the raw body for
// 403s; see do()'s planLimitRaw handling. If the raw body is unavailable we
// still return a PlanLimitError carrying just the dimension marker so callers
// can at least branch on quota-exceeded.
func parsePlanLimit(apiErr *APIError) *PlanLimitError {
	if apiErr.Message != "plan_limit_exceeded" && apiErr.PlanLimitRaw == nil {
		return nil
	}
	pe := &PlanLimitError{Status: apiErr.Status, Dimension: "storage_quota_mb"}
	if apiErr.PlanLimitRaw != nil {
		var body struct {
			Error     string `json:"error"`
			Dimension string `json:"dimension"`
			Limit     int64  `json:"limit"`
			Current   int64  `json:"current"`
			Plan      string `json:"plan"`
		}
		if json.Unmarshal(apiErr.PlanLimitRaw, &body) == nil && body.Error == "plan_limit_exceeded" {
			pe.Dimension = body.Dimension
			pe.Limit = body.Limit
			pe.Current = body.Current
			pe.Plan = body.Plan
		} else if apiErr.Message != "plan_limit_exceeded" {
			return nil
		}
	}
	return pe
}

// ---------------------------------------------------------------------------
// request / response types
// ---------------------------------------------------------------------------

// uploadAttachmentRequest is the POST body. file_name_enc / blob are base64
// STANDARD ciphertext (sealed with the vault key by the caller). size_bytes is
// the PLAINTEXT byte length of the original file — the user-meaningful size the
// server should record and surface (the ciphertext length differs by the AEAD
// overhead, e.g. a 97-byte file seals to a 137-byte blob, and showing 137 to the
// user is wrong). Optional/back-compat: omitted (0) lets the server fall back to
// the decoded blob length.
type uploadAttachmentRequest struct {
	FileNameEnc string `json:"file_name_enc"`
	Blob        string `json:"blob"`
	SizeBytes   int64  `json:"size_bytes,omitempty"`
}

type uploadAttachmentResponse struct {
	AttachmentID string `json:"attachment_id"`
	SizeBytes    int64  `json:"size_bytes"`
}

// AttachmentMeta is one entry of the list response (no blob).
type AttachmentMeta struct {
	ID          string `json:"id"`
	FileNameEnc string `json:"file_name_enc"` // base64 STANDARD ciphertext
	SizeBytes   int64  `json:"size_bytes"`
	CreatedAt   string `json:"created_at"` // RFC3339
}

type listAttachmentsResponse struct {
	Attachments []AttachmentMeta `json:"attachments"`
}

// downloadAttachmentResponse is GET /v1/attachments/{id}. Either Blob (DB-blob
// backend) or DownloadURL (S3 backend) is set, never both.
type downloadAttachmentResponse struct {
	FileNameEnc string `json:"file_name_enc"`  // base64 STANDARD ciphertext
	Blob        string `json:"blob"`           // base64 STANDARD ciphertext, DB backend
	DownloadURL string `json:"download_url"`   // presigned GET, S3 backend
}

// ---------------------------------------------------------------------------
// methods
// ---------------------------------------------------------------------------

// UploadAttachment uploads one sealed attachment for an item and returns the
// server-assigned attachment id and stored size. fileNameEnc and blob are the
// already-sealed ciphertext bytes; they are base64-encoded on the wire here.
// A 403 quota error is returned as *PlanLimitError, a 413 as
// *AttachmentTooLargeError (use AsPlanLimitError / IsAttachmentTooLarge).
func (c *Client) UploadAttachment(ctx context.Context, vaultID, itemID string, fileNameEnc, blob []byte, plainSize int64) (attachmentID string, sizeBytes int64, err error) {
	req := uploadAttachmentRequest{
		FileNameEnc: cloudStd(fileNameEnc),
		Blob:        cloudStd(blob),
		SizeBytes:   plainSize,
	}
	var out uploadAttachmentResponse
	path := "/v1/vaults/" + url.PathEscape(vaultID) + "/items/" + url.PathEscape(itemID) + "/attachments"
	if e := c.do(ctx, http.MethodPost, path, true, req, &out); e != nil {
		return "", 0, classifyAttachmentError(e)
	}
	return out.AttachmentID, out.SizeBytes, nil
}

// ListAttachments returns the attachment metadata (no blob) for an item.
func (c *Client) ListAttachments(ctx context.Context, vaultID, itemID string) ([]AttachmentMeta, error) {
	var out listAttachmentsResponse
	path := "/v1/vaults/" + url.PathEscape(vaultID) + "/items/" + url.PathEscape(itemID) + "/attachments"
	if err := c.do(ctx, http.MethodGet, path, true, nil, &out); err != nil {
		return nil, err
	}
	return out.Attachments, nil
}

// DownloadAttachment fetches one attachment's sealed file name and contents. In
// S3 mode the first response carries a presigned download_url instead of the
// blob; this method transparently follows it with a plain GET (no auth header —
// the URL is already authorized) and returns the fetched ciphertext. The
// returned bytes are the raw (decoded) ciphertext the caller must open with the
// vault key.
func (c *Client) DownloadAttachment(ctx context.Context, attID string) (fileNameEnc, blob []byte, err error) {
	var out downloadAttachmentResponse
	path := "/v1/attachments/" + url.PathEscape(attID)
	if e := c.do(ctx, http.MethodGet, path, true, nil, &out); e != nil {
		return nil, nil, e
	}
	name, e := cloudStdDecode(out.FileNameEnc)
	if e != nil {
		return nil, nil, fmt.Errorf("cloud: decode attachment file name: %w", e)
	}
	if out.DownloadURL != "" {
		b, e := c.fetchPresigned(ctx, out.DownloadURL)
		if e != nil {
			return nil, nil, e
		}
		return name, b, nil
	}
	b, e := cloudStdDecode(out.Blob)
	if e != nil {
		return nil, nil, fmt.Errorf("cloud: decode attachment blob: %w", e)
	}
	return name, b, nil
}

// DeleteAttachment removes one attachment by id. A 404 (already gone / not a
// member) comes back as an *APIError; callers treating delete as idempotent can
// check IsStatus(err, 404).
func (c *Client) DeleteAttachment(ctx context.Context, attID string) error {
	path := "/v1/attachments/" + url.PathEscape(attID)
	return c.do(ctx, http.MethodDelete, path, true, nil, nil)
}

// fetchPresigned GETs a presigned S3 URL and returns the raw response body (the
// attachment ciphertext). No Authorization header: the signature is in the URL,
// and sending a bearer token to S3 would be rejected. The body is capped at
// AttachmentMaxBytes + a small slack for safety.
func (c *Client) fetchPresigned(ctx context.Context, rawURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("cloud: build presigned request: %w", err)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cloud: GET presigned: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &APIError{Status: resp.StatusCode, Message: "presigned GET failed"}
	}
	return readAllCapped(resp.Body, AttachmentMaxBytes+1<<16)
}
