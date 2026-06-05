package services

// OTP 一次性密码生成 —— ZPass 桌面客户端
// ---------------------------------------------------------------------------
// 把 RFC 6238 (TOTP) / RFC 4226 (HOTP) / Steam Guard 三类一次性验证码算法
// 封装成 VaultService 上的方法，让前端能直接拿到「当前验证码 + 元信息」，
// 而不必把密钥（base32 secret）暴露到前端进程内存里自己计算。
//
// 设计原则：
//
//   1. **密钥不离后端**：OTP secret 与 vault 密码同等敏感，前端只拿
//      n 位（默认 6）一次性码 + 倒计时秒数 / 计数器，密钥始终留在 Go
//      进程，与 DEK 同生命周期。
//
//   2. **复用 vault 加解密管道**：直接调 GetItem 拿解密后的 ItemPayload，
//      不重写解密逻辑；锁定状态下自动走 ErrVaultLocked 分支。
//
//   3. **同时支持 login 与 totp 两种条目**：
//      - ItemTypeLogin: 取 fields["totp"]
//      - ItemTypeTOTP : 取 fields["totp"]
//      其它类型一律返回 ErrTOTPSecretMissing。
//
//   4. **三种 OTP 算法分流**（由 fields["otp_type"] 决定）：
//      - "totp"（默认，未填或未识别均走此分支）：基于时间窗口
//      - "hotp"：基于计数器（fields["hotp_counter"]）
//      - "steam"：Steam Guard，5 位字母数字字符表，基于时间窗口
//
//   5. **宽容输入**：很多服务给的 secret 带空格 / 小写 / 含 padding，
//      做一次 strings.ToUpper + 去空格 + 去等号填充再喂给 otp 库。
//      otpauth:// URI 会被解析成"密钥 + 元信息"二元组，URI 里的
//      type/algorithm/digits/period/counter 参数都会被读取。
//
//   6. **算法默认值**：SHA1 / 30 秒周期 / 6 位数字 —— 与 RFC 6238、
//      Google Authenticator / Authy / 1Password 默认一致，覆盖 99% 场景。
//      Steam Guard 默认值：SHA1 / 30 秒 / 5 位 / Steam 字母表。

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/hotp"
	"github.com/pquerna/otp/totp"
)

// ---------------------------------------------------------------------------
// 类型与错误
// ---------------------------------------------------------------------------

// OTPType 一次性密码算法类型
//
// 取值：
//   - OTPTypeTOTP  ："totp"  时间型（默认）
//   - OTPTypeHOTP  ："hotp"  计数器型
//   - OTPTypeSteam ："steam" Steam Guard（5 位字母数字）
type OTPType string

const (
	OTPTypeTOTP  OTPType = "totp"
	OTPTypeHOTP  OTPType = "hotp"
	OTPTypeSteam OTPType = "steam"
)

// TOTPCode 是 GenerateTOTP / AdvanceHOTPCounter 返回给前端的「当前 OTP 快照」
//
// 字段语义：
//   - Code      ：n 位 OTP 字符串（TOTP/HOTP 为数字，Steam 为字母数字混合）
//   - Type      ：算法类型 ("totp" / "hotp" / "steam")
//   - Period    ：TOTP/Steam 的周期总秒数（HOTP 此字段为 0）
//   - Remaining ：TOTP/Steam 当前周期剩余秒数（HOTP 此字段为 0）
//   - Counter   ：HOTP 当前计数器值（TOTP/Steam 此字段为 0）
//   - Algorithm ：哈希算法名（"SHA1"/"SHA256"/"SHA512"）
//   - Digits    ：OTP 位数（TOTP 默认 6，Steam 默认 5）
//
// 字段名沿用 TOTPCode 是为了向后兼容前端 bindings：原本只有 TOTP 时这个
// 结构体的字段恰好够用；新增 HOTP/Steam 后只是补字段而非改字段。
type TOTPCode struct {
	Code      string `json:"code"`
	Type      string `json:"type"`
	Period    int    `json:"period"`
	Remaining int    `json:"remaining"`
	Counter   uint64 `json:"counter"`
	Algorithm string `json:"algorithm"`
	Digits    int    `json:"digits"`
}

// ErrTOTPSecretMissing 条目存在但没有可用的 OTP secret 字段
//
// 触发场景：
//   - 该条目类型既不是 login 也不是 totp
//   - 是 login 但 fields["totp"] 为空字符串
//   - 是 totp 但 fields["totp"] 为空字符串
//
// 前端见此错误应让用户回到编辑表单补充 OTP 密钥。
//
// 注：错误命名保留 "TOTP" 前缀是为了向后兼容 vault-api 错误识别逻辑，
// 实际语义是"OTP 密钥缺失"，不区分具体算法。
var ErrTOTPSecretMissing = errors.New("totp secret not set on this item")

// ErrTOTPSecretInvalid OTP 密钥格式不合法（base32 解码失败 / 空 / 字符非法）
//
// 与 ErrTOTPSecretMissing 区分开：前者代表「字段没填」，本错误代表
// 「字段填了但不是合法 base32」，UI 提示文案应不同。
var ErrTOTPSecretInvalid = errors.New("totp secret is not a valid base32 string")

// ErrOTPTypeMismatch 调用 AdvanceHOTPCounter 但条目不是 hotp 类型
//
// 用户在 UI 上点"下一个码"按钮触发，仅 HOTP 条目允许该操作；
// TOTP/Steam 是基于时间的，不需要也不应该手动推进。
var ErrOTPTypeMismatch = errors.New("operation only valid for hotp items")

// ---------------------------------------------------------------------------
// otpParams：从条目字段中提取出的 OTP 计算参数
// ---------------------------------------------------------------------------

// otpParams 是把 ItemPayload.Fields 解析成"算法可用的参数集合"的中间结构
//
// 设计目的：
//   - 把 fields map 里那些可选键（otp_type/hotp_counter/otp_digits/...）
//     的解析与默认值填充集中处理，避免分散在每个分支里
//   - 让 GenerateTOTP / AdvanceHOTPCounter 共用一份"读字段 → 参数"逻辑
//
// 字段语义：
//   - Type      ：OTP 类型（默认 totp）
//   - Secret    ：规范化后的 base32 密钥（已去空格/转大写/去 padding）
//   - Algorithm ：哈希算法（默认 SHA1）
//   - Digits    ：位数（TOTP 默认 6，Steam 默认 5）
//   - Period    ：周期秒数（默认 30，HOTP 不使用）
//   - Counter   ：HOTP 计数器（仅 hotp 使用，默认 0）
//   - Encoder   ：编码器（Steam 用 EncoderSteam，其它用 EncoderDefault）
type otpParams struct {
	Type      OTPType
	Secret    string
	Algorithm otp.Algorithm
	Digits    otp.Digits
	Period    int
	Counter   uint64
	Encoder   otp.Encoder
}

// extractOTPParams 从 ItemPayload.Fields 提取并规范化 OTP 计算参数
//
// 规则：
//   - fields["totp"] 必须存在且非空，且支持 otpauth:// URI（解析后会覆盖
//     URI 中的 type/algorithm/digits/period/counter 显式参数）
//   - fields["otp_type"] 显式覆盖 URI 中的类型（手动配置优先于 URI）
//   - 其它字段（otp_digits/otp_period/otp_algorithm/hotp_counter）同理
//
// 解析顺序：
//  1. 先建立默认值（totp / SHA1 / 6 / 30 / counter=0）
//  2. 如果 secret 字段是 otpauth:// URI，解析 URI 覆盖默认值
//  3. fields 显式字段（otp_type/...）再次覆盖（用户在编辑表单上明确配置）
//  4. 根据最终 type 调整 Steam 的默认 5 位 + Steam encoder
func extractOTPParams(fields map[string]any) (*otpParams, error) {
	rawSecret, _ := fields["totp"].(string)
	if strings.TrimSpace(rawSecret) == "" {
		return nil, ErrTOTPSecretMissing
	}

	// 默认参数 —— 与 RFC 6238 / Google Authenticator 默认一致
	p := &otpParams{
		Type:      OTPTypeTOTP,
		Algorithm: otp.AlgorithmSHA1,
		Digits:    otp.DigitsSix,
		Period:    30,
		Counter:   0,
		Encoder:   otp.EncoderDefault,
	}

	// 第一步：解析 secret，可能是 otpauth:// URI 或裸 base32
	parsed := parseOTPSecret(rawSecret)
	if parsed.Secret == "" {
		// secret 非空但解析后为空 —— 例如 "otpauth://" 但没 secret 参数
		return nil, ErrTOTPSecretMissing
	}
	p.Secret = parsed.Secret

	// URI 中的元信息覆盖默认值（如果 URI 没带这些参数则保持默认）
	if parsed.Type != "" {
		p.Type = parsed.Type
	}
	if parsed.Algorithm != 0 {
		p.Algorithm = parsed.Algorithm
	}
	if parsed.Digits != 0 {
		p.Digits = parsed.Digits
	}
	if parsed.Period > 0 {
		p.Period = parsed.Period
	}
	if parsed.HasCounter {
		p.Counter = parsed.Counter
	}

	// 第二步：fields 中的显式配置覆盖 URI（用户编辑表单的优先级最高）
	if v, ok := fields["otp_type"].(string); ok && v != "" {
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "totp":
			p.Type = OTPTypeTOTP
		case "hotp":
			p.Type = OTPTypeHOTP
		case "steam":
			p.Type = OTPTypeSteam
		}
	}
	if v, ok := fields["otp_algorithm"].(string); ok && v != "" {
		if alg, ok := parseAlgorithm(v); ok {
			p.Algorithm = alg
		}
	}
	// 标记 fields 是否提供了「合法的」digits 值 —— 注意必须是「合法」
	// 而非「字段存在」：用户在自定义字段里输入 "abc" 这种非数字时，
	// fields["otp_digits"] 存在但 readNumeric 失败，应当**回退**到 URI
	// 或默认值，而不是错误地认为用户配置了 digits 而跳过 Steam 5 位回填。
	hasValidDigits := false
	if d, ok := readNumeric(fields["otp_digits"]); ok && d > 0 && d <= 10 {
		p.Digits = otp.Digits(d)
		hasValidDigits = true
	}
	if d, ok := readNumeric(fields["otp_period"]); ok && d > 0 {
		p.Period = int(d)
	}
	if d, ok := readNumeric(fields["hotp_counter"]); ok {
		// 拒绝负数 counter —— readNumeric 返回 int64，直接强转 uint64 会让
		// 负数变成接近 uint64.MaxValue 的巨大正数，下次 Advance 溢出回绕到
		// 0，导致计数器实际倒退。这种输入只可能来自用户手动 JSON 编辑或
		// 自定义字段误输入，全部按"忽略"处理（保持默认 0）。
		if d >= 0 {
			p.Counter = uint64(d)
		}
	}

	// 第三步：根据最终类型调整 encoder 与 Steam 的默认 5 位
	if p.Type == OTPTypeSteam {
		p.Encoder = otp.EncoderSteam
		// Steam 官方使用 5 位；只有当用户既没在 fields 也没在 URI 显式提供
		// 合法的 digits 时，才回填 5 位。
		// （pquerna/otp 的 Steam 编码会按 Digits 长度截断输出。如果走 6 位
		//  Steam 服务端会拒绝，所以这个回退非常关键。）
		if !hasValidDigits && !parsed.DigitsExplicit {
			p.Digits = 5
		}
	}

	return p, nil
}

// readNumeric 把 fields map 里可能是 float64/int/string 的数值字段读出来
//
// JSON 反序列化时数字默认是 float64；但内存中直接构造时也可能是 int 或
// 用户编辑表单可能传字符串。三种形态统一处理，简化上游分支。
func readNumeric(v any) (int64, bool) {
	switch x := v.(type) {
	case float64:
		return int64(x), true
	case float32:
		return int64(x), true
	case int:
		return int64(x), true
	case int64:
		return x, true
	case uint64:
		return int64(x), true
	case string:
		if n, err := strconv.ParseInt(strings.TrimSpace(x), 10, 64); err == nil {
			return n, true
		}
	}
	return 0, false
}

// parseAlgorithm 把字符串映射到 otp.Algorithm 枚举（大小写不敏感）
func parseAlgorithm(s string) (otp.Algorithm, bool) {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case "SHA1":
		return otp.AlgorithmSHA1, true
	case "SHA256":
		return otp.AlgorithmSHA256, true
	case "SHA512":
		return otp.AlgorithmSHA512, true
	}
	return 0, false
}

// algorithmName 把 otp.Algorithm 枚举翻译回字符串（输出给前端）
func algorithmName(a otp.Algorithm) string {
	switch a {
	case otp.AlgorithmSHA256:
		return "SHA256"
	case otp.AlgorithmSHA512:
		return "SHA512"
	default:
		return "SHA1"
	}
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

// GenerateTOTP 计算指定条目当前的一次性验证码
//
// 函数名保留 GenerateTOTP 是为了向后兼容前端 Wails bindings；实际内部
// 会根据 fields["otp_type"] 分流到 TOTP / HOTP / Steam 三种算法。
//
// 流程：
//  1. 参数校验 —— itemID 不能为空
//  2. 通过 GetItem 拿到解密后的 ItemPayload（自动走读锁 + DEK 检查）
//  3. 校验类型：必须是 login 或 totp
//  4. extractOTPParams 解析 fields → otpParams
//  5. 根据 params.Type 调用对应算法（TOTP/HOTP/Steam）
//  6. 组装 TOTPCode 快照返回
//
// 错误：
//   - 条目不存在        → 包装的 GetItem 错误（前端按 not-found 处理）
//   - 条目锁定          → ErrVaultLocked
//   - 类型不支持        → ErrTOTPSecretMissing
//   - secret 字段为空   → ErrTOTPSecretMissing
//   - secret 不是 base32 → ErrTOTPSecretInvalid
func (s *VaultService) GenerateTOTP(itemID string) (*TOTPCode, error) {
	if itemID == "" {
		return nil, errors.New("item id cannot be empty")
	}

	// GetItem 内部已经做读锁 + DEK 检查 + AAD 校验，复用即可
	payload, err := s.GetItem(itemID)
	if err != nil {
		return nil, err
	}
	if payload == nil {
		return nil, ErrItemNotFound
	}

	// 仅 login / totp 两类条目允许携带 OTP 字段
	if payload.Type != ItemTypeLogin && payload.Type != ItemTypeTOTP {
		return nil, ErrTOTPSecretMissing
	}

	params, err := extractOTPParams(payload.Fields)
	if err != nil {
		return nil, err
	}

	return computeOTP(params, time.Now())
}

// AdvanceHOTPCounter 把 HOTP 条目的计数器 +1 并返回新生成的验证码
//
// 触发场景：用户在 UI 上点击"获取下一个码"按钮（HOTP 不像 TOTP 会自动
// 滚动，必须用户主动推进）。本方法保证「读 → +1 → 写 → 出码」全程
// 持有写锁，避免并发触发重复消费同一计数器。
//
// 注意：HOTP 的服务端计数器允许"前进容差"（look-ahead window，通常 ±10），
// 因此即使客户端偶尔多按一次按钮，下次登录时只要计数器没超出 look-ahead
// 范围仍可被服务端接受。但 ZPass 内部不做"未提交码"的回滚 —— 计数器一旦
// 推进就持久化，简化逻辑。
//
// 错误：
//   - 条目不存在 / 锁定 → 同 GenerateTOTP
//   - 条目不是 hotp 类型 → ErrOTPTypeMismatch
//   - secret 缺失/无效  → ErrTOTPSecretMissing / ErrTOTPSecretInvalid
func (s *VaultService) AdvanceHOTPCounter(itemID string) (*TOTPCode, error) {
	if itemID == "" {
		return nil, errors.New("item id cannot be empty")
	}

	// 串行化「读 counter → +1 → 写回 → 出码」全流程
	//
	// 不加锁的后果（已被早期 review 发现）：两个并发 Advance 同一 itemID 都
	// 读到 counter=N，各自 +1 写入 N+1 —— 计数器实际只前进 1，下次登录
	// 服务端拒绝（counter 比服务端记录少 1，HOTP 失同步）。10 次连续并发
	// 还可能直接超出服务端 look-ahead window 导致账号锁定。
	//
	// 锁层级：hotpAdvanceMu > s.mu。本函数持 hotpAdvanceMu 期间，内部的
	// GetItem / UpdateItem 仍各自管理 s.mu —— 因为 sync.Mutex 不可重入，
	// 不能在持有 s.mu 时再调它们。详见 VaultService.hotpAdvanceMu 注释。
	s.hotpAdvanceMu.Lock()
	defer s.hotpAdvanceMu.Unlock()

	payload, err := s.GetItem(itemID)
	if err != nil {
		return nil, err
	}
	if payload == nil {
		return nil, ErrItemNotFound
	}
	if payload.Type != ItemTypeLogin && payload.Type != ItemTypeTOTP {
		return nil, ErrTOTPSecretMissing
	}

	params, err := extractOTPParams(payload.Fields)
	if err != nil {
		return nil, err
	}
	if params.Type != OTPTypeHOTP {
		return nil, ErrOTPTypeMismatch
	}

	// 计数器先 +1 再生成 —— RFC 4226 §7.2 推荐"先递增计数器再使用"，
	// 服务端在验证时会接受 [counter, counter+lookAhead] 范围内的码。
	params.Counter++

	code, err := computeOTP(params, time.Now())
	if err != nil {
		return nil, err
	}

	// 把新计数器写回 fields，整体覆盖式更新
	if payload.Fields == nil {
		payload.Fields = map[string]any{}
	}
	payload.Fields["hotp_counter"] = float64(params.Counter)
	if _, err := s.UpdateItem(*payload); err != nil {
		return nil, fmt.Errorf("persist hotp counter: %w", err)
	}

	return code, nil
}

// computeOTP 是核心算法分流：根据 params.Type 调对应的 pquerna/otp 子包
//
// 拆出来是为了让 GenerateTOTP / AdvanceHOTPCounter 共用同一段算法逻辑，
// 也方便单测直接喂参数验证算法正确性，而不必构造完整 vault。
func computeOTP(p *otpParams, now time.Time) (*TOTPCode, error) {
	switch p.Type {
	case OTPTypeHOTP:
		code, err := hotp.GenerateCodeCustom(p.Secret, p.Counter, hotp.ValidateOpts{
			Digits:    p.Digits,
			Algorithm: p.Algorithm,
		})
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrTOTPSecretInvalid, err)
		}
		return &TOTPCode{
			Code:      code,
			Type:      string(OTPTypeHOTP),
			Counter:   p.Counter,
			Algorithm: algorithmName(p.Algorithm),
			Digits:    int(p.Digits),
		}, nil

	case OTPTypeSteam:
		code, err := totp.GenerateCodeCustom(p.Secret, now, totp.ValidateOpts{
			Period:    uint(p.Period),
			Skew:      1,
			Digits:    p.Digits,
			Algorithm: p.Algorithm,
			Encoder:   otp.EncoderSteam,
		})
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrTOTPSecretInvalid, err)
		}
		remaining := p.Period - int(now.Unix()%int64(p.Period))
		return &TOTPCode{
			Code:      code,
			Type:      string(OTPTypeSteam),
			Period:    p.Period,
			Remaining: remaining,
			Algorithm: algorithmName(p.Algorithm),
			Digits:    int(p.Digits),
		}, nil

	case OTPTypeTOTP:
		code, err := totp.GenerateCodeCustom(p.Secret, now, totp.ValidateOpts{
			Period:    uint(p.Period),
			Skew:      1,
			Digits:    p.Digits,
			Algorithm: p.Algorithm,
		})
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrTOTPSecretInvalid, err)
		}
		remaining := p.Period - int(now.Unix()%int64(p.Period))
		return &TOTPCode{
			Code:      code,
			Type:      string(OTPTypeTOTP),
			Period:    p.Period,
			Remaining: remaining,
			Algorithm: algorithmName(p.Algorithm),
			Digits:    int(p.Digits),
		}, nil

	default:
		// 防御性分支：理论上 extractOTPParams 只会返回三种类型之一。
		// 走到这里意味着上层逻辑出了 bug（可能未来加了新枚举但忘了更新
		// 这里的 switch），显式报错而非静默走 TOTP，便于早期发现问题。
		return nil, fmt.Errorf("unsupported otp type: %q", p.Type)
	}
}

// ---------------------------------------------------------------------------
// 密钥规范化与 otpauth URI 解析
// ---------------------------------------------------------------------------

// otpURIParsed 解析 otpauth:// URI 后的结构化结果
//
// 字段语义：
//   - Secret         ：base32 密钥（必填，否则视为解析失败）
//   - Type           ：URI path 头部的算法类型（"totp"/"hotp"/"steam"，
//     若未识别则为空字符串，由调用方走默认 totp）
//   - Algorithm      ：URI ?algorithm=SHA1 等，0 表示未指定
//   - Digits         ：URI ?digits=6 等，0 表示未指定
//   - DigitsExplicit ：URI 是否显式给了 digits（用于区分"6 因为没填"和
//     "6 因为用户填了 6"，影响 Steam 默认 5 位的回退逻辑）
//   - Period         ：URI ?period=30 等，0 表示未指定
//   - Counter        ：URI ?counter=N（HOTP 必填）
//   - HasCounter     ：URI 是否显式给了 counter
type otpURIParsed struct {
	Secret         string
	Type           OTPType
	Algorithm      otp.Algorithm
	Digits         otp.Digits
	DigitsExplicit bool
	Period         int
	Counter        uint64
	HasCounter     bool
}

// parseOTPSecret 把用户输入的密钥字符串解析成"密钥 + 元信息"二元组
//
// 输入形态：
//
//  1. 裸 base32 字符串：JBSWY3DPEHPK3PXP
//  2. 带分组空格 / 大小写：jbsw y3dp ehpk 3pxp
//  3. 带 base32 padding：JBSWY3DPEHPK3PXP==
//  4. otpauth:// URI（标准 / Google Authenticator KeyUriFormat）：
//     otpauth://totp/Issuer:Account?secret=XXX&issuer=...&algorithm=SHA1&digits=6&period=30
//     otpauth://hotp/Issuer:Account?secret=XXX&counter=0&issuer=...
//     otpauth://totp/Steam:account?secret=XXX&issuer=Steam     (隐式 Steam，需 issuer=Steam 推断)
//
// 处理流程：
//   - 去掉首尾空白
//   - 若以 "otpauth://" 开头 → 用 net/url 解析所有支持参数
//   - 其它情况按裸 base32 处理：去全部空白 + 转大写 + 去尾部等号
//
// 解析失败一律退化到"返回 Secret 为空"，让上层走 ErrTOTPSecretMissing /
// ErrTOTPSecretInvalid 的统一错误路径，不在本函数里抛 error。
func parseOTPSecret(raw string) otpURIParsed {
	s := strings.TrimSpace(raw)
	if s == "" {
		return otpURIParsed{}
	}

	// otpauth:// URI 形态 —— 优先识别
	if len(s) >= 10 && strings.EqualFold(s[:10], "otpauth://") {
		return parseOtpauthURI(s)
	}

	// 裸 base32 规范化
	return otpURIParsed{Secret: normalizeBase32(s)}
}

// normalizeBase32 把裸密钥做 base32 规范化：
// 去全部空白与控制字符 + 转大写 + 去尾部 padding
func normalizeBase32(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, s)
	s = strings.ToUpper(s)
	s = strings.TrimRight(s, "=")
	return s
}

// parseOtpauthURI 解析 otpauth:// URI 提取密钥与所有可识别的元信息
//
// URI 格式：
//
//	otpauth://{type}/{label}?secret=BASE32&issuer=...&algorithm=...&digits=...&period=...&counter=...
//
//	type   ："totp" / "hotp" / "steam"（部分客户端会用 steam）
//	label  ：通常 "Issuer:Account"
//
// Steam 推断规则：
//   - URI path scheme 显式 "otpauth://steam/" → Steam
//   - URI path scheme 是 "totp" 但 issuer 查询参数为 "Steam" → Steam
//     （Steam Mobile Authenticator 导出的 URI 走这条路径）
func parseOtpauthURI(raw string) otpURIParsed {
	out := otpURIParsed{}

	u, err := url.Parse(raw)
	var values url.Values
	var typePath string
	if err == nil {
		values = u.Query()
		// u.Host 是 type 部分（"totp" / "hotp" / "steam"），
		// 但 net/url 在某些 URI 形态下会把 type 解析到 Host，某些放到 Path。
		// 优先用 Host，空时从原 URI 切片解析。
		typePath = strings.ToLower(u.Host)
	}

	// 降级：若 net/url 解析失败或 Host 为空，手动切 "otpauth://{type}/" 头
	if typePath == "" {
		// otpauth://__type__/...
		rest := raw[len("otpauth://"):]
		if idx := strings.IndexByte(rest, '/'); idx > 0 {
			typePath = strings.ToLower(rest[:idx])
		} else if idx := strings.IndexByte(rest, '?'); idx > 0 {
			typePath = strings.ToLower(rest[:idx])
		}
	}
	if values == nil {
		// 进一步降级解析 query
		if idx := strings.IndexByte(raw, '?'); idx >= 0 && idx+1 < len(raw) {
			if v, err := url.ParseQuery(raw[idx+1:]); err == nil {
				values = v
			}
		}
	}
	if values == nil {
		return out
	}

	// secret —— 必填
	out.Secret = normalizeBase32(values.Get("secret"))

	// 类型推断
	switch typePath {
	case "totp":
		out.Type = OTPTypeTOTP
		// Steam Mobile Authenticator 导出的 URI 是 totp 类型 + issuer=Steam，
		// 此时按 Steam Guard 处理（5 位字母数字）
		if strings.EqualFold(values.Get("issuer"), "Steam") {
			out.Type = OTPTypeSteam
		}
	case "hotp":
		out.Type = OTPTypeHOTP
	case "steam":
		out.Type = OTPTypeSteam
	}

	// algorithm
	if a := values.Get("algorithm"); a != "" {
		if alg, ok := parseAlgorithm(a); ok {
			out.Algorithm = alg
		}
	}

	// digits
	if d := values.Get("digits"); d != "" {
		if n, err := strconv.Atoi(d); err == nil && n > 0 && n <= 10 {
			out.Digits = otp.Digits(n)
			out.DigitsExplicit = true
		}
	}

	// period
	if p := values.Get("period"); p != "" {
		if n, err := strconv.Atoi(p); err == nil && n > 0 {
			out.Period = n
		}
	}

	// counter（HOTP 必填）
	if c := values.Get("counter"); c != "" {
		if n, err := strconv.ParseUint(c, 10, 64); err == nil {
			out.Counter = n
			out.HasCounter = true
		}
	}

	return out
}

// normalizeTOTPSecret 旧 API 兼容封装 —— 仅返回密钥字符串部分
//
// 保留是为了向后兼容已经存在的测试与可能的外部引用。新代码应直接用
// parseOTPSecret 拿到完整 otpURIParsed。
func normalizeTOTPSecret(raw string) string {
	return parseOTPSecret(raw).Secret
}
