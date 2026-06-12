package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/zerx-lab/zpass/internal/cloud"
	"github.com/zerx-lab/zpass/internal/cloudcrypto"
	"github.com/zerx-lab/zpass/internal/secretstore"
)

// CloudService is the desktop client for the ZPass zero-knowledge cloud:
// account registration / SRP-6a login (P2), and — layered on the same session —
// per-vault sync (P3, see cloudsync.go). It owns the cloud HTTP client, the OS
// credential store for the session JWT, and the in-memory session (the account
// X25519 private key and per-vault keys recovered after unlock). None of the
// secret material here is ever written to plaintext config; the JWT goes to the
// OS keychain and the private key / vault keys live only in memory for the
// duration of a signed-in session.
//
// Local master-password unlock (VaultService) and cloud sign-in are independent
// channels — per the D1 decision the user types the SAME master password into
// both, but each end derives independent key material from independent salts.
// CloudService never receives the local DEK and never hands VaultService the
// cloud keys; the two only meet at the sync transcode boundary (P3), which
// passes plaintext payloads, not keys.
//
// Locking: opMu serializes the multi-step account operations (Configure /
// Register / SignIn / SignOut) so they cannot interleave or race on the session.
// mu guards the short critical sections that read/replace session/client/baseURL.
// Slow or blocking I/O (Argon2id, network, the OS keychain) is always done
// WITHOUT holding mu.
type CloudService struct {
	vault *VaultService // for the P3 sync transcode boundary; unused by auth

	opMu sync.Mutex // serializes Configure/Register/SignIn/SignOut

	mu          sync.RWMutex
	client      *cloud.Client
	store       secretstore.Store
	baseURL     string
	session     *cloudSession
	cachedToken string // persisted JWT loaded for the current server, no live session

	emitMu sync.RWMutex
	emit   func(event string, payload any)

	// syncMu serializes whole sync runs and ApplyMerge (both touch the network +
	// sync state) so they never overlap. It is NOT held by the quick conflict
	// accessors (ListConflicts/ResolveConflict), which only need conflictsMu, so
	// a long-running sync does not block the resolver UI.
	syncMu sync.Mutex
	// conflictsMu guards the pending-conflict map for the brief map mutations.
	// Lock ordering when both are held: syncMu BEFORE conflictsMu, never reverse.
	conflictsMu sync.Mutex
	conflicts   map[string]*cloudConflict

	// loopCancel stops the background sync loop (P3); nil until started.
	loopCancel context.CancelFunc

	// nudgeMu guards the debounce timer AND the pending-scope accumulators that
	// coalesce sync triggers (local edits, SSE vault pings, resync) into one run
	// shortly after the last trigger. consumeNudge collapses the three into a
	// single (full, scope) decision.
	nudgeMu     sync.Mutex
	nudgeTimer  *time.Timer
	nudgeFull   bool             // a full reconcile was requested (resync / safety)
	nudgeAll    bool             // an incremental sync over ALL bindings (local edit)
	nudgeVaults map[string]int64 // per-vault incremental, value = max seq hint

	// realtimeCancel stops the SSE watcher goroutine; nil when not running.
	// Guarded by mu (same as loopCancel).
	realtimeCancel context.CancelFunc
	// realtimeConnected lets the poll loop stretch its interval while the
	// realtime channel is healthy (read lock-free from the ticker).
	realtimeConnected atomic.Bool
	// realtimeMu guards realtimeState (the last emitted connection state).
	realtimeMu    sync.Mutex
	realtimeState string

	// lastSyncMs is the unix-millis timestamp of the last completed runSync,
	// read lock-free by the poll loop to decide whether a tick is redundant.
	lastSyncMs atomic.Int64
	// lastFullSyncMs is the unix-millis timestamp of the last completed FULL
	// reconcile; the poll loop upgrades a tick to full once fullSyncInterval has
	// elapsed (self-heals any drift incremental state could accumulate).
	lastFullSyncMs atomic.Int64
}

// cloudSession is the live state of a signed-in account. It is replaced
// wholesale on sign-in and cleared on sign-out; callers read it under
// CloudService.mu.
type cloudSession struct {
	email     string
	accountID string
	token     string
	priv      [cloudcrypto.X25519KeySize]byte // account private key (sensitive)
	pub       [cloudcrypto.X25519KeySize]byte
	vaultKeys map[string][]byte // vault_id -> 32B vault key (sensitive); filled in P3
}

const (
	// tokenStoreService namespaces our OS-keychain items.
	tokenStoreService = "zpass-cloud"
	// minMasterPasswordLen guards against trivially weak cloud passwords; the
	// real strength comes from the password + 128-bit Secret Key together.
	minMasterPasswordLen = 8
	// keysetUploadAttempts bounds the retry of the post-register keyset upload,
	// whose failure would otherwise orphan a freshly created account.
	keysetUploadAttempts = 3
)

var (
	// ErrCloudNotConfigured is returned before a server origin is set.
	ErrCloudNotConfigured = errors.New("cloud: server not configured")
	// ErrCloudNotSignedIn is returned by session-requiring methods when no
	// account session is active.
	ErrCloudNotSignedIn = errors.New("cloud: not signed in")
	// ErrCloudServerProof means the server failed to prove knowledge of the
	// verifier (M2 mismatch) — a possible impersonation; the session is refused.
	ErrCloudServerProof = errors.New("cloud: server identity proof failed")
	// ErrCloudMFARequired means the account has a second factor enabled; the
	// MFA completion flow is not yet wired (tracked for a follow-up).
	ErrCloudMFARequired = errors.New("cloud: multi-factor authentication required")
	// ErrCloudNotMember means the current account is not a member of a bound
	// vault (server member/self 404). The sync engine skips such a binding
	// rather than failing the whole run — it is typically a stale binding from a
	// different cloud account.
	ErrCloudNotMember = errors.New("cloud: not a vault member")
	// ErrWeakMasterPassword rejects an obviously too-short master password.
	ErrWeakMasterPassword = fmt.Errorf("cloud: master password must be at least %d characters", minMasterPasswordLen)
)

var cloudB64 = base64.StdEncoding

// NewCloudService constructs the service. vault may be nil for auth-only / test
// use; it is required for P3 sync. The OS credential store is probed eagerly so
// Status() can report whether the JWT will be persisted. The server origin
// starts empty (the frontend supplies it via Configure); a ZPASS_CLOUD_BASE_URL
// env var pre-seeds it for dev/tests so a release build never silently targets
// localhost.
func NewCloudService(vault *VaultService) *CloudService {
	s := &CloudService{
		vault: vault,
		store: secretstore.New(tokenStoreService),
	}
	if env := strings.TrimSpace(os.Getenv("ZPASS_CLOUD_BASE_URL")); env != "" {
		s.baseURL = normalizeBaseURL(env)
		s.client = cloud.NewClient(s.baseURL, nil)
	}
	return s
}

// SetEventEmitter injects the SSE fan-out used for cloud:* progress events. It
// uses a dedicated lock so emits can fire from background goroutines that do not
// hold the session lock.
func (s *CloudService) SetEventEmitter(emit func(event string, payload any)) {
	s.emitMu.Lock()
	defer s.emitMu.Unlock()
	s.emit = emit
}

func (s *CloudService) emitEvent(event string, payload any) {
	s.emitMu.RLock()
	emit := s.emit
	s.emitMu.RUnlock()
	if emit != nil {
		go emit(event, payload)
	}
}

// Configure points the client at a server origin (called by the frontend on
// startup from the persisted zpass.cloud baseUrl). Changing the server clears
// any in-memory session because tokens/keys are server-scoped.
func (s *CloudService) Configure(baseURL string) error {
	baseURL = normalizeBaseURL(baseURL)
	if baseURL == "" {
		return ErrCloudNotConfigured
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()

	s.mu.Lock()
	oldBaseURL := s.baseURL
	if baseURL == oldBaseURL {
		s.mu.Unlock()
		return nil
	}
	s.baseURL = baseURL
	s.client = cloud.NewClient(baseURL, nil)
	hadSession := s.session != nil
	s.clearSessionLocked()
	s.cachedToken = ""
	s.mu.Unlock()

	// The watcher (if any) authenticated against the OLD server with a now-
	// cleared session; stop it so it does not keep reconnecting there.
	// (Outside mu: stopRealtime takes mu itself.)
	s.stopRealtime()

	if hadSession && oldBaseURL != "" {
		// Best-effort: a server switch invalidates the previous server's token.
		_ = s.store.Delete(tokenStoreKey(oldBaseURL))
		s.emitAuthChanged(false, "", "")
	}
	// Read back any persisted token for the new server so it is not write-only
	// and a future quick-unlock can reuse it (the sync loop still requires a
	// full sign-in to recover the private key before it will sync).
	s.loadPersistedToken(baseURL)
	return nil
}

// loadPersistedToken reads the keychain token for baseURL (outside mu) and, if
// it still matches the active server, installs it on the client + cachedToken.
func (s *CloudService) loadPersistedToken(baseURL string) {
	tok, ok, err := s.store.Get(tokenStoreKey(baseURL))
	if err != nil || !ok || tok == "" {
		return
	}
	s.mu.Lock()
	if s.baseURL == baseURL && s.session == nil {
		if s.client != nil {
			s.client.SetToken(tok)
		}
		s.cachedToken = tok
	}
	s.mu.Unlock()
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

// CloudStatus is the JSON-friendly account/session snapshot for the frontend.
type CloudStatus struct {
	Configured     bool   `json:"configured"`
	BaseURL        string `json:"baseUrl"`
	SignedIn       bool   `json:"signedIn"`
	Email          string `json:"email,omitempty"`
	AccountID      string `json:"accountId,omitempty"`
	StoreBackend   string `json:"storeBackend"`
	StorePersist   bool   `json:"storePersist"`
	HasCachedToken bool   `json:"hasCachedToken"`
	// Realtime is the realtime channel state: offline/connecting/connected/
	// reconnecting.
	Realtime string `json:"realtime"`
}

// Status reports the current configuration and session state.
func (s *CloudService) Status() CloudStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st := CloudStatus{
		Configured:     s.baseURL != "",
		BaseURL:        s.baseURL,
		StoreBackend:   s.store.Name(),
		StorePersist:   s.store.Available(),
		HasCachedToken: s.cachedToken != "",
		Realtime:       s.realtimeStateNow(),
	}
	if s.session != nil {
		st.SignedIn = true
		st.Email = s.session.email
		st.AccountID = s.session.accountID
	}
	return st
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

// RegisterResult is returned to the UI after a successful registration. The
// SecretKey is the ONLY copy and must be shown to the user to record; it is not
// recoverable from the server.
type RegisterResult struct {
	Email     string `json:"email"`
	AccountID string `json:"accountId"`
	SecretKey string `json:"secretKey"`
	SignedIn  bool   `json:"signedIn"`
}

// Register creates a new cloud account: it generates the Secret Key, derives the
// SRP verifier and AUK locally, uploads only the zero-knowledge material
// (srp_salt / srp_verifier / kdf_params + the AUK-wrapped X25519 keyset), and
// establishes a signed-in session. The master password and Secret Key never
// leave the device.
func (s *CloudService) Register(email, masterPassword string) (RegisterResult, error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()

	email = normalizeEmail(email)
	if email == "" {
		return RegisterResult{}, errors.New("cloud: email is required")
	}
	if len([]rune(strings.TrimSpace(masterPassword))) < minMasterPasswordLen {
		return RegisterResult{}, ErrWeakMasterPassword
	}

	baseURL, err := s.currentBaseURL()
	if err != nil {
		return RegisterResult{}, err
	}
	flow := cloud.NewClient(baseURL, nil)

	accountID, err := cloudcrypto.GenerateAccountID()
	if err != nil {
		return RegisterResult{}, err
	}
	secretKey, err := cloudcrypto.GenerateSecretKey(accountID)
	if err != nil {
		return RegisterResult{}, err
	}
	_, skCanonical, err := cloudcrypto.ParseSecretKey(secretKey)
	if err != nil {
		return RegisterResult{}, err
	}
	defer zeroBytes(skCanonical)
	accIDBytes := []byte(accountID)

	saltEnc, err := random32()
	if err != nil {
		return RegisterResult{}, err
	}
	saltAuth, err := random32()
	if err != nil {
		return RegisterResult{}, err
	}
	params := cloudcrypto.ProductionArgon2()

	auk, err := cloudcrypto.DeriveAUK(masterPassword, saltEnc, skCanonical, accIDBytes, params)
	if err != nil {
		return RegisterResult{}, err
	}
	defer zero32(&auk)
	srpx, err := cloudcrypto.DeriveSRPx(masterPassword, saltAuth, skCanonical, accIDBytes, params)
	if err != nil {
		return RegisterResult{}, err
	}
	defer zero32(&srpx)
	reg, err := cloudcrypto.SrpRegister(srpx[:], saltAuth)
	if err != nil {
		return RegisterResult{}, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*cloud.DefaultTimeout)
	defer cancel()

	resp, err := flow.Register(ctx, cloud.RegisterRequest{
		Email:       email,
		SrpSalt:     cloudB64.EncodeToString(saltAuth),
		SrpVerifier: cloudB64.EncodeToString(reg.Verifier),
		KdfParams:   kdfParams(saltEnc, params),
	})
	if err != nil {
		return RegisterResult{}, err
	}
	flow.SetToken(resp.SessionToken)

	// Generate the account keyset and upload the AUK-wrapped private key. This
	// upload MUST land: without it the account has no recoverable private key.
	// We retry; if it ultimately fails the account is orphaned, but SignIn's
	// 404-keyset recovery path can re-provision it (no vaults exist yet).
	pub, priv, err := cloudcrypto.KeysetGenerate()
	if err != nil {
		return RegisterResult{}, err
	}
	encPriv, err := cloudcrypto.SealKeysetPrivateKey(auk[:], priv[:])
	if err != nil {
		return RegisterResult{}, err
	}
	if err := putKeysetWithRetry(ctx, flow, pub[:], encPriv); err != nil {
		return RegisterResult{}, fmt.Errorf("cloud: upload keyset (account created; sign in again to finish setup): %w", err)
	}

	s.establishSession(email, accountID, resp.SessionToken, secretKey, masterPassword, priv, pub)

	return RegisterResult{
		Email:     email,
		AccountID: accountID,
		SecretKey: secretKey,
		SignedIn:  true,
	}, nil
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

// AccountResult is the post-sign-in account identity for the UI.
type AccountResult struct {
	Email     string `json:"email"`
	AccountID string `json:"accountId"`
	SignedIn  bool   `json:"signedIn"`
}

// SignIn runs the SRP-6a handshake (deriving SRP-x from the master password +
// Secret Key), verifies the server's M2 proof, then recovers the account
// private key by unwrapping the server-stored keyset with the locally derived
// AUK. On success the session is established and the JWT persisted to the OS
// keychain. A wrong password or Secret Key surfaces as a credentials error
// (the server's M1 check, or the AUK keyset-unwrap auth failure).
//
// The whole flow runs on a throwaway client; the shared client's token is only
// updated once a complete, verified session is in hand, so a mid-flow failure
// never leaves a dangling token on the sync client.
func (s *CloudService) SignIn(email, masterPassword, secretKey string) (AccountResult, error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	return s.signInLocked(email, masterPassword, secretKey)
}

// RestoreSession silently rebuilds the cloud session at local vault unlock using
// the master password the user just typed plus the email + Secret Key persisted
// at the last sign-in. It is the mechanism behind "stay signed in": the account
// private key is never stored (zero-knowledge), so each launch must re-derive it
// — but the user only types the master password once (at unlock), not the full
// credential set. It is a no-op (SignedIn:false, no error) when nothing is
// configured or no credentials were stored, so callers can fire it on every
// unlock unconditionally. A non-nil error means the stored credentials did not
// match the typed master password (e.g. a divergent cloud password); callers
// should treat that as "not restored" rather than a fatal unlock failure.
func (s *CloudService) RestoreSession(masterPassword string) (AccountResult, error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()

	s.mu.RLock()
	baseURL := s.baseURL
	sess := s.session
	s.mu.RUnlock()
	if baseURL == "" {
		return AccountResult{SignedIn: false}, nil
	}
	if sess != nil {
		// Already live this run — nothing to do.
		return AccountResult{Email: sess.email, AccountID: sess.accountID, SignedIn: true}, nil
	}

	email, okE, _ := s.store.Get(credStoreKey("email-", baseURL))
	secretKey, okS, _ := s.store.Get(credStoreKey("sk-", baseURL))
	if !okE || !okS || email == "" || secretKey == "" {
		// No stored credentials → cannot auto-restore; not an error.
		return AccountResult{SignedIn: false}, nil
	}

	// Prefer the DEK-wrapped cloud password (handles local-unlock-password !=
	// cloud-password). It can only be decrypted now because the local vault was
	// just unlocked. Fall back to the typed master password for legacy logins
	// that predate password persistence, or same-password setups.
	cloudPassword := masterPassword
	if blob, ok, _ := s.store.Get(credStoreKey("pw-", baseURL)); ok && blob != "" && s.vault != nil && s.vault.IsUnlocked() {
		if ct, decErr := cloudB64.DecodeString(blob); decErr == nil {
			if pw, openErr := s.vault.OpenCloudCredential(ct); openErr == nil {
				cloudPassword = string(pw)
			}
		}
	}
	return s.signInLocked(email, cloudPassword, secretKey)
}

func (s *CloudService) signInLocked(email, masterPassword, secretKey string) (AccountResult, error) {
	email = normalizeEmail(email)
	if email == "" {
		return AccountResult{}, errors.New("cloud: email is required")
	}
	accountID, skCanonical, err := cloudcrypto.ParseSecretKey(strings.TrimSpace(secretKey))
	if err != nil {
		return AccountResult{}, err
	}
	defer zeroBytes(skCanonical)
	accIDBytes := []byte(accountID)

	baseURL, err := s.currentBaseURL()
	if err != nil {
		return AccountResult{}, err
	}
	flow := cloud.NewClient(baseURL, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 3*cloud.DefaultTimeout)
	defer cancel()

	start, err := cloudcrypto.NewSrpClientStart()
	if err != nil {
		return AccountResult{}, err
	}
	defer zeroBytes(start.SecretA)
	startResp, err := flow.LoginStart(ctx, cloud.LoginStartRequest{
		Email: email,
		APub:  cloudB64.EncodeToString(start.APub),
	})
	if err != nil {
		return AccountResult{}, err
	}

	saltAuth, err := cloudB64.DecodeString(startResp.SrpSalt)
	if err != nil {
		return AccountResult{}, fmt.Errorf("cloud: decode srp_salt: %w", err)
	}
	saltEnc, err := cloudB64.DecodeString(startResp.KdfParams.SaltEnc)
	if err != nil {
		return AccountResult{}, fmt.Errorf("cloud: decode salt_enc: %w", err)
	}
	bPub, err := cloudB64.DecodeString(startResp.BPub)
	if err != nil {
		return AccountResult{}, fmt.Errorf("cloud: decode B: %w", err)
	}
	params := argonFromKdf(startResp.KdfParams)

	srpx, err := cloudcrypto.DeriveSRPx(masterPassword, saltAuth, skCanonical, accIDBytes, params)
	if err != nil {
		return AccountResult{}, err
	}
	defer zero32(&srpx)
	identity := []byte(strings.ToLower(email))
	proof, err := cloudcrypto.SrpClientFinish(start.SecretA, start.APub, bPub, srpx[:], saltAuth, identity)
	if err != nil {
		return AccountResult{}, err
	}
	defer zero32(&proof.SessionKey)

	finResp, err := flow.LoginFinish(ctx, cloud.LoginFinishRequest{
		LoginID: startResp.LoginID,
		M1:      cloudB64.EncodeToString(proof.M1[:]),
	})
	if err != nil {
		return AccountResult{}, err
	}

	// Verify the server's M2 confirmation FIRST — this is the mutual-auth half of
	// SRP and must run even on the MFA path (the server returns M2 alongside
	// mfa_required), so an impersonating server is rejected before we surface an
	// MFA prompt or trust anything it sent.
	m2, err := cloudB64.DecodeString(finResp.M2)
	if err != nil {
		return AccountResult{}, fmt.Errorf("cloud: decode M2: %w", err)
	}
	if !proof.VerifyServerM2(start.APub, m2) {
		return AccountResult{}, ErrCloudServerProof
	}
	if finResp.MfaRequired {
		return AccountResult{}, ErrCloudMFARequired
	}
	if finResp.SessionToken == "" {
		return AccountResult{}, errors.New("cloud: server returned no session token")
	}
	flow.SetToken(finResp.SessionToken)

	// Recover the account private key: derive AUK and unwrap the keyset. A wrong
	// master password yields a wrong AUK and an AEAD auth failure here.
	auk, err := cloudcrypto.DeriveAUK(masterPassword, saltEnc, skCanonical, accIDBytes, params)
	if err != nil {
		return AccountResult{}, err
	}
	defer zero32(&auk)

	priv, pub, err := s.recoverOrProvisionKeyset(ctx, flow, auk)
	if err != nil {
		return AccountResult{}, err
	}

	s.establishSession(email, accountID, finResp.SessionToken, strings.TrimSpace(secretKey), masterPassword, priv, pub)

	return AccountResult{Email: email, AccountID: accountID, SignedIn: true}, nil
}

// recoverOrProvisionKeyset fetches and unwraps the account keyset. If the server
// has no keyset (404 — a register that failed mid-keyset-upload), it provisions
// a fresh one; this is safe because such an account can have no vaults yet (no
// vault key was ever wrapped to the lost public key).
func (s *CloudService) recoverOrProvisionKeyset(ctx context.Context, flow *cloud.Client, auk [cloudcrypto.KeySize]byte) (priv, pub [cloudcrypto.X25519KeySize]byte, err error) {
	ks, getErr := flow.GetKeyset(ctx)
	if cloud.IsStatus(getErr, 404) {
		var np, nb [cloudcrypto.X25519KeySize]byte
		nb, np, err = cloudcrypto.KeysetGenerate() // (pub, priv)
		if err != nil {
			return priv, pub, err
		}
		encPriv, sealErr := cloudcrypto.SealKeysetPrivateKey(auk[:], np[:])
		if sealErr != nil {
			return priv, pub, sealErr
		}
		if err = putKeysetWithRetry(ctx, flow, nb[:], encPriv); err != nil {
			return priv, pub, fmt.Errorf("cloud: provision keyset: %w", err)
		}
		return np, nb, nil
	}
	if getErr != nil {
		return priv, pub, fmt.Errorf("cloud: fetch keyset: %w", getErr)
	}

	encPriv, err := cloudB64.DecodeString(ks.EncryptedPrivateKey)
	if err != nil {
		return priv, pub, fmt.Errorf("cloud: decode encrypted_private_key: %w", err)
	}
	privBytes, err := cloudcrypto.OpenKeysetPrivateKey(auk[:], encPriv)
	if err != nil {
		return priv, pub, fmt.Errorf("cloud: unwrap keyset (wrong master password or Secret Key?): %w", err)
	}
	defer zeroBytes(privBytes)
	pubBytes, err := cloudB64.DecodeString(ks.PublicKey)
	if err != nil || len(pubBytes) != cloudcrypto.X25519KeySize || len(privBytes) != cloudcrypto.X25519KeySize {
		return priv, pub, errors.New("cloud: malformed keyset")
	}
	copy(priv[:], privBytes)
	copy(pub[:], pubBytes)
	return priv, pub, nil
}

// ---------------------------------------------------------------------------
// Sign out / shutdown
// ---------------------------------------------------------------------------

// SignOut is the explicit user action: clear the in-memory session AND delete
// the persisted JWT, so the next launch starts signed-out.
func (s *CloudService) SignOut() error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.mu.RLock()
	baseURL := s.baseURL
	s.mu.RUnlock()
	s.teardownSession()
	// Outside mu: keychain calls can block on a prompt. Drop the JWT AND the
	// auto-unlock credentials so the next launch starts fully signed-out.
	_ = s.store.Delete(tokenStoreKey(baseURL))
	_ = s.store.Delete(credStoreKey("email-", baseURL))
	_ = s.store.Delete(credStoreKey("sk-", baseURL))
	_ = s.store.Delete(credStoreKey("pw-", baseURL))
	s.emitAuthChanged(false, "", "")
	return nil
}

// Stop tears the session down for process shutdown WITHOUT deleting the
// persisted token (so a future launch can offer a quick unlock). It also stops
// the background sync loop. It does not emit an auth-changed event — the process
// is going away.
func (s *CloudService) Stop() error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.mu.Lock()
	if s.loopCancel != nil {
		s.loopCancel()
		s.loopCancel = nil
	}
	s.mu.Unlock()
	s.teardownSession()
	return nil
}

// teardownSession clears the client token and wipes the in-memory session. It
// leaves the background loop running (the loop is process-scoped and simply
// no-ops while signed out). Caller holds opMu; mu is taken internally. No
// keychain I/O.
func (s *CloudService) teardownSession() {
	// Stop the SSE watcher first: the session it authenticated with is going
	// away (sign-out / server switch), so keeping the stream open would only
	// reconnect with a dead token.
	s.stopRealtime()

	s.nudgeMu.Lock()
	if s.nudgeTimer != nil {
		s.nudgeTimer.Stop()
		s.nudgeTimer = nil
	}
	s.nudgeMu.Unlock()

	s.mu.Lock()
	if s.client != nil {
		s.client.SetToken("")
	}
	s.clearSessionLocked()
	s.cachedToken = ""
	s.mu.Unlock()

	// Drop any retained conflict cleartext + stale entries from this session so
	// they cannot leak into the next sign-in.
	s.conflictsMu.Lock()
	s.conflicts = nil
	s.conflictsMu.Unlock()
}

// ---------------------------------------------------------------------------
// session helpers
// ---------------------------------------------------------------------------

// tokenStoreKey derives the keychain slot for a server's session JWT. Keying it
// by the server origin keeps tokens for different servers from colliding under
// the single "zpass-cloud" service namespace.
func tokenStoreKey(baseURL string) string {
	if baseURL == "" {
		return "session-token"
	}
	sum := sha256.Sum256([]byte(baseURL))
	return "session-token-" + hex.EncodeToString(sum[:6])
}

// credStoreKey derives a per-server keychain slot for an auto-unlock credential
// (the account email and Secret Key), so RestoreSession can silently re-derive
// the account private key at local unlock without prompting for them again. Like
// tokenStoreKey it is namespaced by the server origin. The Secret Key is the
// "something you have" factor and is deliberately kept on-device (mirrors
// 1Password); it alone cannot unlock anything without the master password.
func credStoreKey(prefix, baseURL string) string {
	if baseURL == "" {
		return prefix + "default"
	}
	sum := sha256.Sum256([]byte(baseURL))
	return prefix + hex.EncodeToString(sum[:6])
}

// establishSession installs a fresh session (under mu, also setting the token on
// the shared sync client) and then persists the token + auto-unlock credentials
// to the keychain OUTSIDE the lock (keychain ops can block on a prompt). Caller
// holds opMu. secretKey is the canonical Secret Key string; cloudPassword is the
// cloud account master password. Both are stored so RestoreSession can rebuild
// the session at local unlock — the cloud password is DEK-wrapped (decryptable
// only after a local vault unlock) so it works even when the local unlock
// password differs from the cloud password (the D1 "same password" assumption
// does not always hold).
func (s *CloudService) establishSession(email, accountID, token, secretKey, cloudPassword string, priv, pub [cloudcrypto.X25519KeySize]byte) {
	s.mu.Lock()
	s.clearSessionLocked()
	s.session = &cloudSession{
		email:     email,
		accountID: accountID,
		token:     token,
		priv:      priv,
		pub:       pub,
		vaultKeys: make(map[string][]byte),
	}
	if s.client != nil {
		s.client.SetToken(token)
	}
	s.cachedToken = token
	persist := s.store.Available()
	baseURL := s.baseURL
	key := tokenStoreKey(baseURL)
	s.mu.Unlock()

	if persist {
		if err := s.store.Set(key, token); err != nil {
			// Non-fatal: the session still works in-memory this run; we just
			// won't have a persisted token next launch.
			s.emitEvent("cloud:auth:store-warning", map[string]any{"message": err.Error()})
		}
		// Persist the auto-unlock credentials (email + Secret Key). Best-effort:
		// a failure only means the next launch falls back to a manual sign-in.
		if secretKey != "" {
			_ = s.store.Set(credStoreKey("email-", baseURL), email)
			_ = s.store.Set(credStoreKey("sk-", baseURL), secretKey)
		}
		// DEK-wrap the cloud master password and persist it, so RestoreSession can
		// sign in at unlock even when the local unlock password differs from the
		// cloud password. Requires the local vault to be unlocked NOW (it is — the
		// user signs into cloud from inside the unlocked app). If it is locked or
		// wrapping fails, we simply skip it (auto-restore then needs matching
		// passwords or a manual sign-in).
		if cloudPassword != "" && s.vault != nil && s.vault.IsUnlocked() {
			if ct, err := s.vault.SealCloudCredential([]byte(cloudPassword)); err == nil {
				_ = s.store.Set(credStoreKey("pw-", baseURL), cloudB64.EncodeToString(ct))
			} else {
				s.emitEvent("cloud:auth:store-warning", map[string]any{"message": "seal cloud credential: " + err.Error()})
			}
		}
	}
	s.emitAuthChanged(true, email, accountID)
	// Sync immediately on sign-in so the user sees their cloud data without
	// waiting for the periodic tick (the push half is driven by NudgeSync).
	s.kickSync()
	// And open the realtime channel so remote changes land without waiting
	// for the next poll tick.
	s.startRealtime()
}

// emitAuthChanged broadcasts the signed-in/out transition for the frontend.
func (s *CloudService) emitAuthChanged(signedIn bool, email, accountID string) {
	s.emitEvent("cloud:auth:changed", map[string]any{
		"signedIn":  signedIn,
		"email":     email,
		"accountId": accountID,
		"updatedAt": time.Now().UnixMilli(),
	})
}

// handleSessionRevoked reacts to a server 401 (the session JWT expired OR was
// revoked by an admin "sign out all devices"). It drops the in-memory session
// and cached token so Status().SignedIn flips to false immediately — closing
// the "looks signed in but every sync 401s" gap — and tells the UI to require a
// re-sign-in.
//
// It deliberately does NOT silently re-login: a revoked session would just be
// resurrected, defeating the admin action. It also does NOT delete the stored
// email / Secret Key / wrapped password — those make the re-sign-in one-click
// (the user does not have to re-enter their Secret Key). It is idempotent:
// concurrent 401s from several vault syncs collapse to a single teardown +
// event because teardownSession on an already-cleared session is a no-op and
// the emit is gated on there having been a live session.
//
// Safe to call from a sync goroutine: it does NOT take opMu (which Register /
// SignIn / SignOut hold), only the short mu critical sections inside
// teardownSession, so it cannot deadlock against an in-flight sync holding
// syncMu.
func (s *CloudService) handleSessionRevoked() {
	s.mu.RLock()
	hadSession := s.session != nil
	email := ""
	if s.session != nil {
		email = s.session.email
	}
	s.mu.RUnlock()
	if !hadSession {
		return // already torn down by a racing 401 — emit once
	}

	s.teardownSession()
	// Drop the persisted JWT so the next launch does not present a dead token
	// (and the quick-unlock path re-derives a fresh session via stored creds).
	// Keep email / Secret Key / wrapped password for the one-click re-sign-in.
	s.mu.RLock()
	baseURL := s.baseURL
	s.mu.RUnlock()
	_ = s.store.Delete(tokenStoreKey(baseURL))

	// signedIn=false flips the UI out of the synced state immediately.
	s.emitAuthChanged(false, "", "")
	// A distinct signal lets the UI explain "you were signed out remotely" and
	// offer a one-click re-sign-in, rather than a generic sync error.
	s.emitEvent("cloud:auth:revoked", map[string]any{
		"email": email, "updatedAt": nowMillis(),
	})
}

// clearSessionLocked wipes and drops the session. Caller holds s.mu.
func (s *CloudService) clearSessionLocked() {
	if s.session == nil {
		return
	}
	zero32(&s.session.priv)
	for _, vk := range s.session.vaultKeys {
		zeroBytes(vk)
	}
	s.session = nil
}

// currentBaseURL returns the configured origin or ErrCloudNotConfigured.
func (s *CloudService) currentBaseURL() (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.baseURL == "" {
		return "", ErrCloudNotConfigured
	}
	return s.baseURL, nil
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

// putKeysetWithRetry uploads the keyset, retrying transient failures so a flaky
// network does not orphan a just-created account.
func putKeysetWithRetry(ctx context.Context, c *cloud.Client, pub, encPriv []byte) error {
	req := cloud.KeysetRequest{
		PublicKey:           cloudB64.EncodeToString(pub),
		EncryptedPrivateKey: cloudB64.EncodeToString(encPriv),
		Algo:                "x25519",
	}
	var err error
	for attempt := 0; attempt < keysetUploadAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt) * 500 * time.Millisecond):
			}
		}
		if err = c.PutKeyset(ctx, req); err == nil {
			return nil
		}
	}
	return err
}

func random32() ([]byte, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return nil, fmt.Errorf("cloud: rng: %w", err)
	}
	return b, nil
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// normalizeBaseURL trims whitespace and a trailing slash so the same-origin
// no-op guard in Configure is not defeated by a stray "/".
func normalizeBaseURL(u string) string {
	return strings.TrimRight(strings.TrimSpace(u), "/")
}

func zeroBytes(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

func zero32(a *[cloudcrypto.KeySize]byte) {
	for i := range a {
		a[i] = 0
	}
}

// kdfParams builds the wire kdf_params from the salt and Argon2 cost.
func kdfParams(saltEnc []byte, p cloudcrypto.Argon2Params) cloud.KdfParams {
	return cloud.KdfParams{
		Alg:       "argon2id",
		M:         p.MemKiB,
		T:         p.Iterations,
		P:         p.Parallelism,
		SaltEnc:   cloudB64.EncodeToString(saltEnc),
		SkVersion: "Z1",
	}
}

// argonFromKdf reads the Argon2 cost from server-returned kdf_params, falling
// back to the production default if the server omitted/zeroed a field.
func argonFromKdf(k cloud.KdfParams) cloudcrypto.Argon2Params {
	def := cloudcrypto.ProductionArgon2()
	p := cloudcrypto.Argon2Params{MemKiB: k.M, Iterations: k.T, Parallelism: k.P}
	if p.MemKiB == 0 {
		p.MemKiB = def.MemKiB
	}
	if p.Iterations == 0 {
		p.Iterations = def.Iterations
	}
	if p.Parallelism == 0 {
		p.Parallelism = def.Parallelism
	}
	return p
}
