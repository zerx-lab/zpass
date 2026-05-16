// sshagentproto 包的基础烟雾测试
//
// ---------------------------------------------------------------------------
// 覆盖目标
//
// 1. Envelope 编解码 round-trip：写一个 envelope，读出来字段一致
// 2. ValidateForOp：合法 / 非法 envelope 各种组合
// 3. 版本协商：边界条件
// 4. HMAC 鉴权：正确 token + nonce → 验证通过；错误 token → 失败
//
// 不在本文件做的：
//   - 实际 socket / pipe IO（需要 OS 资源，留给集成测试）
//   - 跨平台路径解析（需要不同 OS，靠 build-tag 测试或 e2e 验证）
//
// 设计原则：测试要快（毫秒级）且不依赖外部环境，纯函数测试。

package sshagentproto

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestEnvelopeRoundTrip(t *testing.T) {
	cases := []struct {
		name string
		env  Envelope
	}{
		{
			name: "hello",
			env: Envelope{
				Op:              OpHello,
				ProtocolVersion: 1,
				MinVersion:      1,
				MaxVersion:      1,
				Role:            RoleAgent,
				Nonce:           hex.EncodeToString(bytes.Repeat([]byte{0x01}, HelloNonceSize)),
			},
		},
		{
			name: "hello_ack",
			env: Envelope{
				Op:              OpHelloAck,
				ProtocolVersion: 1,
				AgreedVersion:   1,
				NonceHMAC:       "abc123",
			},
		},
		{
			name: "push_keys with entries",
			env: Envelope{
				Op: OpPushKeys,
				Keys: []PublicKeyEntry{
					{
						Fingerprint:    "SHA256:abc",
						PublicKey:      "base64data",
						Comment:        "alex@host",
						ItemID:         "item-1",
						RequireConfirm: true,
					},
				},
			},
		},
		{
			name: "sign_request",
			env: Envelope{
				Op:            OpSignRequest,
				ReqID:         42,
				Fingerprint:   "SHA256:def",
				Data:          "base64sig",
				Flags:         2,
				ClientPID:     12345,
				ClientExe:     "/usr/bin/ssh",
				ClientExeHash: "deadbeef",
			},
		},
		{
			name: "sign_reply success",
			env: Envelope{
				Op:              OpSignReply,
				ReqID:           42,
				Signature:       "base64result",
				SignatureFormat: "ssh-ed25519",
			},
		},
		{
			name: "sign_reply error",
			env: Envelope{
				Op:    OpSignReply,
				ReqID: 42,
				Error: "user declined",
			},
		},
		{
			name: "state",
			env: Envelope{
				Op:       OpState,
				Unlocked: true,
			},
		},
		{
			name: "ping",
			env:  Envelope{Op: OpPing},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			if err := WriteFrame(&buf, &tc.env); err != nil {
				t.Fatalf("WriteFrame: %v", err)
			}
			got, err := ReadFrame(&buf)
			if err != nil {
				t.Fatalf("ReadFrame: %v", err)
			}
			if got.Op != tc.env.Op {
				t.Errorf("op: want %q, got %q", tc.env.Op, got.Op)
			}
			// 关键字段抽样比对 —— 不用 reflect.DeepEqual 因为 omitempty
			// 让 nil slice 与 empty slice 反序列化后可能不一致
			if got.ReqID != tc.env.ReqID {
				t.Errorf("ReqID: want %d, got %d", tc.env.ReqID, got.ReqID)
			}
			if got.Fingerprint != tc.env.Fingerprint {
				t.Errorf("Fingerprint: want %q, got %q", tc.env.Fingerprint, got.Fingerprint)
			}
		})
	}
}

func TestValidateForOp(t *testing.T) {
	validNonce := hex.EncodeToString(bytes.Repeat([]byte{0x02}, HelloNonceSize))

	cases := []struct {
		name    string
		env     Envelope
		wantErr bool
	}{
		{
			name: "valid hello",
			env: Envelope{
				Op:              OpHello,
				ProtocolVersion: 1,
				MinVersion:      1,
				MaxVersion:      1,
				Role:            RoleAgent,
				Nonce:           validNonce,
			},
			wantErr: false,
		},
		{
			name:    "hello missing version",
			env:     Envelope{Op: OpHello, Role: RoleAgent, Nonce: validNonce},
			wantErr: true,
		},
		{
			name: "hello wrong role",
			env: Envelope{
				Op: OpHello, ProtocolVersion: 1, MinVersion: 1, MaxVersion: 1,
				Role: "bogus", Nonce: validNonce,
			},
			wantErr: true,
		},
		{
			name: "hello short nonce",
			env: Envelope{
				Op: OpHello, ProtocolVersion: 1, MinVersion: 1, MaxVersion: 1,
				Role: RoleAgent, Nonce: "abc",
			},
			wantErr: true,
		},
		{
			name:    "sign_request missing fingerprint",
			env:     Envelope{Op: OpSignRequest, ReqID: 1, Data: "x"},
			wantErr: true,
		},
		{
			name:    "sign_reply with neither signature nor error",
			env:     Envelope{Op: OpSignReply, ReqID: 1},
			wantErr: true,
		},
		{
			name:    "unknown op",
			env:     Envelope{Op: "totally_made_up"},
			wantErr: true,
		},
		{
			name:    "state simple",
			env:     Envelope{Op: OpState, Unlocked: true},
			wantErr: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.env.ValidateForOp()
			if (err != nil) != tc.wantErr {
				t.Errorf("ValidateForOp: wantErr=%v, got %v", tc.wantErr, err)
			}
		})
	}
}

func TestNegotiateVersion(t *testing.T) {
	cases := []struct {
		name                   string
		oMin, oMax, tMin, tMax uint32
		want                   uint32
		wantErr                bool
	}{
		{name: "identical ranges", oMin: 1, oMax: 1, tMin: 1, tMax: 1, want: 1},
		{name: "overlap pick max", oMin: 1, oMax: 3, tMin: 2, tMax: 4, want: 3},
		{name: "no overlap", oMin: 1, oMax: 1, tMin: 2, tMax: 3, wantErr: true},
		{name: "zero rejected", oMin: 0, oMax: 1, tMin: 1, tMax: 1, wantErr: true},
		{name: "inverted range rejected", oMin: 2, oMax: 1, tMin: 1, tMax: 1, wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NegotiateVersion(tc.oMin, tc.oMax, tc.tMin, tc.tMax)
			if (err != nil) != tc.wantErr {
				t.Errorf("err: wantErr=%v, got %v", tc.wantErr, err)
			}
			if !tc.wantErr && got != tc.want {
				t.Errorf("agreed: want %d got %d", tc.want, got)
			}
		})
	}
}

func TestHMACRoundTrip(t *testing.T) {
	token := bytes.Repeat([]byte{0x42}, CapabilityTokenSize)
	nonce, err := NewNonce()
	if err != nil {
		t.Fatalf("NewNonce: %v", err)
	}
	mac := ComputeNonceHMAC(token, nonce)
	if mac == "" {
		t.Fatal("ComputeNonceHMAC returned empty")
	}
	if !VerifyNonceHMAC(token, nonce, mac) {
		t.Error("VerifyNonceHMAC: expected ok, got fail")
	}

	// 错误 token 应当失败
	wrongToken := bytes.Repeat([]byte{0xff}, CapabilityTokenSize)
	if VerifyNonceHMAC(wrongToken, nonce, mac) {
		t.Error("VerifyNonceHMAC: expected fail with wrong token, got ok")
	}

	// 错误 nonce 应当失败
	wrongNonce, _ := NewNonce()
	if VerifyNonceHMAC(token, wrongNonce, mac) {
		t.Error("VerifyNonceHMAC: expected fail with wrong nonce, got ok")
	}

	// 错误格式的 mac 应当失败而不是 panic
	if VerifyNonceHMAC(token, nonce, "not-hex") {
		t.Error("VerifyNonceHMAC: expected fail with malformed mac")
	}
	if VerifyNonceHMAC(token, nonce, "") {
		t.Error("VerifyNonceHMAC: expected fail with empty mac")
	}
}

func TestFrameTooLarge(t *testing.T) {
	// 直接构造一个超大长度的 header 喂给 ReadFrame
	tooLarge := make([]byte, 4)
	// 写入超过 MaxFrameBytes 的 length
	overSize := MaxFrameBytes + 1
	tooLarge[0] = byte(overSize >> 24)
	tooLarge[1] = byte(overSize >> 16)
	tooLarge[2] = byte(overSize >> 8)
	tooLarge[3] = byte(overSize)

	r := bytes.NewReader(tooLarge)
	_, err := ReadFrame(r)
	if err == nil {
		t.Fatal("ReadFrame: expected error for oversized frame")
	}
	// 不强求 errors.Is(err, ErrFrameTooLarge) —— fmt.Errorf("%w", ...)
	// 包装后用 errors.Is 也能识别，但若实现改为非 %w 会失败。保持宽松。
}
