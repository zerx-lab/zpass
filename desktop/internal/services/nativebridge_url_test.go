// URL/origin matching tests for the native bridge protocol.
//
// These tests used to live under cmd/zpass-native-host because the helpers
// were colocated there. After splitting the protocol code into this package
// (it depends on VaultService and ItemPayload), the tests followed.
package services

import "testing"

func TestNativeURLMatchesOrigin(t *testing.T) {
	tests := []struct {
		name       string
		credential string
		origin     string
		want       bool
	}{
		{name: "exact host", credential: "https://example.com/login", origin: "https://example.com", want: true},
		{name: "subdomain", credential: "example.com", origin: "https://app.example.com", want: true},
		{name: "different suffix", credential: "ample.com", origin: "https://example.com", want: false},
		{name: "different site", credential: "https://example.org", origin: "https://example.com", want: false},
		{name: "reject extension url", credential: "chrome-extension://abc", origin: "https://example.com", want: false},
		// PSL base-domain cross-subdomain matches (OpenAI scenario): a chat.openai.com
		// entry should match auth.openai.com because both share the openai.com
		// eTLD+1. The pre-PSL HasSuffix logic missed this direction.
		{name: "psl cross-subdomain same registrable", credential: "https://chat.openai.com", origin: "https://auth.openai.com", want: true},
		{name: "psl deep subdomain to leaf", credential: "https://platform.openai.com", origin: "https://chat.openai.com", want: true},
		{name: "psl etld different registrable", credential: "https://openai.io", origin: "https://openai.com", want: false},
		// google.com blacklist: a saved google.com entry must not auto-fill on script.google.com.
		{name: "blacklist script.google.com", credential: "https://google.com", origin: "https://script.google.com", want: false},
		{name: "blacklist allows mail.google.com", credential: "https://google.com", origin: "https://mail.google.com", want: true},
		// IPs and localhost fall back to the old strict-subdomain policy.
		{name: "localhost exact", credential: "http://localhost:8080", origin: "http://localhost", want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			origin, err := parseSafeOrigin(pageContext{Origin: tt.origin})
			if err != nil {
				t.Fatal(err)
			}
			got := urlMatchesOrigin(tt.credential, origin)
			if got != tt.want {
				t.Fatalf("urlMatchesOrigin()=%v, want %v", got, tt.want)
			}
		})
	}
}

func TestNativeItemURLs(t *testing.T) {
	fields := map[string]any{
		"url":  "https://one.example",
		"uris": []any{"https://two.example", 123, ""},
	}
	got := itemURLs(fields)
	if len(got) != 2 {
		t.Fatalf("len(itemURLs)=%d, want 2: %#v", len(got), got)
	}
}
