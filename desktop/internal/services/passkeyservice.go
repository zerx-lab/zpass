package services

// Passkey core service.
//
// This file implements the part of a 1Password-style passkey feature that can
// live safely inside the desktop vault process on every platform:
//   - generate WebAuthn ES256 credentials
//   - store the private key inside the existing encrypted vault item payload
//   - return registration material for a bridge/browser integration
//   - sign WebAuthn assertions without exporting the private key
//
// A production "use passkeys in the browser" experience still needs a browser
// extension, native messaging bridge, or OS credential-provider integration
// (Windows WebAuthn provider, macOS/iCloud Keychain extension points, etc.).
// Those surfaces are platform-specific and outside Wails' normal app sandbox;
// they should call the methods below rather than duplicating key storage.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net"
	"strconv"
	"strings"
)

const (
	passkeySchemaVersion = "zpass-passkey-v1"
	passkeyAlgES256      = "ES256"
	passkeyCOSEAlgES256  = -7

	passkeyFlagUserPresent    byte = 0x01
	passkeyFlagUserVerified   byte = 0x04
	passkeyFlagAttestedData   byte = 0x40
	passkeyCredentialIDLength      = 32
	passkeyGeneratedUserIDLen      = 32
)

var (
	// ErrPasskeyNotFound deliberately covers "credential exists but RP ID does
	// not match" as well as "credential ID does not exist". WebAuthn authenticators
	// should not reveal cross-RP credential presence.
	ErrPasskeyNotFound = errors.New("passkey credential not found")
)

// PasskeyRegistrationRequest is the input for creating a new vault-backed
// passkey credential.
//
// UserID accepts either base64url bytes or a plain UTF-8 handle. If empty, a
// 32-byte random user handle is generated.
type PasskeyRegistrationRequest struct {
	RPID            string `json:"rpId"`
	RPName          string `json:"rpName"`
	UserID          string `json:"userId"`
	UserName        string `json:"userName"`
	UserDisplayName string `json:"userDisplayName"`
	Name            string `json:"name"`
}

// PasskeyCredential is the public, non-secret view of a stored credential.
//
// Private key material is intentionally omitted. The only API that uses the
// private key is SignPasskeyAssertion, which returns a WebAuthn signature.
type PasskeyCredential struct {
	ItemID            string   `json:"itemId"`
	Name              string   `json:"name"`
	RPID              string   `json:"rpId"`
	RPName            string   `json:"rpName"`
	UserID            string   `json:"userId"`
	UserName          string   `json:"userName"`
	UserDisplayName   string   `json:"userDisplayName"`
	CredentialID      string   `json:"credentialId"`
	PublicKeyCOSE     string   `json:"publicKeyCose"`
	PublicKeySPKI     string   `json:"publicKeySpki"`
	Algorithm         string   `json:"algorithm"`
	COSEAlgorithm     int      `json:"coseAlgorithm"`
	SignCount         uint32   `json:"signCount"`
	Transports        []string `json:"transports"`
	AuthenticatorData string   `json:"authenticatorData,omitempty"`
	AttestationObject string   `json:"attestationObject,omitempty"`
	CreatedAt         int64    `json:"createdAt"`
	UpdatedAt         int64    `json:"updatedAt"`
}

// PasskeyCredentialDescriptor is the list/search view used by an autofill
// bridge to choose an existing passkey for a relying party.
type PasskeyCredentialDescriptor struct {
	ItemID          string   `json:"itemId"`
	Name            string   `json:"name"`
	RPID            string   `json:"rpId"`
	RPName          string   `json:"rpName"`
	UserID          string   `json:"userId"`
	UserName        string   `json:"userName"`
	UserDisplayName string   `json:"userDisplayName"`
	CredentialID    string   `json:"credentialId"`
	Transports      []string `json:"transports"`
	SignCount       uint32   `json:"signCount"`
	CreatedAt       int64    `json:"createdAt"`
	UpdatedAt       int64    `json:"updatedAt"`
}

// PasskeyAssertionRequest asks the vault to produce a WebAuthn assertion.
//
// ClientDataHash is the base64url-encoded SHA-256 hash of clientDataJSON as
// specified by WebAuthn/CTAP. The raw clientDataJSON stays in the caller.
type PasskeyAssertionRequest struct {
	RPID           string `json:"rpId"`
	CredentialID   string `json:"credentialId"`
	ClientDataHash string `json:"clientDataHash"`
}

// PasskeyAssertionResponse contains the authenticator output for WebAuthn
// navigator.credentials.get().
type PasskeyAssertionResponse struct {
	ItemID            string `json:"itemId"`
	CredentialID      string `json:"credentialId"`
	UserID            string `json:"userId"`
	AuthenticatorData string `json:"authenticatorData"`
	Signature         string `json:"signature"`
	SignCount         uint32 `json:"signCount"`
}

// CreatePasskey generates a new ES256 WebAuthn credential and stores it as an
// encrypted vault item. It returns public registration material plus a
// fmt="none" attestation object; private key bytes never leave the Go process.
func (s *VaultService) CreatePasskey(req PasskeyRegistrationRequest) (*PasskeyCredential, error) {
	rpID, err := normalizeRPID(req.RPID)
	if err != nil {
		return nil, err
	}
	userIDBytes, err := decodeOrCreateUserID(req.UserID)
	if err != nil {
		return nil, err
	}

	userName := strings.TrimSpace(req.UserName)
	userDisplayName := strings.TrimSpace(req.UserDisplayName)
	rpName := strings.TrimSpace(req.RPName)
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = defaultPasskeyName(rpName, rpID, userName, userDisplayName)
	}

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate passkey keypair: %w", err)
	}

	credentialID := make([]byte, passkeyCredentialIDLength)
	if _, err := rand.Read(credentialID); err != nil {
		return nil, fmt.Errorf("generate credential id: %w", err)
	}

	privateDER, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, fmt.Errorf("marshal passkey private key: %w", err)
	}
	defer WipeBytes(privateDER)

	publicDER, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("marshal passkey public key: %w", err)
	}
	publicCOSE, err := coseKeyES256(&priv.PublicKey)
	if err != nil {
		return nil, err
	}

	authData := passkeyRegistrationAuthData(rpID, credentialID, publicCOSE)
	attObj := passkeyAttestationObject(authData)

	fields := map[string]any{
		"schema":            passkeySchemaVersion,
		"rpId":              rpID,
		"rpName":            rpName,
		"userId":            b64url(userIDBytes),
		"userName":          userName,
		"userDisplayName":   userDisplayName,
		"credentialId":      b64url(credentialID),
		"publicKeyCose":     b64url(publicCOSE),
		"publicKeySpki":     b64url(publicDER),
		"privateKeyPkcs8":   b64url(privateDER),
		"algorithm":         passkeyAlgES256,
		"coseAlgorithm":     passkeyCOSEAlgES256,
		"signCount":         0,
		"transports":        []string{"internal"},
		"createdBy":         "zpass-desktop",
		"userVerification":  true,
		"residentKey":       true,
		"attestationFormat": "none",
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.dek == nil {
		return nil, ErrVaultLocked
	}

	id, err := newItemID()
	if err != nil {
		return nil, fmt.Errorf("gen item id: %w", err)
	}
	now := s.nowMs()
	payload := &ItemPayload{
		ID:        id,
		Type:      ItemTypePasskey,
		Name:      name,
		Fields:    fields,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := s.insertEncryptedItemLocked(payload); err != nil {
		return nil, err
	}

	cred, err := passkeyCredentialFromPayload(payload)
	if err != nil {
		return nil, err
	}
	cred.AuthenticatorData = b64url(authData)
	cred.AttestationObject = b64url(attObj)
	s.notifyVaultChanged("create", ItemTypePasskey, payload.ID)
	return cred, nil
}

// ListPasskeys returns passkey descriptors for a relying party. rpID is
// required to keep enumeration scoped the same way a WebAuthn authenticator is.
func (s *VaultService) ListPasskeys(rpID string) ([]PasskeyCredentialDescriptor, error) {
	normalizedRPID, err := normalizeRPID(rpID)
	if err != nil {
		return nil, err
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.dek == nil {
		return nil, ErrVaultLocked
	}
	// 空间隔离：只枚举当前激活空间的 passkey（与 WebAuthn authenticator 的
	// 枚举边界对齐）。未选择空间 → 空结果，不泄露任何 orphan。
	if s.currentSpaceID == "" {
		return []PasskeyCredentialDescriptor{}, nil
	}

	rows, err := s.db.ListItemsBySpace(s.currentSpaceID)
	if err != nil {
		return nil, fmt.Errorf("list items: %w", err)
	}

	out := make([]PasskeyCredentialDescriptor, 0)
	for i := range rows {
		payload, err := s.decryptItem(&rows[i])
		if err != nil {
			fmt.Printf("[passkey] decrypt item %s failed: %v\n", rows[i].ID, err)
			continue
		}
		payload.CreatedAt = rows[i].CreatedAt
		payload.UpdatedAt = rows[i].UpdatedAt
		if payload.Type != ItemTypePasskey {
			continue
		}
		if fieldString(payload.Fields, "rpId") != normalizedRPID {
			continue
		}
		desc, err := passkeyDescriptorFromPayload(payload)
		if err != nil {
			fmt.Printf("[passkey] parse item %s failed: %v\n", rows[i].ID, err)
			continue
		}
		out = append(out, *desc)
	}
	return out, nil
}

// GetPasskey returns a single public passkey view by vault item ID.
func (s *VaultService) GetPasskey(itemID string) (*PasskeyCredential, error) {
	if strings.TrimSpace(itemID) == "" {
		return nil, errors.New("item id cannot be empty")
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.dek == nil {
		return nil, ErrVaultLocked
	}

	row, err := s.db.GetItem(itemID)
	if err != nil {
		return nil, fmt.Errorf("get passkey item: %w", err)
	}
	if row == nil {
		return nil, ErrPasskeyNotFound
	}
	// 空间隔离：跨空间的 passkey 视作未找到。
	if s.currentSpaceID == "" || row.SpaceID != s.currentSpaceID {
		return nil, ErrPasskeyNotFound
	}
	payload, err := s.decryptItem(row)
	if err != nil {
		return nil, fmt.Errorf("decrypt passkey item: %w", err)
	}
	payload.CreatedAt = row.CreatedAt
	payload.UpdatedAt = row.UpdatedAt
	if payload.Type != ItemTypePasskey {
		return nil, ErrPasskeyNotFound
	}
	return passkeyCredentialFromPayload(payload)
}

// SignPasskeyAssertion signs authenticatorData || clientDataHash for an
// existing passkey credential, advances signCount, and persists the new count.
func (s *VaultService) SignPasskeyAssertion(req PasskeyAssertionRequest) (*PasskeyAssertionResponse, error) {
	rpID, err := normalizeRPID(req.RPID)
	if err != nil {
		return nil, err
	}
	credentialID, credentialIDText, err := decodeCredentialID(req.CredentialID)
	if err != nil {
		return nil, err
	}
	clientDataHash, err := decodeBase64URLStrict(req.ClientDataHash, "clientDataHash")
	if err != nil {
		return nil, err
	}
	if len(clientDataHash) != sha256.Size {
		return nil, fmt.Errorf("clientDataHash must be %d bytes, got %d", sha256.Size, len(clientDataHash))
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.dek == nil {
		return nil, ErrVaultLocked
	}

	row, payload, err := s.findPasskeyLocked(rpID, credentialIDText)
	if err != nil {
		return nil, err
	}
	privateKey, err := privateKeyFromPasskeyFields(payload.Fields)
	if err != nil {
		return nil, err
	}

	prevCount, err := fieldUint32(payload.Fields, "signCount")
	if err != nil {
		return nil, err
	}
	if prevCount == math.MaxUint32 {
		return nil, errors.New("passkey signCount exhausted")
	}
	nextCount := prevCount + 1
	authData := passkeyAssertionAuthData(rpID, nextCount)
	signatureBase := make([]byte, 0, len(authData)+len(clientDataHash))
	signatureBase = append(signatureBase, authData...)
	signatureBase = append(signatureBase, clientDataHash...)
	digest := sha256.Sum256(signatureBase)

	signature, err := ecdsa.SignASN1(rand.Reader, privateKey, digest[:])
	if err != nil {
		return nil, fmt.Errorf("sign passkey assertion: %w", err)
	}

	if payload.Fields == nil {
		payload.Fields = map[string]any{}
	}
	payload.Fields["signCount"] = int64(nextCount)
	payload.CreatedAt = row.CreatedAt
	payload.UpdatedAt = s.nowMs()
	if err := s.updateEncryptedItemLocked(payload); err != nil {
		return nil, err
	}
	s.notifyVaultChanged("update", ItemTypePasskey, payload.ID)

	return &PasskeyAssertionResponse{
		ItemID:            payload.ID,
		CredentialID:      b64url(credentialID),
		UserID:            fieldString(payload.Fields, "userId"),
		AuthenticatorData: b64url(authData),
		Signature:         b64url(signature),
		SignCount:         nextCount,
	}, nil
}

// insertEncryptedItemLocked 加密并插入一个新条目（passkey 注册经此创建）。
//
// 空间归属：忽略 payload 传入的 SpaceID，强制归当前激活空间（与 CreateItem
// 一致）。currentSpaceID 为空时拒绝。payload 内与 DB 列同时写，保持双存一致。
// 调用方须已持有 s.mu 写锁且 s.dek != nil。
func (s *VaultService) insertEncryptedItemLocked(payload *ItemPayload) error {
	if s.currentSpaceID == "" {
		return ErrSpaceNotSelected
	}
	payload.SpaceID = s.currentSpaceID
	plaintext, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}
	ciphertext, err := SealAEAD(s.dek, plaintext, []byte(payload.ID))
	WipeBytes(plaintext)
	if err != nil {
		return fmt.Errorf("seal payload: %w", err)
	}
	row := &VaultItemRow{
		ID:        payload.ID,
		Payload:   ciphertext,
		CreatedAt: payload.CreatedAt,
		UpdatedAt: payload.UpdatedAt,
		SpaceID:   s.currentSpaceID,
	}
	if err := s.db.InsertItem(row); err != nil {
		return fmt.Errorf("insert item: %w", err)
	}
	return nil
}

// updateEncryptedItemLocked 加密并整体覆盖现有条目（passkey signCount 更新经此）。
//
// 空间归属：**保留** payload 既有的 SpaceID（它在 findPasskeyLocked 的 decryptItem
// 里已被设为 DB 行的 space_id），绝不用 currentSpaceID 覆盖 —— 否则跨空间认证
// 会把 passkey「搬」到当前空间。db.UpdateItem 本就不改 space_id 列，row.SpaceID
// 仅作表意。调用方须已持有 s.mu 写锁且 s.dek != nil。
func (s *VaultService) updateEncryptedItemLocked(payload *ItemPayload) error {
	plaintext, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}
	ciphertext, err := SealAEAD(s.dek, plaintext, []byte(payload.ID))
	WipeBytes(plaintext)
	if err != nil {
		return fmt.Errorf("seal payload: %w", err)
	}
	row := &VaultItemRow{
		ID:        payload.ID,
		Payload:   ciphertext,
		CreatedAt: payload.CreatedAt,
		UpdatedAt: payload.UpdatedAt,
		SpaceID:   payload.SpaceID,
	}
	if err := s.db.UpdateItem(row); err != nil {
		return fmt.Errorf("update item: %w", err)
	}
	return nil
}

func (s *VaultService) findPasskeyLocked(rpID, credentialID string) (*VaultItemRow, *ItemPayload, error) {
	// 空间隔离：只在当前激活空间内查找 passkey 凭据（认证也受隔离约束）。
	// 未选择空间 → 找不到。
	if s.currentSpaceID == "" {
		return nil, nil, ErrPasskeyNotFound
	}
	rows, err := s.db.ListItemsBySpace(s.currentSpaceID)
	if err != nil {
		return nil, nil, fmt.Errorf("list items: %w", err)
	}
	for i := range rows {
		payload, err := s.decryptItem(&rows[i])
		if err != nil {
			continue
		}
		if payload.Type != ItemTypePasskey {
			continue
		}
		if fieldString(payload.Fields, "rpId") != rpID {
			continue
		}
		if fieldString(payload.Fields, "credentialId") != credentialID {
			continue
		}
		payload.CreatedAt = rows[i].CreatedAt
		payload.UpdatedAt = rows[i].UpdatedAt
		return &rows[i], payload, nil
	}
	return nil, nil, ErrPasskeyNotFound
}

func defaultPasskeyName(rpName, rpID, userName, userDisplayName string) string {
	label := strings.TrimSpace(rpName)
	if label == "" {
		label = rpID
	}
	account := strings.TrimSpace(userDisplayName)
	if account == "" {
		account = strings.TrimSpace(userName)
	}
	if account == "" {
		return label
	}
	return fmt.Sprintf("%s (%s)", label, account)
}

func normalizeRPID(raw string) (string, error) {
	rpID := strings.ToLower(strings.TrimSpace(raw))
	if rpID == "" {
		return "", errors.New("rpId cannot be empty")
	}
	if strings.Contains(rpID, "://") || strings.ContainsAny(rpID, `/\?#[]@!$&'()*+,;= `) {
		return "", fmt.Errorf("invalid rpId: %q", raw)
	}
	if strings.HasSuffix(rpID, ".") {
		rpID = strings.TrimSuffix(rpID, ".")
	}
	if rpID == "localhost" {
		return rpID, nil
	}
	if ip := net.ParseIP(rpID); ip != nil {
		return rpID, nil
	}
	if len(rpID) > 253 {
		return "", fmt.Errorf("rpId too long: %d", len(rpID))
	}
	labels := strings.Split(rpID, ".")
	for _, label := range labels {
		if label == "" || len(label) > 63 {
			return "", fmt.Errorf("invalid rpId label in %q", raw)
		}
		if strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return "", fmt.Errorf("invalid rpId label in %q", raw)
		}
		for _, r := range label {
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
				continue
			}
			return "", fmt.Errorf("invalid rpId character %q", r)
		}
	}
	return rpID, nil
}

func decodeOrCreateUserID(raw string) ([]byte, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		out := make([]byte, passkeyGeneratedUserIDLen)
		if _, err := rand.Read(out); err != nil {
			return nil, fmt.Errorf("generate user id: %w", err)
		}
		return out, nil
	}
	if decoded, err := base64.RawURLEncoding.DecodeString(value); err == nil && len(decoded) > 0 {
		return decoded, nil
	}
	return []byte(value), nil
}

func decodeCredentialID(raw string) ([]byte, string, error) {
	decoded, err := decodeBase64URLStrict(raw, "credentialId")
	if err != nil {
		return nil, "", err
	}
	if len(decoded) == 0 {
		return nil, "", errors.New("credentialId cannot be empty")
	}
	return decoded, b64url(decoded), nil
}

func decodeBase64URLStrict(raw, label string) ([]byte, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return nil, fmt.Errorf("%s cannot be empty", label)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("%s must be base64url without padding: %w", label, err)
	}
	return decoded, nil
}

func b64url(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func passkeyCredentialFromPayload(payload *ItemPayload) (*PasskeyCredential, error) {
	desc, err := passkeyDescriptorFromPayload(payload)
	if err != nil {
		return nil, err
	}
	publicKeyCose := fieldString(payload.Fields, "publicKeyCose")
	publicKeySpki := fieldString(payload.Fields, "publicKeySpki")
	if publicKeyCose == "" || publicKeySpki == "" {
		return nil, errors.New("passkey public key fields are missing")
	}
	return &PasskeyCredential{
		ItemID:          desc.ItemID,
		Name:            desc.Name,
		RPID:            desc.RPID,
		RPName:          desc.RPName,
		UserID:          desc.UserID,
		UserName:        desc.UserName,
		UserDisplayName: desc.UserDisplayName,
		CredentialID:    desc.CredentialID,
		PublicKeyCOSE:   publicKeyCose,
		PublicKeySPKI:   publicKeySpki,
		Algorithm:       fieldStringDefault(payload.Fields, "algorithm", passkeyAlgES256),
		COSEAlgorithm:   passkeyCOSEAlgES256,
		SignCount:       desc.SignCount,
		Transports:      desc.Transports,
		CreatedAt:       desc.CreatedAt,
		UpdatedAt:       desc.UpdatedAt,
	}, nil
}

func passkeyDescriptorFromPayload(payload *ItemPayload) (*PasskeyCredentialDescriptor, error) {
	if payload == nil || payload.Type != ItemTypePasskey {
		return nil, ErrPasskeyNotFound
	}
	signCount, err := fieldUint32(payload.Fields, "signCount")
	if err != nil {
		return nil, err
	}
	rpID := fieldString(payload.Fields, "rpId")
	credentialID := fieldString(payload.Fields, "credentialId")
	userID := fieldString(payload.Fields, "userId")
	if rpID == "" || credentialID == "" || userID == "" {
		return nil, errors.New("passkey required fields are missing")
	}
	return &PasskeyCredentialDescriptor{
		ItemID:          payload.ID,
		Name:            payload.Name,
		RPID:            rpID,
		RPName:          fieldString(payload.Fields, "rpName"),
		UserID:          userID,
		UserName:        fieldString(payload.Fields, "userName"),
		UserDisplayName: fieldString(payload.Fields, "userDisplayName"),
		CredentialID:    credentialID,
		Transports:      fieldStringSliceDefault(payload.Fields, "transports", []string{"internal"}),
		SignCount:       signCount,
		CreatedAt:       payload.CreatedAt,
		UpdatedAt:       payload.UpdatedAt,
	}, nil
}

func privateKeyFromPasskeyFields(fields map[string]any) (*ecdsa.PrivateKey, error) {
	encoded := fieldString(fields, "privateKeyPkcs8")
	if encoded == "" {
		return nil, errors.New("passkey private key is missing")
	}
	der, err := decodeBase64URLStrict(encoded, "privateKeyPkcs8")
	if err != nil {
		return nil, err
	}
	defer WipeBytes(der)

	key, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, fmt.Errorf("parse passkey private key: %w", err)
	}
	priv, ok := key.(*ecdsa.PrivateKey)
	if !ok || priv.Curve != elliptic.P256() {
		return nil, errors.New("passkey private key is not ES256")
	}
	return priv, nil
}

func passkeyRegistrationAuthData(rpID string, credentialID []byte, publicCOSE []byte) []byte {
	flags := passkeyFlagUserPresent | passkeyFlagUserVerified | passkeyFlagAttestedData
	out := passkeyBaseAuthData(rpID, flags, 0)
	var aaguid [16]byte
	out = append(out, aaguid[:]...)
	var idLen [2]byte
	binary.BigEndian.PutUint16(idLen[:], uint16(len(credentialID)))
	out = append(out, idLen[:]...)
	out = append(out, credentialID...)
	out = append(out, publicCOSE...)
	return out
}

func passkeyAssertionAuthData(rpID string, signCount uint32) []byte {
	flags := passkeyFlagUserPresent | passkeyFlagUserVerified
	return passkeyBaseAuthData(rpID, flags, signCount)
}

func passkeyBaseAuthData(rpID string, flags byte, signCount uint32) []byte {
	rpHash := sha256.Sum256([]byte(rpID))
	out := make([]byte, 0, 37)
	out = append(out, rpHash[:]...)
	out = append(out, flags)
	var counter [4]byte
	binary.BigEndian.PutUint32(counter[:], signCount)
	out = append(out, counter[:]...)
	return out
}

func passkeyAttestationObject(authData []byte) []byte {
	out := cborMapHeader(nil, 3)
	out = cborText(out, "fmt")
	out = cborText(out, "none")
	out = cborText(out, "attStmt")
	out = cborMapHeader(out, 0)
	out = cborText(out, "authData")
	out = cborBytes(out, authData)
	return out
}

func coseKeyES256(pub *ecdsa.PublicKey) ([]byte, error) {
	if pub == nil || pub.Curve != elliptic.P256() {
		return nil, errors.New("passkey public key is not P-256")
	}
	x := leftPadBigInt(pub.X, 32)
	y := leftPadBigInt(pub.Y, 32)

	out := cborMapHeader(nil, 5)
	out = cborInt(out, 1)  // kty
	out = cborInt(out, 2)  // EC2
	out = cborInt(out, 3)  // alg
	out = cborInt(out, -7) // ES256
	out = cborInt(out, -1) // crv
	out = cborInt(out, 1)  // P-256
	out = cborInt(out, -2) // x
	out = cborBytes(out, x)
	out = cborInt(out, -3) // y
	out = cborBytes(out, y)
	return out, nil
}

func leftPadBigInt(n *big.Int, size int) []byte {
	out := make([]byte, size)
	if n == nil {
		return out
	}
	b := n.Bytes()
	if len(b) >= size {
		copy(out, b[len(b)-size:])
		return out
	}
	copy(out[size-len(b):], b)
	return out
}

func cborInt(out []byte, n int64) []byte {
	if n >= 0 {
		return cborTypeLen(out, 0, uint64(n))
	}
	return cborTypeLen(out, 1, uint64(-1-n))
}

func cborBytes(out []byte, b []byte) []byte {
	out = cborTypeLen(out, 2, uint64(len(b)))
	return append(out, b...)
}

func cborText(out []byte, s string) []byte {
	out = cborTypeLen(out, 3, uint64(len(s)))
	return append(out, s...)
}

func cborMapHeader(out []byte, n uint64) []byte {
	return cborTypeLen(out, 5, n)
}

func cborTypeLen(out []byte, major byte, n uint64) []byte {
	prefix := major << 5
	switch {
	case n < 24:
		return append(out, prefix|byte(n))
	case n <= math.MaxUint8:
		return append(out, prefix|24, byte(n))
	case n <= math.MaxUint16:
		var b [2]byte
		binary.BigEndian.PutUint16(b[:], uint16(n))
		return append(append(out, prefix|25), b[:]...)
	case n <= math.MaxUint32:
		var b [4]byte
		binary.BigEndian.PutUint32(b[:], uint32(n))
		return append(append(out, prefix|26), b[:]...)
	default:
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], n)
		return append(append(out, prefix|27), b[:]...)
	}
}

func fieldString(fields map[string]any, key string) string {
	if fields == nil {
		return ""
	}
	v, ok := fields[key]
	if !ok {
		return ""
	}
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	default:
		return ""
	}
}

func fieldStringDefault(fields map[string]any, key, fallback string) string {
	if v := fieldString(fields, key); v != "" {
		return v
	}
	return fallback
}

func fieldStringSliceDefault(fields map[string]any, key string, fallback []string) []string {
	if fields == nil {
		return append([]string(nil), fallback...)
	}
	raw, ok := fields[key]
	if !ok {
		return append([]string(nil), fallback...)
	}
	switch xs := raw.(type) {
	case []string:
		return append([]string(nil), xs...)
	case []any:
		out := make([]string, 0, len(xs))
		for _, x := range xs {
			if s, ok := x.(string); ok && strings.TrimSpace(s) != "" {
				out = append(out, strings.TrimSpace(s))
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	return append([]string(nil), fallback...)
}

func fieldUint32(fields map[string]any, key string) (uint32, error) {
	if fields == nil {
		return 0, nil
	}
	raw, ok := fields[key]
	if !ok || raw == nil {
		return 0, nil
	}
	switch x := raw.(type) {
	case uint32:
		return x, nil
	case uint64:
		if x > math.MaxUint32 {
			return 0, fmt.Errorf("%s exceeds uint32", key)
		}
		return uint32(x), nil
	case int:
		if x < 0 {
			return 0, fmt.Errorf("%s cannot be negative", key)
		}
		return uint32(x), nil
	case int64:
		if x < 0 || x > math.MaxUint32 {
			return 0, fmt.Errorf("%s out of range", key)
		}
		return uint32(x), nil
	case float64:
		if x < 0 || x > math.MaxUint32 || math.Trunc(x) != x {
			return 0, fmt.Errorf("%s out of range", key)
		}
		return uint32(x), nil
	case json.Number:
		n, err := x.Int64()
		if err != nil || n < 0 || n > math.MaxUint32 {
			return 0, fmt.Errorf("%s out of range", key)
		}
		return uint32(n), nil
	default:
		return 0, fmt.Errorf("%s has unsupported type %T", key, raw)
	}
}

// ── Imported passkey completion ─────────────────────────────────
//
// completeImportedPasskey normalizes a passkey item that arrives through the
// generic CreateItem / BatchCreateItems path carrying only raw key material —
// typically the Bitwarden importer's output: a PKCS#8 private key plus a
// GUID-form credentialId, with no public key. It derives the COSE / SPKI public
// keys from the private key, converts the credentialId to raw-bytes base64url,
// normalizes rpId / userId / signCount, and fills schema/algorithm defaults so
// the stored item is byte-compatible with what CreatePasskey would have
// produced — and therefore usable by ListPasskeys / SignPasskeyAssertion and the
// browser bridge.
//
// It is idempotent: an already-complete passkey (both public-key fields present,
// e.g. one created by CreatePasskey) is returned untouched. A passkey item with
// no usable private key and no public keys is rejected.
func completeImportedPasskey(fields map[string]any) error {
	if fields == nil {
		return errors.New("passkey item has no fields")
	}

	// Already-complete passkey (public material present) — leave key bytes as-is.
	if fieldString(fields, "publicKeyCose") != "" && fieldString(fields, "publicKeySpki") != "" {
		return nil
	}

	priv, privDER, err := decodePasskeyPrivateKeyFlexible(fieldString(fields, "privateKeyPkcs8"))
	if err != nil {
		return err
	}
	defer WipeBytes(privDER)

	publicDER, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		return fmt.Errorf("marshal imported passkey public key: %w", err)
	}
	publicCOSE, err := coseKeyES256(&priv.PublicKey)
	if err != nil {
		return err
	}

	credentialID, err := normalizeImportedCredentialID(fieldString(fields, "credentialId"))
	if err != nil {
		return err
	}
	rpID, err := normalizeRPID(fieldString(fields, "rpId"))
	if err != nil {
		return err
	}
	userIDBytes, err := decodeOrCreateUserID(fieldString(fields, "userId"))
	if err != nil {
		return err
	}
	signCount, err := importedSignCount(fields["signCount"])
	if err != nil {
		return err
	}

	fields["rpId"] = rpID
	fields["credentialId"] = credentialID
	fields["userId"] = b64url(userIDBytes)
	fields["publicKeySpki"] = b64url(publicDER)
	fields["publicKeyCose"] = b64url(publicCOSE)
	fields["privateKeyPkcs8"] = b64url(privDER) // canonical base64url, no padding
	fields["algorithm"] = passkeyAlgES256
	fields["coseAlgorithm"] = passkeyCOSEAlgES256
	fields["signCount"] = int64(signCount)
	fields["schema"] = passkeySchemaVersion
	fields["attestationFormat"] = "none"
	fields["userVerification"] = true
	if _, ok := fields["residentKey"]; !ok {
		fields["residentKey"] = true
	}
	if !hasNonEmptyStringSlice(fields["transports"]) {
		fields["transports"] = []string{"internal"}
	}
	if fieldString(fields, "createdBy") == "" {
		fields["createdBy"] = "zpass-import"
	}
	return nil
}

// decodePasskeyPrivateKeyFlexible decodes a PKCS#8 ES256 (P-256) private key
// that may be encoded in any base64/base64url variant (Bitwarden exports use
// base64url without padding). The caller owns the returned DER bytes and must
// wipe them.
func decodePasskeyPrivateKeyFlexible(encoded string) (*ecdsa.PrivateKey, []byte, error) {
	if strings.TrimSpace(encoded) == "" {
		return nil, nil, errors.New("passkey item missing key material")
	}
	der, err := decodeBase64Flexible(encoded)
	if err != nil {
		return nil, nil, fmt.Errorf("decode passkey private key: %w", err)
	}
	key, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		WipeBytes(der)
		return nil, nil, fmt.Errorf("parse passkey private key: %w", err)
	}
	priv, ok := key.(*ecdsa.PrivateKey)
	if !ok || priv.Curve != elliptic.P256() {
		WipeBytes(der)
		return nil, nil, errors.New("imported passkey private key is not ES256 (P-256)")
	}
	return priv, der, nil
}

// normalizeImportedCredentialID accepts either a hyphenated GUID (Bitwarden's
// credentialId form, whose 16 raw bytes are the WebAuthn rawId) or any base64
// variant, and returns the canonical base64url (no padding) used everywhere
// else in the passkey path.
func normalizeImportedCredentialID(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("passkey credentialId cannot be empty")
	}
	if looksLikeGUID(raw) {
		b, err := guidToRawBytes(raw)
		if err != nil {
			return "", err
		}
		return b64url(b), nil
	}
	b, err := decodeBase64Flexible(raw)
	if err != nil || len(b) == 0 {
		return "", errors.New("passkey credentialId is neither a GUID nor base64url")
	}
	return b64url(b), nil
}

// decodeBase64Flexible tries the four base64 alphabets/padding combinations so
// importers can hand us whatever variant their source produced.
func decodeBase64Flexible(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	for _, enc := range []*base64.Encoding{
		base64.RawURLEncoding,
		base64.URLEncoding,
		base64.RawStdEncoding,
		base64.StdEncoding,
	} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return nil, errors.New("value is not valid base64 / base64url")
}

// looksLikeGUID reports whether s is a canonical 8-4-4-4-12 hex GUID.
func looksLikeGUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			if !isHexDigit(r) {
				return false
			}
		}
	}
	return true
}

// guidToRawBytes decodes a hyphenated GUID into its 16 raw bytes in RFC 4122
// big-endian (string) order — the same order WebAuthn relying parties store as
// the credential rawId.
func guidToRawBytes(s string) ([]byte, error) {
	b, err := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
	if err != nil {
		return nil, fmt.Errorf("invalid GUID credentialId: %w", err)
	}
	if len(b) != 16 {
		return nil, fmt.Errorf("GUID credentialId must be 16 bytes, got %d", len(b))
	}
	return b, nil
}

func isHexDigit(r rune) bool {
	return (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')
}

// importedSignCount coerces a signCount that may arrive as a JSON number or a
// string (Bitwarden stores counter as a string like "0").
func importedSignCount(raw any) (uint32, error) {
	if s, ok := raw.(string); ok {
		s = strings.TrimSpace(s)
		if s == "" {
			return 0, nil
		}
		n, err := strconv.ParseUint(s, 10, 32)
		if err != nil {
			return 0, fmt.Errorf("invalid signCount %q", s)
		}
		return uint32(n), nil
	}
	return fieldUint32(map[string]any{"signCount": raw}, "signCount")
}

func hasNonEmptyStringSlice(raw any) bool {
	switch xs := raw.(type) {
	case []string:
		return len(xs) > 0
	case []any:
		for _, x := range xs {
			if s, ok := x.(string); ok && strings.TrimSpace(s) != "" {
				return true
			}
		}
	}
	return false
}
