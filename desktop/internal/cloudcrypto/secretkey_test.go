package cloudcrypto

import (
	"strings"
	"testing"
)

// TestSecretKeyCloudAnchor pins the Z1 codec to the cloud reference client
// (cloud/skeleton-cli/src/main.rs): the body decodes to one byte per char with
// value (ch - 'A') in 0..25 (NOT the ASCII byte), and the account_id is its raw
// A-Z ASCII bytes. A drift here derives a different AUK / SRP-x and breaks login
// against any account registered on another client.
func TestSecretKeyCloudAnchor(t *testing.T) {
	// account_id "ABCDEF"; three body groups. The body here is the 26-letter
	// alphabet thrice, so the expected raw is 0..25 repeated three times.
	sk := "Z1-ABCDEF-ABCDEFGHIJKLMNOPQRSTUVWXYZ-ABCDEFGHIJKLMNOPQRSTUVWXYZ-ABCDEFGHIJKLMNOPQRSTUVWXYZ"

	acct, raw, err := ParseSecretKey(sk)
	if err != nil {
		t.Fatal(err)
	}
	if acct != "ABCDEF" {
		t.Fatalf("account_id = %q, want ABCDEF", acct)
	}
	if len(raw) != 78 {
		t.Fatalf("sk_raw length = %d, want 78", len(raw))
	}
	for i, b := range raw {
		want := byte(i % 26) // each group is A..Z -> 0..25
		if b != want {
			t.Fatalf("sk_raw[%d] = %d, want %d (must be char index, not ASCII)", i, b, want)
		}
	}
	// account_id canonical bytes are the raw ASCII of the 6 A-Z chars.
	acctBytes, err := AccountIDCanonicalBytes(acct)
	if err != nil {
		t.Fatal(err)
	}
	if string(acctBytes) != "ABCDEF" {
		t.Fatalf("account_id bytes = %q, want ABCDEF", acctBytes)
	}
}

// TestSecretKeyLenientGrouping proves grouping/case do not change the decoded
// bytes: the canonical Z1-<6>-<26>-<26>-<26> form, a hyphen-free form, and a
// lower-case form all decode identically.
func TestSecretKeyLenientGrouping(t *testing.T) {
	canonical := "Z1-ABCDEF-ABCDEFGHIJKLMNOPQRSTUVWXYZ-ABCDEFGHIJKLMNOPQRSTUVWXYZ-ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	variants := []string{
		canonical,
		strings.ReplaceAll(canonical, "-", ""), // no hyphens
		strings.ToLower(canonical),             // lower case
		"Z1ABCDEF" + strings.Repeat("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 3), // bare
	}
	var want []byte
	for i, v := range variants {
		_, raw, err := ParseSecretKey(v)
		if err != nil {
			t.Fatalf("variant %d (%q) rejected: %v", i, v, err)
		}
		if want == nil {
			want = raw
			continue
		}
		if string(raw) != string(want) {
			t.Fatalf("variant %d decoded differently", i)
		}
	}
}

// TestGenerateSecretKeyValid checks generated keys are the cloud A-Z 84-char
// form and round-trip through validation + canonicalization.
func TestGenerateSecretKeyValid(t *testing.T) {
	for i := 0; i < 256; i++ {
		acct, err := GenerateAccountID()
		if err != nil {
			t.Fatal(err)
		}
		sk, err := GenerateSecretKey(acct)
		if err != nil {
			t.Fatal(err)
		}
		// Display form: Z1-<6>-<26>-<26>-<26>.
		parts := strings.Split(sk, "-")
		if len(parts) != 5 || parts[0] != "Z1" || len(parts[1]) != 6 ||
			len(parts[2]) != 26 || len(parts[3]) != 26 || len(parts[4]) != 26 {
			t.Fatalf("generated key wrong shape: %q", sk)
		}
		if err := ValidateSecretKey(sk); err != nil {
			t.Fatalf("generated invalid key %q: %v", sk, err)
		}
		raw, err := SecretKeyCanonicalBytes(sk)
		if err != nil {
			t.Fatalf("canonical(%q): %v", sk, err)
		}
		if len(raw) != 78 {
			t.Fatalf("canonical length = %d, want 78", len(raw))
		}
		for _, b := range raw {
			if b > 25 {
				t.Fatalf("raw byte %d out of 0..25 in %q", b, sk)
			}
		}
	}
}

// TestValidateRejects keeps the format strict on the things that matter
// (version, alphabet, total length) while tolerant of grouping/case.
func TestSecretKeyValidateRejects(t *testing.T) {
	body := strings.Repeat("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 3) // 78 valid body chars
	cases := []string{
		"A3-ABCDEF-" + body,                    // wrong version prefix
		"Z1-ABCDE1-" + body,                    // digit in account_id (not A-Z)
		"Z1-ABCDEF-" + body[:77],               // body one char short (83 total)
		"Z1-ABCDEF-" + body + "A",              // body one char long (85 total)
		"Z1-ABCDEF-" + strings.Repeat("9", 78), // body all digits (not A-Z)
		"",
	}
	for _, c := range cases {
		if err := ValidateSecretKey(c); err == nil {
			t.Fatalf("expected reject for %q", c)
		}
	}
	if err := ValidateAccountID("ABCDE"); err == nil {
		t.Fatal("expected reject for 5-char account_id")
	}
	if err := ValidateAccountID("ABCDE1"); err == nil {
		t.Fatal("expected reject for digit in account_id")
	}
	if err := ValidateAccountID("ABCDEF"); err != nil {
		t.Fatalf("valid account_id rejected: %v", err)
	}
}
