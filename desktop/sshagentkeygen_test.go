// SSH 密钥生成 + 系统服务安装的烟雾测试
//
// ---------------------------------------------------------------------------
// 覆盖目标
//
// 1. GenerateKeyPair：四种算法都能生成 + 输出形态正确
// 2. SupportedSSHAlgos：默认 ed25519 在第一个
// 3. GetSystemServiceStatus：返回非 nil（即便平台不支持）
// 4. 未知算法返回 ErrUnknownAlgo
//
// 不在本文件做的：
//   - 实际安装 systemd unit（需 Linux + 写文件权限）
//   - 实际安装 Scheduled Task（需 Windows + schtasks）

package main

import (
	"errors"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func makeSshService() *SshAgentService {
	// 构造一个最小的 SshAgentService 实例 —— 不需要真实 vault，密钥生成
	// 不读 vault。
	return NewSshAgentService(nil)
}

func TestGenerateKeyPair_DefaultEd25519(t *testing.T) {
	s := makeSshService()
	kp, err := s.GenerateKeyPair("", "alex@laptop")
	if err != nil {
		t.Fatalf("GenerateKeyPair: %v", err)
	}
	if kp.Algo != "ed25519" {
		t.Errorf("default algo: want ed25519, got %s", kp.Algo)
	}
	if !strings.Contains(kp.PrivateKeyPEM, "BEGIN OPENSSH PRIVATE KEY") {
		t.Error("private key PEM missing OpenSSH header")
	}
	if !strings.HasPrefix(kp.PublicKeyOpenSSH, "ssh-ed25519 ") {
		t.Errorf("public key wrong prefix: %q", kp.PublicKeyOpenSSH)
	}
	if !strings.HasSuffix(kp.PublicKeyOpenSSH, " alex@laptop") {
		t.Errorf("public key missing comment: %q", kp.PublicKeyOpenSSH)
	}
	if !strings.HasPrefix(kp.Fingerprint, "SHA256:") {
		t.Errorf("fingerprint wrong format: %q", kp.Fingerprint)
	}

	// 验证生成的私钥能被 ssh.ParsePrivateKey 解析回来
	signer, err := ssh.ParsePrivateKey([]byte(kp.PrivateKeyPEM))
	if err != nil {
		t.Fatalf("parse generated private key: %v", err)
	}
	if signer.PublicKey().Type() != "ssh-ed25519" {
		t.Errorf("signer public key type wrong: %s", signer.PublicKey().Type())
	}

	// 验证 fingerprint 与解析后的公钥一致
	gotFp := ssh.FingerprintSHA256(signer.PublicKey())
	if gotFp != kp.Fingerprint {
		t.Errorf("fingerprint mismatch: %q vs %q", gotFp, kp.Fingerprint)
	}
}

func TestGenerateKeyPair_AllAlgos(t *testing.T) {
	s := makeSshService()

	cases := []struct {
		algo   string
		prefix string
	}{
		{"ed25519", "ssh-ed25519 "},
		{"rsa-3072", "ssh-rsa "},
		{"rsa-4096", "ssh-rsa "},
		{"ecdsa-p256", "ecdsa-sha2-nistp256 "},
	}

	for _, tc := range cases {
		t.Run(tc.algo, func(t *testing.T) {
			kp, err := s.GenerateKeyPair(tc.algo, "test")
			if err != nil {
				t.Fatalf("GenerateKeyPair(%s): %v", tc.algo, err)
			}
			if kp.Algo != tc.algo {
				t.Errorf("algo: want %s, got %s", tc.algo, kp.Algo)
			}
			if !strings.HasPrefix(kp.PublicKeyOpenSSH, tc.prefix) {
				t.Errorf("public key prefix: want %q, got %q",
					tc.prefix, kp.PublicKeyOpenSSH[:min(40, len(kp.PublicKeyOpenSSH))])
			}
			// 私钥能正常解析
			if _, err := ssh.ParsePrivateKey([]byte(kp.PrivateKeyPEM)); err != nil {
				t.Errorf("parse private key: %v", err)
			}
		})
	}
}

func TestGenerateKeyPair_UnknownAlgo(t *testing.T) {
	s := makeSshService()
	_, err := s.GenerateKeyPair("dsa", "test")
	if err == nil {
		t.Fatal("expected error for unknown algo")
	}
	if !errors.Is(err, ErrUnknownAlgo) {
		t.Errorf("expected ErrUnknownAlgo wrap, got %v", err)
	}
}

func TestGenerateKeyPair_EmptyCommentFallback(t *testing.T) {
	s := makeSshService()
	kp, err := s.GenerateKeyPair("ed25519", "")
	if err != nil {
		t.Fatalf("GenerateKeyPair: %v", err)
	}
	// 空 comment 应当用 "zpass" 兜底
	if !strings.HasSuffix(kp.PublicKeyOpenSSH, " zpass") {
		t.Errorf("expected fallback comment 'zpass', got %q", kp.PublicKeyOpenSSH)
	}
}

func TestSupportedSSHAlgos(t *testing.T) {
	s := makeSshService()
	algos := s.SupportedSSHAlgos()
	if len(algos) == 0 {
		t.Fatal("expected non-empty algo list")
	}
	if algos[0] != "ed25519" {
		t.Errorf("expected ed25519 first, got %s", algos[0])
	}
}

func TestGetSystemServiceStatus_DoesNotPanic(t *testing.T) {
	s := makeSshService()
	st, err := s.GetSystemServiceStatus()
	if err != nil {
		t.Fatalf("GetSystemServiceStatus: %v", err)
	}
	// 平台不支持时 Supported=false；支持时 Supported=true。本测试只
	// 验证调用不 panic 且返回结构正常。
	if st.PlatformLabel == "" {
		t.Error("expected non-empty PlatformLabel")
	}
}

// min 是 Go 1.21+ 的内置函数，但为兼容 case 切片在低版本中也能编译，
// 保留这个本地实现也无害。
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
