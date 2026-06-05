package cloudcrypto

import (
	"errors"
	"strings"
)

// Secret Key — the "Z1" encoding defined by the cloud reference client
// (cloud/skeleton-cli/src/main.rs) and the web vault. The desktop MUST match it
// byte-for-byte: registration can happen on any client, and the Secret Key
// feeds the 2SKD HKDF, so a divergent codec derives a different AUK / SRP-x and
// login against a cloud-registered account fails.
//
//	Z1-<account_id:6>-<group1:26>-<group2:26>-<group3:26>
//
// Alphabet = uppercase A-Z (26 symbols). Total = 6 + 26*3 = 84 chars.
//
//	account_id           : 6 A-Z chars; fed to 2SKD as its raw ASCII bytes
//	                       (skeleton-cli: account_id.as_bytes()).
//	secret_key_raw (IKM) : 78 bytes, one per BODY char, each = (ch - 'A') in
//	                       0..25 — NOT the ASCII byte. (skeleton-cli sk_raw.)
//
// Hyphen grouping and case are normalized away before decoding, so a key pasted
// with stray/missing hyphens or in lower case still decodes to the exact same
// bytes the cloud derived from.
const (
	secretKeyVer = "Z1"
	// skAlphabet is the 26-symbol body/account alphabet (A-Z), index i -> byte.
	skAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	// accountIDLen / skBodyLen / skTotalChars are the canonical char counts.
	accountIDLen = 6
	skGroupLen   = 26
	skGroupCount = 3
	skBodyLen    = skGroupLen * skGroupCount // 78
	skTotalChars = accountIDLen + skBodyLen  // 84
)

var (
	ErrAccountIDFormat = errors.New("cloudcrypto: account_id must be 6 chars from A-Z")
	ErrSecretKeyFormat = errors.New("cloudcrypto: secret key must be Z1- + 6 account chars + 78 body chars, all A-Z")
)

// isAZ reports whether every rune of s is in A-Z.
func isAZ(s string) bool {
	for _, c := range s {
		if c < 'A' || c > 'Z' {
			return false
		}
	}
	return len(s) > 0
}

// ValidateAccountID enforces the 6-char A-Z form.
func ValidateAccountID(accountID string) error {
	if len(accountID) != accountIDLen || !isAZ(accountID) {
		return ErrAccountIDFormat
	}
	return nil
}

// canonicalSecretChars normalizes a secret key to its hyphen-free, uppercase
// char run (account_id ++ body = 84 A-Z chars) and validates length + alphabet.
func canonicalSecretChars(s string) (string, error) {
	canon := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(s), "-", ""))
	if !strings.HasPrefix(canon, secretKeyVer) {
		return "", ErrSecretKeyFormat
	}
	rest := canon[len(secretKeyVer):]
	if len(rest) != skTotalChars || !isAZ(rest) {
		return "", ErrSecretKeyFormat
	}
	return rest, nil
}

// ValidateSecretKey enforces the Z1 structure and A-Z alphabet, independent of
// hyphen grouping or case.
func ValidateSecretKey(s string) error {
	_, err := canonicalSecretChars(s)
	return err
}

// AccountIDCanonicalBytes returns the account_id ASCII bytes (HKDF salt), the
// raw bytes of the 6 A-Z chars — matching skeleton-cli's account_id.as_bytes().
func AccountIDCanonicalBytes(accountID string) ([]byte, error) {
	if err := ValidateAccountID(accountID); err != nil {
		return nil, err
	}
	return []byte(accountID), nil
}

// bodyToRaw maps the 78 body chars to their KDF bytes: each = (ch - 'A') in
// 0..25. This is the secret_key_raw the cloud feeds as the 2SKD HKDF IKM.
func bodyToRaw(body string) []byte {
	raw := make([]byte, len(body))
	for i := 0; i < len(body); i++ {
		raw[i] = body[i] - 'A'
	}
	return raw
}

// SecretKeyCanonicalBytes returns the 78-byte HKDF IKM (each byte 0..25), not
// ASCII — the cloud reference client's sk_raw.
func SecretKeyCanonicalBytes(s string) ([]byte, error) {
	rest, err := canonicalSecretChars(s)
	if err != nil {
		return nil, err
	}
	return bodyToRaw(rest[accountIDLen:]), nil
}

// ParseSecretKey splits a Z1 secret key into (accountID string, skRaw 78 bytes).
func ParseSecretKey(s string) (accountID string, skRaw []byte, err error) {
	rest, err := canonicalSecretChars(s)
	if err != nil {
		return "", nil, err
	}
	return rest[:accountIDLen], bodyToRaw(rest[accountIDLen:]), nil
}

// GenerateAccountID draws a fresh 6-char A-Z account id (each random byte mod
// 26), matching the cloud reference client. The account id is the non-secret,
// immutable prefix of a Secret Key and doubles as the HKDF salt in 2SKD.
func GenerateAccountID() (string, error) {
	seed, err := randomBytes(accountIDLen)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	for _, x := range seed {
		b.WriteByte(skAlphabet[int(x)%26])
	}
	return b.String(), nil
}

// GenerateSecretKey builds a fresh Z1 Secret Key for accountID: three 26-char
// A-Z groups (each char from a random byte mod 26), formatted
// Z1-<accountID>-<g1>-<g2>-<g3>. Byte-compatible with the cloud client's format.
func GenerateSecretKey(accountID string) (string, error) {
	if err := ValidateAccountID(accountID); err != nil {
		return "", err
	}
	var key strings.Builder
	key.WriteString(secretKeyVer)
	key.WriteByte('-')
	key.WriteString(accountID)
	for g := 0; g < skGroupCount; g++ {
		raw, err := randomBytes(skGroupLen)
		if err != nil {
			return "", err
		}
		key.WriteByte('-')
		for _, x := range raw {
			key.WriteByte(skAlphabet[int(x)%26])
		}
	}
	return key.String(), nil
}
