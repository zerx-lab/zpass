//go:build nativehost

package main

import "testing"

func TestNativeURLMatchesOrigin(t *testing.T) {
	tests := []struct {
		name      string
		credential string
		origin    string
		want      bool
	}{
		{name: "exact host", credential: "https://example.com/login", origin: "https://example.com", want: true},
		{name: "subdomain", credential: "example.com", origin: "https://app.example.com", want: true},
		{name: "different suffix", credential: "ample.com", origin: "https://example.com", want: false},
		{name: "different site", credential: "https://example.org", origin: "https://example.com", want: false},
		{name: "reject extension url", credential: "chrome-extension://abc", origin: "https://example.com", want: false},
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
