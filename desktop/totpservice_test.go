package main

// totpservice 单元测试 —— 覆盖三种 OTP 算法 (TOTP / HOTP / Steam Guard)
//
// 测试矩阵：
//
//   一、TOTP（向后兼容旧测试）
//     1. login 条目带合法 totp secret → 返回 6 位数字，period=30，剩余 1..30
//     2. 独立 totp 类型条目 → 同样能生成
//     3. login 条目无 totp 字段 → ErrTOTPSecretMissing
//     4. login 条目 totp 字段是非法 base32 → ErrTOTPSecretInvalid
//     5. note 等不支持类型 → ErrTOTPSecretMissing
//     6. vault 锁定 → ErrVaultLocked（继承 GetItem 的契约）
//     7. otpauth:// URI 形态密钥
//
//   二、HOTP（RFC 4226 测试向量）
//     8. RFC 4226 Appendix D 全部 10 个标准测试向量 (counter 0..9)
//     9. AdvanceHOTPCounter 对 hotp 条目 +1 并持久化
//    10. AdvanceHOTPCounter 对 totp 条目报 ErrOTPTypeMismatch
//    11. AdvanceHOTPCounter 连续两次产生不同的码
//    12. otpauth://hotp/?counter=N 解析正确
//
//   三、Steam Guard
//    13. Steam encoder 输出 5 位、字符集合法（仅含 23456789BCDFGHJKMNPQRTVWXY）
//    14. fields["otp_type"]="steam" 显式配置
//    15. otpauth://totp/?issuer=Steam 隐式推断
//
//   四、参数解析（extractOTPParams / parseOTPSecret）
//    16. 显式覆盖：fields["otp_algorithm"]="SHA256" / otp_digits=8
//    17. URI 中 algorithm/digits/period 解析

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pquerna/otp"
)

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

// loginWithTOTP 构造一个带 TOTP 密钥的 login 条目
//
// 密钥来自 RFC 6238 / Google Authenticator 文档常用的示例 base32：
//   "JBSWY3DPEHPK3PXP" → "Hello!\xde\xad\xbe\xef"
func loginWithTOTP(name string, secret string) ItemPayload {
	in := loginItemFixture(name)
	in.Fields["totp"] = secret
	return in
}

// hotpItem 构造一个带 HOTP 配置的 login 条目，counter 默认 0
func hotpItem(name, secret string, counter uint64) ItemPayload {
	in := loginItemFixture(name)
	in.Fields["totp"] = secret
	in.Fields["otp_type"] = "hotp"
	in.Fields["hotp_counter"] = float64(counter)
	return in
}

// steamItem 构造一个 Steam Guard 类型的 totp 条目
func steamItem(name, secret string) ItemPayload {
	return ItemPayload{
		Type: ItemTypeTOTP,
		Name: name,
		Fields: map[string]any{
			"totp":     secret,
			"otp_type": "steam",
			"issuer":   "Steam",
			"account":  "alex@zpass.dev",
		},
	}
}

// ---------------------------------------------------------------------------
// 一、TOTP 兼容测试
// ---------------------------------------------------------------------------

func TestGenerateTOTP_LoginWithSecret(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	created, err := svc.CreateItem(loginWithTOTP("GitHub", "JBSWY3DPEHPK3PXP"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	code, err := svc.GenerateTOTP(created.ID)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if code == nil {
		t.Fatal("expected code, got nil")
	}
	if len(code.Code) != 6 {
		t.Errorf("expected 6-digit code, got %q", code.Code)
	}
	if _, err := strconv.Atoi(code.Code); err != nil {
		t.Errorf("code is not numeric: %q", code.Code)
	}
	if code.Period != 30 || code.Digits != 6 || code.Algorithm != "SHA1" {
		t.Errorf("unexpected meta: %+v", code)
	}
	if code.Type != "totp" {
		t.Errorf("expected type=totp, got %q", code.Type)
	}
	if code.Remaining < 1 || code.Remaining > 30 {
		t.Errorf("remaining out of range: %d", code.Remaining)
	}
}

func TestGenerateTOTP_AcceptsSpacedAndLowercase(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	created, err := svc.CreateItem(loginWithTOTP("Linear", "jbsw y3dp ehpk 3pxp"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	code, err := svc.GenerateTOTP(created.ID)
	if err != nil {
		t.Fatalf("generate (spaced/lower): %v", err)
	}
	if len(code.Code) != 6 {
		t.Errorf("expected 6-digit code, got %q", code.Code)
	}
}

func TestGenerateTOTP_DedicatedTOTPType(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	in := ItemPayload{
		Type: ItemTypeTOTP,
		Name: "Auth Anchor",
		Fields: map[string]any{
			"issuer":  "Anchor",
			"account": "alex@zpass.dev",
			"totp":    "JBSWY3DPEHPK3PXP",
		},
	}
	created, err := svc.CreateItem(in)
	if err != nil {
		t.Fatalf("create totp item: %v", err)
	}
	code, err := svc.GenerateTOTP(created.ID)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(code.Code) != 6 {
		t.Errorf("expected 6-digit code, got %q", code.Code)
	}
}

func TestGenerateTOTP_MissingSecret(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	created, err := svc.CreateItem(loginItemFixture("PlainLogin"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := svc.GenerateTOTP(created.ID); !errors.Is(err, ErrTOTPSecretMissing) {
		t.Errorf("expected ErrTOTPSecretMissing, got %v", err)
	}
}

func TestGenerateTOTP_InvalidSecret(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	created, err := svc.CreateItem(loginWithTOTP("Bogus", "!!!not-base32!!!"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	_, err = svc.GenerateTOTP(created.ID)
	if !errors.Is(err, ErrTOTPSecretInvalid) {
		t.Errorf("expected ErrTOTPSecretInvalid, got %v", err)
	}
}

func TestGenerateTOTP_UnsupportedType(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	in := ItemPayload{
		Type:   ItemTypeNote,
		Name:   "Just a note",
		Fields: map[string]any{"notes": "hello"},
	}
	created, err := svc.CreateItem(in)
	if err != nil {
		t.Fatalf("create note: %v", err)
	}
	if _, err := svc.GenerateTOTP(created.ID); !errors.Is(err, ErrTOTPSecretMissing) {
		t.Errorf("expected ErrTOTPSecretMissing, got %v", err)
	}
}

func TestGenerateTOTP_VaultLocked(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	created, err := svc.CreateItem(loginWithTOTP("X", "JBSWY3DPEHPK3PXP"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := svc.Lock(); err != nil {
		t.Fatalf("lock: %v", err)
	}
	_, err = svc.GenerateTOTP(created.ID)
	if !errors.Is(err, ErrVaultLocked) {
		t.Errorf("expected ErrVaultLocked, got %v", err)
	}
}

func TestGenerateTOTP_OtpauthURI(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	uri := "otpauth://totp/GitHub:ZeroHawkeye?secret=CZBZTDBU5ADOXZ23&issuer=GitHub"
	created, err := svc.CreateItem(loginWithTOTP("GitHub", uri))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	code, err := svc.GenerateTOTP(created.ID)
	if err != nil {
		t.Fatalf("generate from otpauth uri: %v", err)
	}
	if len(code.Code) != 6 {
		t.Errorf("expected 6-digit code, got %q", code.Code)
	}
}

// ---------------------------------------------------------------------------
// 二、HOTP 测试 —— RFC 4226 标准测试向量
// ---------------------------------------------------------------------------

// rfc4226TestSecret 是 RFC 4226 Appendix D 用的密钥
//
// 原始 ASCII："12345678901234567890" (20 字节)
// base32 编码："GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
//
// RFC 4226 §5.3 把这串密钥喂给 HOTP，counter 0..9 对应固定的 6 位输出，
// 这是标准库正确性的"金标准向量"。
const rfc4226TestSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

// rfc4226Vectors 来自 RFC 4226 Appendix D Table 1（Truncated HOTP Values）
//
// 这是 6 位截断的 HOTP 值。任何符合 RFC 4226 的实现都必须输出完全相同
// 的码。我们用这个来端到端验证：参数解析 + algorithm 接入 + 截断逻辑全
// 链路无误。
var rfc4226Vectors = []struct {
	counter uint64
	expect  string
}{
	{0, "755224"},
	{1, "287082"},
	{2, "359152"},
	{3, "969429"},
	{4, "338314"},
	{5, "254676"},
	{6, "287922"},
	{7, "162583"},
	{8, "399871"},
	{9, "520489"},
}

// TestHOTP_RFC4226Vectors 是 HOTP 算法正确性的金标准测试
//
// 直接调 computeOTP（不经过 vault 加解密层），快速覆盖全部 10 个标准向量。
// 任何向量失败都说明算法接入出了问题（可能是 digits / algorithm /
// counter 编码 / encoder 默认值之一）。
func TestHOTP_RFC4226Vectors(t *testing.T) {
	for _, v := range rfc4226Vectors {
		params := &otpParams{
			Type:      OTPTypeHOTP,
			Secret:    rfc4226TestSecret,
			Algorithm: otp.AlgorithmSHA1,
			Digits:    otp.DigitsSix,
			Counter:   v.counter,
			Encoder:   otp.EncoderDefault,
		}
		code, err := computeOTP(params, time.Unix(0, 0))
		if err != nil {
			t.Fatalf("counter=%d: %v", v.counter, err)
		}
		if code.Code != v.expect {
			t.Errorf("RFC 4226 vector mismatch: counter=%d got=%q want=%q",
				v.counter, code.Code, v.expect)
		}
		if code.Type != "hotp" {
			t.Errorf("counter=%d: expected type=hotp, got %q", v.counter, code.Type)
		}
		if code.Counter != v.counter {
			t.Errorf("counter=%d: returned counter=%d", v.counter, code.Counter)
		}
		// HOTP 不应该有 Period/Remaining
		if code.Period != 0 || code.Remaining != 0 {
			t.Errorf("counter=%d: HOTP should not have period/remaining, got %+v", v.counter, code)
		}
	}
}

// TestGenerateTOTP_HOTPViaService 端到端：HOTP 条目通过 GenerateTOTP 出码
//
// 验证 fields["otp_type"]="hotp" + fields["hotp_counter"]=N 能被
// extractOTPParams 正确解析并产生 RFC 4226 标准向量。
func TestGenerateTOTP_HOTPViaService(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	// counter=3 应该出 RFC 向量 "969429"
	in := hotpItem("YubiKey", rfc4226TestSecret, 3)
	created, err := svc.CreateItem(in)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	code, err := svc.GenerateTOTP(created.ID)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if code.Code != "969429" {
		t.Errorf("expected RFC 4226 counter=3 vector 969429, got %q", code.Code)
	}
	if code.Type != "hotp" {
		t.Errorf("expected type=hotp, got %q", code.Type)
	}
	if code.Counter != 3 {
		t.Errorf("expected counter=3, got %d", code.Counter)
	}
}

// TestAdvanceHOTPCounter 验证计数器 +1 持久化 + 出新码
func TestAdvanceHOTPCounter(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	// 起始 counter=0，调用 Advance 后应该用 counter=1 出码 → "287082"
	created, err := svc.CreateItem(hotpItem("YubiKey", rfc4226TestSecret, 0))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	code, err := svc.AdvanceHOTPCounter(created.ID)
	if err != nil {
		t.Fatalf("advance: %v", err)
	}
	if code.Code != "287082" {
		t.Errorf("expected counter=1 vector 287082, got %q", code.Code)
	}
	if code.Counter != 1 {
		t.Errorf("expected counter=1 in response, got %d", code.Counter)
	}

	// 验证持久化：再 GetItem 取出来 counter 应该等于 1
	got, err := svc.GetItem(created.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if n, ok := readNumeric(got.Fields["hotp_counter"]); !ok || n != 1 {
		t.Errorf("persisted counter mismatch: got %v (ok=%v)", got.Fields["hotp_counter"], ok)
	}

	// 再 Advance 一次 counter 应该到 2 → "359152"
	code2, err := svc.AdvanceHOTPCounter(created.ID)
	if err != nil {
		t.Fatalf("advance #2: %v", err)
	}
	if code2.Code != "359152" {
		t.Errorf("expected counter=2 vector 359152, got %q", code2.Code)
	}
	if code2.Counter != 2 {
		t.Errorf("expected counter=2, got %d", code2.Counter)
	}
}

// TestAdvanceHOTPCounter_RejectsTOTP 对非 hotp 条目调用应报 ErrOTPTypeMismatch
func TestAdvanceHOTPCounter_RejectsTOTP(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	// 普通 TOTP 条目（没有 otp_type 字段，默认 totp）
	created, err := svc.CreateItem(loginWithTOTP("GitHub", rfc4226TestSecret))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	_, err = svc.AdvanceHOTPCounter(created.ID)
	if !errors.Is(err, ErrOTPTypeMismatch) {
		t.Errorf("expected ErrOTPTypeMismatch, got %v", err)
	}
}

// TestAdvanceHOTPCounter_VaultLocked 锁定状态下应继承 ErrVaultLocked
func TestAdvanceHOTPCounter_VaultLocked(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	created, err := svc.CreateItem(hotpItem("YK", rfc4226TestSecret, 0))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := svc.Lock(); err != nil {
		t.Fatalf("lock: %v", err)
	}
	_, err = svc.AdvanceHOTPCounter(created.ID)
	if !errors.Is(err, ErrVaultLocked) {
		t.Errorf("expected ErrVaultLocked, got %v", err)
	}
}

// TestHOTP_FromOtpauthURI 从 otpauth://hotp/?counter=N 解析
func TestHOTP_FromOtpauthURI(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	// counter=5 应该出 "254676"
	uri := "otpauth://hotp/Demo:alex?secret=" + rfc4226TestSecret + "&counter=5&issuer=Demo"
	created, err := svc.CreateItem(loginWithTOTP("Demo", uri))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	code, err := svc.GenerateTOTP(created.ID)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if code.Type != "hotp" {
		t.Errorf("expected hotp type from URI, got %q", code.Type)
	}
	if code.Code != "254676" {
		t.Errorf("expected RFC counter=5 vector 254676, got %q", code.Code)
	}
}

// ---------------------------------------------------------------------------
// 三、Steam Guard 测试
// ---------------------------------------------------------------------------

// steamCharSet 是 Steam Guard 验证码的合法字符集
//
// 来自 pquerna/otp v1.5.0 hotp.go 第 124 行 EncoderSteam 实现的字母表：
//
//	2 3 4 5 6 7 8 9 B C D F G H J K M N P Q R T V W X Y
//
// 缺 0/1/A/E/I/L/O/S/U/Z 是为了避免和数字 / 视觉混淆。
const steamCharSet = "23456789BCDFGHJKMNPQRTVWXY"

// TestSteamGuard_OutputFormat 验证 Steam 编码输出形态：5 位 + 字符集合法
//
// 不能像 RFC 4226 那样写"绝对码"测试 —— Steam Guard 的算法是基于当前
// 时间的，没有官方公布的固定测试向量；我们退而求其次，验证：
//   1. 长度是 5（Steam 官方）
//   2. 每个字符都来自 Steam 字母表
//   3. type 字段标记为 steam
//   4. Period/Remaining 仍然有意义（Steam 是基于时间的）
func TestSteamGuard_OutputFormat(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	created, err := svc.CreateItem(steamItem("Steam", "JBSWY3DPEHPK3PXP"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	code, err := svc.GenerateTOTP(created.ID)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(code.Code) != 5 {
		t.Errorf("expected 5-char Steam code, got %q (len=%d)", code.Code, len(code.Code))
	}
	for i, r := range code.Code {
		if !strings.ContainsRune(steamCharSet, r) {
			t.Errorf("char %d %q not in Steam alphabet", i, r)
		}
	}
	if code.Type != "steam" {
		t.Errorf("expected type=steam, got %q", code.Type)
	}
	if code.Period != 30 {
		t.Errorf("Steam should use 30s period, got %d", code.Period)
	}
	if code.Remaining < 1 || code.Remaining > 30 {
		t.Errorf("remaining out of range: %d", code.Remaining)
	}
}

// TestSteamGuard_Determinism 同一密钥 + 同一时间窗口必须出同一码
//
// 验证算法的确定性 —— 测试基于 computeOTP 直接喂参数，绕开 time.Now()
// 不确定性。
func TestSteamGuard_Determinism(t *testing.T) {
	// 固定时间点：2026-01-01 12:00:00 UTC
	// 这个时间落在 [floor(t/30)*30, ...) 周期内，computeOTP 内部按这个
	// 时间点计算 Steam 码，相同输入应当产生相同输出
	fixed := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	params := &otpParams{
		Type:      OTPTypeSteam,
		Secret:    "JBSWY3DPEHPK3PXP",
		Algorithm: otp.AlgorithmSHA1,
		Digits:    5,
		Period:    30,
		Encoder:   otp.EncoderSteam,
	}
	code1, err := computeOTP(params, fixed)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	code2, err := computeOTP(params, fixed)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if code1.Code != code2.Code {
		t.Errorf("non-deterministic Steam output: %q vs %q", code1.Code, code2.Code)
	}
	if len(code1.Code) != 5 {
		t.Errorf("expected 5-char code, got %q", code1.Code)
	}
}

// TestSteamGuard_FromIssuerHint 从 otpauth://totp + issuer=Steam 隐式推断
//
// Steam 官方 Mobile Authenticator 导出的 URI 是 totp 类型 + issuer=Steam，
// 没有显式的 steam 类型。我们在 parseOtpauthURI 里做了这个推断。
func TestSteamGuard_FromIssuerHint(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	uri := "otpauth://totp/Steam:alex?secret=JBSWY3DPEHPK3PXP&issuer=Steam"
	created, err := svc.CreateItem(loginWithTOTP("Steam", uri))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	code, err := svc.GenerateTOTP(created.ID)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if code.Type != "steam" {
		t.Errorf("expected steam from issuer hint, got %q", code.Type)
	}
	if len(code.Code) != 5 {
		t.Errorf("expected 5-char Steam code, got %q", code.Code)
	}
	steamRe := regexp.MustCompile(`^[` + steamCharSet + `]{5}$`)
	if !steamRe.MatchString(code.Code) {
		t.Errorf("Steam code does not match alphabet regex: %q", code.Code)
	}
}

// TestSteamGuard_ExplicitOtpauthSteamScheme 直接 otpauth://steam/ 形态
func TestSteamGuard_ExplicitOtpauthSteamScheme(t *testing.T) {
	parsed := parseOTPSecret("otpauth://steam/Steam:alex?secret=JBSWY3DPEHPK3PXP")
	if parsed.Type != OTPTypeSteam {
		t.Errorf("expected steam from steam scheme, got %q", parsed.Type)
	}
	if parsed.Secret != "JBSWY3DPEHPK3PXP" {
		t.Errorf("secret mismatch: %q", parsed.Secret)
	}
}

// ---------------------------------------------------------------------------
// 四、参数解析与默认值覆盖
// ---------------------------------------------------------------------------

// TestExtractOTPParams_Defaults 默认参数：totp / SHA1 / 6 / 30
func TestExtractOTPParams_Defaults(t *testing.T) {
	p, err := extractOTPParams(map[string]any{
		"totp": "JBSWY3DPEHPK3PXP",
	})
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if p.Type != OTPTypeTOTP {
		t.Errorf("expected default type=totp, got %q", p.Type)
	}
	if p.Algorithm != otp.AlgorithmSHA1 {
		t.Errorf("expected SHA1, got %v", p.Algorithm)
	}
	if p.Digits != otp.DigitsSix {
		t.Errorf("expected digits=6, got %d", p.Digits)
	}
	if p.Period != 30 {
		t.Errorf("expected period=30, got %d", p.Period)
	}
}

// TestExtractOTPParams_FieldsOverride 显式 fields 配置覆盖默认值
func TestExtractOTPParams_FieldsOverride(t *testing.T) {
	p, err := extractOTPParams(map[string]any{
		"totp":          "JBSWY3DPEHPK3PXP",
		"otp_algorithm": "SHA256",
		"otp_digits":    float64(8),
		"otp_period":    float64(60),
	})
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if p.Algorithm != otp.AlgorithmSHA256 {
		t.Errorf("expected SHA256, got %v", p.Algorithm)
	}
	if p.Digits != 8 {
		t.Errorf("expected digits=8, got %d", p.Digits)
	}
	if p.Period != 60 {
		t.Errorf("expected period=60, got %d", p.Period)
	}
}

// TestExtractOTPParams_URIOverride otpauth URI 中的元信息被解析
func TestExtractOTPParams_URIOverride(t *testing.T) {
	uri := "otpauth://totp/X:y?secret=JBSWY3DPEHPK3PXP&algorithm=SHA512&digits=8&period=60"
	p, err := extractOTPParams(map[string]any{"totp": uri})
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if p.Algorithm != otp.AlgorithmSHA512 {
		t.Errorf("expected SHA512, got %v", p.Algorithm)
	}
	if p.Digits != 8 {
		t.Errorf("expected digits=8, got %d", p.Digits)
	}
	if p.Period != 60 {
		t.Errorf("expected period=60, got %d", p.Period)
	}
}

// TestExtractOTPParams_FieldsBeatURI fields 显式配置优先于 URI
//
// 用户场景：从某服务粘贴 URI 后又在编辑表单里手动改了 algorithm，
// 应当以表单为准。
func TestExtractOTPParams_FieldsBeatURI(t *testing.T) {
	uri := "otpauth://totp/X:y?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6"
	p, err := extractOTPParams(map[string]any{
		"totp":          uri,
		"otp_algorithm": "SHA512",
		"otp_digits":    float64(8),
	})
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if p.Algorithm != otp.AlgorithmSHA512 {
		t.Errorf("fields override failed: got %v", p.Algorithm)
	}
	if p.Digits != 8 {
		t.Errorf("fields override failed: got %d", p.Digits)
	}
}

// TestExtractOTPParams_HOTPCounterFromString 字符串形式的 counter
//
// 前端 form input 拿到的可能是字符串，readNumeric 应该宽容处理
func TestExtractOTPParams_HOTPCounterFromString(t *testing.T) {
	p, err := extractOTPParams(map[string]any{
		"totp":         "JBSWY3DPEHPK3PXP",
		"otp_type":     "hotp",
		"hotp_counter": "42",
	})
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if p.Type != OTPTypeHOTP {
		t.Errorf("expected hotp, got %q", p.Type)
	}
	if p.Counter != 42 {
		t.Errorf("expected counter=42, got %d", p.Counter)
	}
}

// TestNormalizeTOTPSecret 旧 API 兼容：覆盖各种密钥输入形态
func TestNormalizeTOTPSecret(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain-base32", "JBSWY3DPEHPK3PXP", "JBSWY3DPEHPK3PXP"},
		{"lowercase", "jbswy3dpehpk3pxp", "JBSWY3DPEHPK3PXP"},
		{"grouped-spaces", "JBSW Y3DP EHPK 3PXP", "JBSWY3DPEHPK3PXP"},
		{"trailing-padding", "JBSWY3DPEHPK3PXP=", "JBSWY3DPEHPK3PXP"},
		{"messy-whitespace", "\t JBSW\nY3DP\tEHPK 3PXP\r\n==", "JBSWY3DPEHPK3PXP"},
		{"empty", "", ""},
		{
			"otpauth-github",
			"otpauth://totp/GitHub:ZeroHawkeye?secret=CZBZTDBU5ADOXZ23&issuer=GitHub",
			"CZBZTDBU5ADOXZ23",
		},
		{
			"otpauth-google",
			"otpauth://totp/Example:alex@example.com?secret=jbswy3dpehpk3pxp&issuer=Example&algorithm=SHA1&digits=6&period=30",
			"JBSWY3DPEHPK3PXP",
		},
		{
			"otpauth-uppercase-scheme",
			"OTPAUTH://totp/x?secret=JBSWY3DPEHPK3PXP",
			"JBSWY3DPEHPK3PXP",
		},
		{
			"otpauth-no-secret",
			"otpauth://totp/X?issuer=GitHub",
			"",
		},
		{
			"otpauth-hotp",
			"otpauth://hotp/X:y?secret=JBSWY3DPEHPK3PXP&counter=5",
			"JBSWY3DPEHPK3PXP",
		},
	}
	for _, c := range cases {
		got := normalizeTOTPSecret(c.in)
		if got != c.want {
			t.Errorf("[%s] normalize(%q) = %q, want %q",
				c.name, strings.ReplaceAll(c.in, "\n", "\\n"), got, c.want)
		}
	}
}

// TestParseOtpauthURI_AllFields 验证所有 URI 字段都能被解析
func TestParseOtpauthURI_AllFields(t *testing.T) {
	uri := "otpauth://hotp/Acme:bob?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=8&period=60&counter=42&issuer=Acme"
	p := parseOTPSecret(uri)

	if p.Secret != "JBSWY3DPEHPK3PXP" {
		t.Errorf("secret: got %q", p.Secret)
	}
	if p.Type != OTPTypeHOTP {
		t.Errorf("type: got %q", p.Type)
	}
	if p.Algorithm != otp.AlgorithmSHA256 {
		t.Errorf("algorithm: got %v", p.Algorithm)
	}
	if p.Digits != 8 {
		t.Errorf("digits: got %d", p.Digits)
	}
	if !p.DigitsExplicit {
		t.Errorf("DigitsExplicit should be true")
	}
	if p.Period != 60 {
		t.Errorf("period: got %d", p.Period)
	}
	if p.Counter != 42 || !p.HasCounter {
		t.Errorf("counter: got %d (has=%v)", p.Counter, p.HasCounter)
	}
}

// TestReadNumeric 数值字段的多种形态宽容解析
func TestReadNumeric(t *testing.T) {
	cases := []struct {
		in   any
		want int64
		ok   bool
	}{
		{float64(42), 42, true},
		{float32(42), 42, true},
		{int(42), 42, true},
		{int64(42), 42, true},
		{uint64(42), 42, true},
		{"42", 42, true},
		{"  42 ", 42, true},
		{"abc", 0, false},
		{nil, 0, false},
		{[]byte("42"), 0, false},
	}
	for i, c := range cases {
		got, ok := readNumeric(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("case[%d] readNumeric(%v) = (%d, %v), want (%d, %v)",
				i, c.in, got, ok, c.want, c.ok)
		}
	}
}

// ---------------------------------------------------------------------------
// 五、修复回归测试 —— 防止 review 中发现的 bug 复现
// ---------------------------------------------------------------------------

// TestAdvanceHOTPCounter_ConcurrentSafety 并发推进必须严格累加，不能跳号
//
// Bug 背景：早期实现没有 hotpAdvanceMu，N 个并发 Advance 同一 itemID 时，
// 各自读到旧 counter=0，各自计算 +1=1 写回 —— 计数器实际只前进 1 而非 N。
// 这会让 HOTP 客户端与服务端 counter 失同步，最坏情况账号锁定。
//
// 本测试启动 16 个 goroutine 同时 Advance，期望最终 counter 严格等于 16。
// 任何小于 16 的值都说明 read-modify-write 不是原子的。
func TestAdvanceHOTPCounter_ConcurrentSafety(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	created, err := svc.CreateItem(hotpItem("YubiKey", rfc4226TestSecret, 0))
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	const goroutines = 32
	var wg sync.WaitGroup
	errs := make(chan error, goroutines)

	// 用 channel 作为 barrier，确保所有 goroutine 在同一瞬间释放，
	// 最大化并发触发竞态的概率。如果只是简单 go func() 启动，
	// 由于 goroutine 创建本身有微小延迟，第一个 G 可能已经走完整个
	// Advance 才轮到第二个 G 启动，竞态窗口被错过。
	start := make(chan struct{})
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			<-start
			if _, err := svc.AdvanceHOTPCounter(created.ID); err != nil {
				errs <- err
			}
		}()
	}
	close(start) // 同时释放所有 goroutine
	wg.Wait()
	close(errs)

	for err := range errs {
		t.Errorf("concurrent advance failed: %v", err)
	}

	// 取最终持久化的 counter，必须严格等于 goroutines
	got, err := svc.GetItem(created.ID)
	if err != nil {
		t.Fatalf("get final: %v", err)
	}
	finalCounter, ok := readNumeric(got.Fields["hotp_counter"])
	if !ok {
		t.Fatalf("counter not numeric: %v", got.Fields["hotp_counter"])
	}
	if finalCounter != int64(goroutines) {
		t.Errorf("expected counter=%d after %d concurrent advances, got %d (race detected)",
			goroutines, goroutines, finalCounter)
	}
}

// TestExtractOTPParams_SteamWithGarbageDigits Steam + 非法 otp_digits 字符串
//
// Bug 背景：旧实现里判断 `_, hasDigits := fields["otp_digits"]` 仅看 key 是否
// 存在，没看值是否合法。如果用户在自定义字段里写 "abc"：
//   - readNumeric("abc") 失败，p.Digits 不被修改（保持 6）
//   - hasDigits == true（key 存在）→ 跳过 Steam 5 位回填
//   - 最终 Steam 输出 6 位 → 服务端拒绝
//
// 修复后应当把"非法值"视同"未提供"，回退 Steam 5 位默认。
func TestExtractOTPParams_SteamWithGarbageDigits(t *testing.T) {
	p, err := extractOTPParams(map[string]any{
		"totp":       "JBSWY3DPEHPK3PXP",
		"otp_type":   "steam",
		"otp_digits": "abc", // 非法字符串
	})
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if p.Type != OTPTypeSteam {
		t.Fatalf("expected steam, got %q", p.Type)
	}
	if p.Digits != 5 {
		t.Errorf("expected Steam to fall back to 5 digits when otp_digits is invalid, got %d", p.Digits)
	}
}

// TestExtractOTPParams_NegativeCounter 负数 counter 必须被拒绝
//
// Bug 背景：readNumeric 返回 int64，旧实现直接 uint64(d)，d=-1 → 巨大正数。
// 下次 Advance 溢出回绕到 0，相当于"用户输入 -1 让计数器倒退"。
//
// 修复后：负数视同未提供，保持默认 counter=0。
func TestExtractOTPParams_NegativeCounter(t *testing.T) {
	p, err := extractOTPParams(map[string]any{
		"totp":         "JBSWY3DPEHPK3PXP",
		"otp_type":     "hotp",
		"hotp_counter": float64(-1),
	})
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if p.Counter != 0 {
		t.Errorf("expected negative counter to be rejected (counter=0), got %d", p.Counter)
	}
}

// TestComputeOTP_RejectsUnknownType 未知 OTP 类型必须显式报错
//
// 防御性测试：直接构造 otpParams 喂未知类型，确保 computeOTP 不会静默
// fallback 到 TOTP 分支生成错误验证码。
func TestComputeOTP_RejectsUnknownType(t *testing.T) {
	params := &otpParams{
		Type:      OTPType("yubikey-otp"), // 假设的未来类型
		Secret:    "JBSWY3DPEHPK3PXP",
		Algorithm: otp.AlgorithmSHA1,
		Digits:    otp.DigitsSix,
		Period:    30,
	}
	_, err := computeOTP(params, time.Unix(0, 0))
	if err == nil {
		t.Fatal("expected error for unknown otp type, got nil")
	}
	if !strings.Contains(err.Error(), "unsupported otp type") {
		t.Errorf("expected error to mention 'unsupported otp type', got %q", err.Error())
	}
}
