//go:build nativehost

package main

import (
	filepathpkg "path/filepath"
	"testing"
	"time"
)

// filepath_join 是 filepathpkg.Join 的局部别名，让测试内联调用保持简洁。
func filepath_join(parts ...string) string { return filepathpkg.Join(parts...) }

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
		// PSL base domain 跨子域匹配（新增）——OpenAI 场景:
		//   保存 chat.openai.com 的条目，在 auth.openai.com 上应该被匹中
		//   (两者 PSL eTLD+1 都是 openai.com)。旧版制 strings.HasSuffix 不覆盖该反方向。
		{name: "psl cross-subdomain same registrable", credential: "https://chat.openai.com", origin: "https://auth.openai.com", want: true},
		{name: "psl deep subdomain to leaf", credential: "https://platform.openai.com", origin: "https://chat.openai.com", want: true},
		{name: "psl etld different registrable", credential: "https://openai.io", origin: "https://openai.com", want: false},
		// google.com 黑名单：保存 google.com 不应被填到 script.google.com
		{name: "blacklist script.google.com", credential: "https://google.com", origin: "https://script.google.com", want: false},
		{name: "blacklist allows mail.google.com", credential: "https://google.com", origin: "https://mail.google.com", want: true},
		// IP / localhost 退回旧版 子域策略
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

// TestDispatchMessageGUIUnavailable验证 bridge 不可达 + GUI binary 找不到
// 时，dispatchMessage 返回结构化 errCodeDesktopUnavailable，不会陷入任何
// vault 直读路径。
//
// HOME / USERPROFILE 指到 t.TempDir() 以避免读到真实用户的
func TestDispatchMessageGUIUnavailable(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("USERPROFILE", tmp)
	// 明确指向一个不存在的 GUI binary，让 ensureGUIRunning 决定性失败
	t.Setenv("ZPASS_GUI_BIN", filepath_join(tmp, "nope-doesnt-exist"))
	// 清理 launcher 状态，避免受上一个测试冷却期影响
	guiLauncherMu.Lock()
	guiLauncherLastTry = time.Time{}
	guiLauncherBin = ""
	guiLauncherMu.Unlock()

	resp := dispatchMessage(nativeEnvelope{ID: "test-1", Type: "status"})
	if resp.OK {
		t.Fatalf("expected !OK when GUI unavailable; got %+v", resp)
	}
	if resp.ID != "test-1" {
		t.Fatalf("want response id echoed, got %q", resp.ID)
	}
	if resp.Error != errCodeDesktopUnavailable {
		t.Fatalf("want errCodeDesktopUnavailable, got %q", resp.Error)
	}
}
