package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strings"

	"golang.org/x/net/publicsuffix"
)

// domainMatchBlacklist — base domain 匹配黑名单（对齐 Bitwarden
// libs/common/src/platform/misc/utils.ts 中的 DomainMatchBlacklist）。
//
// 语义：key 是某个 registrable domain，其 value Set 里的 host 不能被当
// 作该 domain 的合法子域。典型例：script.google.com 的页面可以代理任意
// 账号，不应让保存为 google.com 的凭据被自动填在 script.google.com 上。
var domainMatchBlacklist = map[string]map[string]struct{}{
	"google.com": {"script.google.com": {}},
}

type nativeEnvelope struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type nativeResponse struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type pageContext struct {
	Origin string `json:"origin"`
	URL    string `json:"url"`
}

type revealLoginRequest struct {
	pageContext
	ItemID string `json:"itemId"`
}

type loginSummaryNative struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Username   string `json:"username"`
	DisplayURL string `json:"displayUrl"`
	UpdatedAt  int64  `json:"updatedAt"`
	// HasTotp 标记该条目是否带 OTP 秘钥。判定标准：fields["totp"] 非空字符串。
	HasTotp bool `json:"hasTotp"`
	// HasPassword 标记该条目是否有密码。判定标准：fields["password"] 非空。
	// 前端据此决定 popup 点击行为：
	//   - hasPassword + hasTotp → 填账密 + 自动复制 TOTP 到剪贴板
	//   - hasPassword only      → 填账密
	//   - hasTotp only          → 复制 TOTP 到剪贴板
	HasPassword bool `json:"hasPassword"`
	// ItemType 查询出的条目底层类型。queryLogins 现在同时收 ItemTypeLogin 和
	// ItemTypeTOTP（「独立身份验证器」），前端需要区分以选择图标 / 提示文案。
	// 取值与 desktop ItemType 一致："login" / "totp"。
	ItemType string `json:"itemType"`
}

type queryLoginsResult struct {
	Unlocked bool                 `json:"unlocked"`
	Origin   string               `json:"origin"`
	Items    []loginSummaryNative `json:"items"`
}

// loginSecretNative 是 revealLogin 返给扩展的完整凭据快照。
//
// 设计上与 Bitwarden Login cipher 对齐：username + password + totp 可同时存在于
// 同一个条目。任何一个可为空串（password）或 null（totp），前端按形态分流。
//
// Totp 为指针是为了 JSON 里用 null 表「未带 TOTP」，避免与「带但算失败」混淆（
// 后者未来可能加 Err 字段，现在静默 nil 同「未带」一致表现）。
type loginSecretNative struct {
	ID       string               `json:"id"`
	Name     string               `json:"name"`
	Username string               `json:"username"`
	Password string               `json:"password"`
	Totp     *loginTotpCodeNative `json:"totp,omitempty"`
}

// generateLoginTotpRequest 浏览器扩展请求生成指定 login 条目的 OTP 当前码。
//
// 与 revealLogin 同样做 origin 匹配检查：避免恶意页面通过扩展间接读取
// 其它站点的 TOTP。
type generateLoginTotpRequest struct {
	pageContext
	ItemID string `json:"itemId"`
}

// loginTotpCodeNative 是浏览器扩展拿到的 OTP 快照，字段语义与
// totpservice.TOTPCode 完全一致；这里独立结构是为了把 native bridge
// 协议与桌面前端 Wails binding 解耦（前者面向扩展，可独立演进）。
type loginTotpCodeNative struct {
	Code      string `json:"code"`
	Type      string `json:"type"`
	Period    int    `json:"period"`
	Remaining int    `json:"remaining"`
	Counter   uint64 `json:"counter"`
	Algorithm string `json:"algorithm"`
	Digits    int    `json:"digits"`
}

type passkeyListRequest struct {
	pageContext
	RPID string `json:"rpId"`
}

type passkeyListResult struct {
	Unlocked bool                          `json:"unlocked"`
	RPID     string                        `json:"rpId"`
	Items    []PasskeyCredentialDescriptor `json:"items"`
}

type passkeyCreateRequest struct {
	pageContext
	RPID            string `json:"rpId"`
	RPName          string `json:"rpName"`
	UserID          string `json:"userId"`
	UserName        string `json:"userName"`
	UserDisplayName string `json:"userDisplayName"`
	Name            string `json:"name"`
}

type passkeySignRequest struct {
	pageContext
	RPID           string `json:"rpId"`
	CredentialID   string `json:"credentialId"`
	ClientDataHash string `json:"clientDataHash"`
}

type passkeyDeleteRequest struct {
	pageContext
	RPID         string `json:"rpId"`
	ItemID       string `json:"itemId"`
	CredentialID string `json:"credentialId"`
}

type passkeyDeleteResult struct {
	Deleted bool   `json:"deleted"`
	ItemID  string `json:"itemId"`
}

func handleNativeVault(vault *VaultService, msg nativeEnvelope) nativeResponse {
	resp := nativeResponse{ID: msg.ID}
	result, err := dispatchNativeVault(vault, msg)
	if err != nil {
		resp.OK = false
		resp.Error = err.Error()
		return resp
	}
	resp.OK = true
	resp.Result = result
	return resp
}

func dispatchNativeVault(vault *VaultService, msg nativeEnvelope) (any, error) {
	switch msg.Type {
	case "status":
		return vault.Status()
	case "queryLogins":
		var ctx pageContext
		if err := json.Unmarshal(nonNullPayload(msg.Payload), &ctx); err != nil {
			return nil, errors.New("Invalid page context.")
		}
		return queryLogins(vault, ctx)
	case "revealLogin":
		var req revealLoginRequest
		if err := json.Unmarshal(nonNullPayload(msg.Payload), &req); err != nil {
			return nil, errors.New("Invalid reveal request.")
		}
		return revealLogin(vault, req)
	case "passkeyList":
		var req passkeyListRequest
		if err := json.Unmarshal(nonNullPayload(msg.Payload), &req); err != nil {
			return nil, errors.New("Invalid passkey list request.")
		}
		return nativeListPasskeys(vault, req)
	case "passkeyCreate":
		var req passkeyCreateRequest
		if err := json.Unmarshal(nonNullPayload(msg.Payload), &req); err != nil {
			return nil, errors.New("Invalid passkey create request.")
		}
		return nativeCreatePasskey(vault, req)
	case "passkeySign":
		var req passkeySignRequest
		if err := json.Unmarshal(nonNullPayload(msg.Payload), &req); err != nil {
			return nil, errors.New("Invalid passkey sign request.")
		}
		return nativeSignPasskey(vault, req)
	case "passkeyDelete":
		var req passkeyDeleteRequest
		if err := json.Unmarshal(nonNullPayload(msg.Payload), &req); err != nil {
			return nil, errors.New("Invalid passkey delete request.")
		}
		return nativeDeletePasskey(vault, req)
	case "generateLoginTotp":
		var req generateLoginTotpRequest
		if err := json.Unmarshal(nonNullPayload(msg.Payload), &req); err != nil {
			return nil, errors.New("Invalid totp request.")
		}
		return generateLoginTotp(vault, req)
	default:
		return nil, fmt.Errorf("Unknown native request: %s", msg.Type)
	}
}

func nonNullPayload(payload json.RawMessage) json.RawMessage {
	if len(bytes.TrimSpace(payload)) == 0 {
		return json.RawMessage(`{}`)
	}
	return payload
}

func queryLogins(vault *VaultService, ctx pageContext) (*queryLoginsResult, error) {
	origin, err := parseSafeOrigin(ctx)
	if err != nil {
		return nil, err
	}
	if !vault.IsUnlocked() {
		return &queryLoginsResult{Unlocked: false, Origin: origin.String(), Items: []loginSummaryNative{}}, nil
	}

	summaries, err := vault.ListItems()
	if err != nil {
		if errors.Is(err, ErrVaultLocked) {
			return &queryLoginsResult{Unlocked: false, Origin: origin.String(), Items: []loginSummaryNative{}}, nil
		}
		return nil, errors.New("Unable to read ZPass vault.")
	}

	items := make([]loginSummaryNative, 0)
	for _, summary := range summaries {
		// 同时收 login 和独立 TOTP 条目。与 Bitwarden 不同的是 ZPass 有独立的
		// ItemTypeTOTP（未关联账密的「身份验证器」条目）；Bitwarden 全部走 Login 类型。
		if summary.Type != ItemTypeLogin && summary.Type != ItemTypeTOTP {
			continue
		}
		item, err := vault.GetItem(summary.ID)
		if err != nil || item == nil || !itemMatchesOrigin(item, origin) {
			continue
		}
		items = append(items, loginSummaryNative{
			ID:          item.ID,
			Name:        item.Name,
			Username:    nativeFieldString(item.Fields, "username", "email", "login", "account"),
			DisplayURL:  firstDisplayURL(item.Fields),
			UpdatedAt:   item.UpdatedAt,
			HasTotp:     nativeFieldString(item.Fields, "totp") != "",
			HasPassword: nativeFieldString(item.Fields, "password") != "",
			ItemType:    string(item.Type),
		})
	}
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].UpdatedAt > items[j].UpdatedAt
	})
	return &queryLoginsResult{Unlocked: true, Origin: origin.String(), Items: items}, nil
}

// revealLogin 返回指定条目的明文账密 + （可选）当前 TOTP 码。
//
// 软化与旧版的区别：
//   - password 为空不再报错，返 password=""。前端据此决定是否填账密。
//     原因：源于「如果是独立 TOTP 条目 / 只存了 username 的 login」场景，
//     用户在 popup 点该条目应当能复制 TOTP 而不是看到报错。
//   - 同时返 TotpCode：有 totp 秘钥时现场算码，为 popup 「填充账密 + 自动
//     复制 TOTP」合并 1 次 RPC，减少往返。计算失败不阻断账密返回。
//
// 仍保留的校验：
//   - origin 必须合法 + 与条目 URL 匹配（PSL base domain）
//   - 条目类型必须是 Login 或 TOTP
func revealLogin(vault *VaultService, req revealLoginRequest) (*loginSecretNative, error) {
	origin, err := parseSafeOrigin(req.pageContext)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(req.ItemID) == "" {
		return nil, errors.New("Missing vault item id.")
	}
	item, err := vault.GetItem(req.ItemID)
	if err != nil {
		if errors.Is(err, ErrVaultLocked) {
			return nil, errors.New("Unlock ZPass Desktop to use autofill.")
		}
		return nil, errors.New("Unable to read this ZPass login.")
	}
	if item == nil || (item.Type != ItemTypeLogin && item.Type != ItemTypeTOTP) || !itemMatchesOrigin(item, origin) {
		return nil, errors.New("This ZPass item does not match the current site.")
	}
	result := &loginSecretNative{
		ID:       item.ID,
		Name:     item.Name,
		Username: nativeFieldString(item.Fields, "username", "email", "login", "account"),
		Password: nativeFieldString(item.Fields, "password"),
	}
	// 有 TOTP 秘钥时现场算码一起返，代价仅 1 次反序列化，Token 不遭传
	// 两次。算失败不报错——可能是秘钥格式问题，不应该拖累账密填充。
	if nativeFieldString(item.Fields, "totp") != "" {
		if code, err := vault.GenerateTOTP(item.ID); err == nil && code != nil {
			result.Totp = &loginTotpCodeNative{
				Code:      code.Code,
				Type:      code.Type,
				Period:    code.Period,
				Remaining: code.Remaining,
				Counter:   code.Counter,
				Algorithm: code.Algorithm,
				Digits:    code.Digits,
			}
		}
	}
	return result, nil
}

// generateLoginTotp 给浏览器扩展返回指定 login 条目的当前 OTP 码。
//
// 流程：
//  1. origin 校验（同 revealLogin，防越权读其它站点 TOTP）
//  2. itemId 非空校验
//  3. 校验条目存在 + 类型是 login + url 匹配当前页
//  4. 委托 vault.GenerateTOTP —— TOTP/HOTP/Steam 三种算法分流由 totpservice 处理
//
// 错误：
//   - 锁定 → "Unlock ZPass Desktop to use autofill."
//   - 条目缺秘钥 / 秘钥无效 → 包装的 totpservice 错误（前端按当前码不可用提示）
//   - origin 不匹配 → "This ZPass login does not match the current site."
func generateLoginTotp(vault *VaultService, req generateLoginTotpRequest) (*loginTotpCodeNative, error) {
	origin, err := parseSafeOrigin(req.pageContext)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(req.ItemID) == "" {
		return nil, errors.New("Missing vault item id.")
	}
	item, err := vault.GetItem(req.ItemID)
	if err != nil {
		if errors.Is(err, ErrVaultLocked) {
			return nil, errors.New("Unlock ZPass Desktop to use autofill.")
		}
		return nil, errors.New("Unable to read this ZPass login.")
	}
	if item == nil || (item.Type != ItemTypeLogin && item.Type != ItemTypeTOTP) || !itemMatchesOrigin(item, origin) {
		return nil, errors.New("This ZPass item does not match the current site.")
	}
	code, err := vault.GenerateTOTP(req.ItemID)
	if err != nil {
		return nil, err
	}
	return &loginTotpCodeNative{
		Code:      code.Code,
		Type:      code.Type,
		Period:    code.Period,
		Remaining: code.Remaining,
		Counter:   code.Counter,
		Algorithm: code.Algorithm,
		Digits:    code.Digits,
	}, nil
}

func nativeListPasskeys(vault *VaultService, req passkeyListRequest) (*passkeyListResult, error) {
	rpID, err := safePasskeyRPID(req.pageContext, req.RPID)
	if err != nil {
		return nil, err
	}
	if !vault.IsUnlocked() {
		return &passkeyListResult{Unlocked: false, RPID: rpID, Items: []PasskeyCredentialDescriptor{}}, nil
	}
	items, err := vault.ListPasskeys(rpID)
	if err != nil {
		if errors.Is(err, ErrVaultLocked) {
			return &passkeyListResult{Unlocked: false, RPID: rpID, Items: []PasskeyCredentialDescriptor{}}, nil
		}
		return nil, errors.New("Unable to read ZPass passkeys.")
	}
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].UpdatedAt > items[j].UpdatedAt
	})
	return &passkeyListResult{Unlocked: true, RPID: rpID, Items: items}, nil
}

func nativeCreatePasskey(vault *VaultService, req passkeyCreateRequest) (*PasskeyCredential, error) {
	rpID, err := safePasskeyRPID(req.pageContext, req.RPID)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(req.UserID) == "" || strings.TrimSpace(req.UserName) == "" {
		return nil, errors.New("Passkey user fields are missing.")
	}
	cred, err := vault.CreatePasskey(PasskeyRegistrationRequest{
		RPID:            rpID,
		RPName:          req.RPName,
		UserID:          req.UserID,
		UserName:        req.UserName,
		UserDisplayName: req.UserDisplayName,
		Name:            req.Name,
	})
	if err != nil {
		if errors.Is(err, ErrVaultLocked) {
			return nil, errors.New("Unlock ZPass Desktop to create passkeys.")
		}
		return nil, err
	}
	return cred, nil
}

func nativeSignPasskey(vault *VaultService, req passkeySignRequest) (*PasskeyAssertionResponse, error) {
	rpID, err := safePasskeyRPID(req.pageContext, req.RPID)
	if err != nil {
		return nil, err
	}
	out, err := vault.SignPasskeyAssertion(PasskeyAssertionRequest{
		RPID:           rpID,
		CredentialID:   req.CredentialID,
		ClientDataHash: req.ClientDataHash,
	})
	if err != nil {
		if errors.Is(err, ErrVaultLocked) {
			return nil, errors.New("Unlock ZPass Desktop to use passkeys.")
		}
		if errors.Is(err, ErrPasskeyNotFound) {
			return nil, errors.New("No matching ZPass passkey for this site.")
		}
		return nil, err
	}
	return out, nil
}

func nativeDeletePasskey(vault *VaultService, req passkeyDeleteRequest) (*passkeyDeleteResult, error) {
	rpID, err := safePasskeyRPID(req.pageContext, req.RPID)
	if err != nil {
		return nil, err
	}
	itemID := strings.TrimSpace(req.ItemID)
	credentialID := strings.TrimSpace(req.CredentialID)
	if itemID == "" && credentialID == "" {
		return nil, errors.New("Missing passkey id.")
	}

	items, err := vault.ListPasskeys(rpID)
	if err != nil {
		if errors.Is(err, ErrVaultLocked) {
			return nil, errors.New("Unlock ZPass Desktop to manage passkeys.")
		}
		return nil, errors.New("Unable to read ZPass passkeys.")
	}

	for _, item := range items {
		if item.ItemID != itemID && (credentialID == "" || item.CredentialID != credentialID) {
			continue
		}
		if err := vault.DeleteItem(item.ItemID); err != nil {
			if errors.Is(err, ErrVaultLocked) {
				return nil, errors.New("Unlock ZPass Desktop to manage passkeys.")
			}
			return nil, errors.New("Unable to delete this ZPass passkey.")
		}
		return &passkeyDeleteResult{Deleted: true, ItemID: item.ItemID}, nil
	}

	return nil, errors.New("No matching ZPass passkey for this site.")
}

func parseSafeOrigin(ctx pageContext) (*url.URL, error) {
	raw := strings.TrimSpace(ctx.Origin)
	if raw == "" {
		raw = strings.TrimSpace(ctx.URL)
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" {
		return nil, errors.New("Invalid page origin.")
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return nil, errors.New("ZPass only fills http and https pages.")
	}
	return &url.URL{Scheme: parsed.Scheme, Host: parsed.Host}, nil
}

func safePasskeyRPID(ctx pageContext, rawRPID string) (string, error) {
	origin, err := parseSafeOrigin(ctx)
	if err != nil {
		return "", err
	}
	if origin.Scheme != "https" && !isLocalPasskeyOrigin(origin) {
		return "", errors.New("Passkeys require https, localhost, or loopback origins.")
	}
	rpID := strings.TrimSpace(rawRPID)
	if rpID == "" {
		rpID = origin.Hostname()
	}
	normalizedRPID, err := normalizeRPID(rpID)
	if err != nil {
		return "", err
	}
	host := strings.ToLower(origin.Hostname())
	if host != normalizedRPID && !strings.HasSuffix(host, "."+normalizedRPID) {
		return "", errors.New("Passkey rpId does not match the current site.")
	}
	return normalizedRPID, nil
}

func isLocalPasskeyOrigin(origin *url.URL) bool {
	host := strings.ToLower(origin.Hostname())
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func itemMatchesOrigin(item *ItemPayload, origin *url.URL) bool {
	for _, candidate := range itemURLs(item.Fields) {
		if urlMatchesOrigin(candidate, origin) {
			return true
		}
	}
	return false
}

func itemURLs(fields map[string]any) []string {
	keys := []string{"url", "uri", "website"}
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		if value := strings.TrimSpace(nativeFieldString(fields, key)); value != "" {
			out = append(out, value)
		}
	}
	for _, key := range []string{"urls", "uris"} {
		switch values := fields[key].(type) {
		case []any:
			for _, value := range values {
				if s, ok := value.(string); ok && strings.TrimSpace(s) != "" {
					out = append(out, strings.TrimSpace(s))
				}
			}
		case []string:
			for _, value := range values {
				if strings.TrimSpace(value) != "" {
					out = append(out, strings.TrimSpace(value))
				}
			}
		}
	}
	return out
}

// urlMatchesOrigin 判定保存的凭据 URL 是否匹配当前页面 origin。
//
// 策略与 Bitwarden UriMatchStrategy.Domain (默认) 对齐：取两者的
// **registrable domain**（PSL eTLD+1）后比较。
//
// 与旧版 strings.HasSuffix 的区别：
//   - 旧版：保存 `openai.com` 能匹 `auth.openai.com`（sub-of），但保存
//     `auth.openai.com` 不能匹 `chat.openai.com`（反方向）。
//   - 新版：两者只要 PSL 算出同一个 registrable domain (openai.com)
//     就匹配。对 OAuth/SSO 跳子域场景不再踩坑。
//
// blacklist：DomainMatchBlacklist 与 Bitwarden 同步，防止
// script.google.com 这种「用户可控脚本托管」子域被误认为 google.com。
func urlMatchesOrigin(candidate string, origin *url.URL) bool {
	parsed, err := parseCredentialURL(candidate)
	if err != nil {
		return false
	}
	if parsed.Scheme != "" && parsed.Scheme != "https" && parsed.Scheme != "http" {
		return false
	}
	credentialHost := strings.ToLower(parsed.Hostname())
	pageHost := strings.ToLower(origin.Hostname())
	if credentialHost == "" || pageHost == "" {
		return false
	}

	// 精确同 host 直接返 true，不走 PSL（适配 localhost / IP / 独立域名场景）
	if pageHost == credentialHost {
		return true
	}

	credentialDomain := registrableDomain(credentialHost)
	pageDomain := registrableDomain(pageHost)
	if credentialDomain == "" || pageDomain == "" {
		// PSL 抽不出可注册域（例如 IP / localhost / 企业内网名）——
		// 退回旧版 子域算法作保底，保证本地项目不会都跟不上。
		return pageHost == credentialHost || strings.HasSuffix(pageHost, "."+credentialHost)
	}
	if credentialDomain != pageDomain {
		return false
	}

	// 黑名单：同一 registrable domain 但页面 host 在不可信子域集中 → 不匹配
	if denied, ok := domainMatchBlacklist[credentialDomain]; ok {
		if _, blocked := denied[pageHost]; blocked {
			return false
		}
	}
	return true
}

// registrableDomain 调用 PSL 抽取 eTLD+1。IP / localhost / PSL 未覆盖的内网名
// 返空串，调用方需退回到子域策略。
func registrableDomain(host string) string {
	if host == "" || host == "localhost" {
		return ""
	}
	if net.ParseIP(host) != nil {
		return ""
	}
	domain, err := publicsuffix.EffectiveTLDPlusOne(host)
	if err != nil {
		return ""
	}
	return strings.ToLower(domain)
}

func parseCredentialURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("empty url")
	}
	parsed, err := url.Parse(raw)
	if err == nil && parsed.Hostname() != "" {
		return parsed, nil
	}
	return url.Parse("https://" + strings.TrimPrefix(raw, "//"))
}

func firstDisplayURL(fields map[string]any) string {
	urls := itemURLs(fields)
	if len(urls) == 0 {
		return ""
	}
	parsed, err := parseCredentialURL(urls[0])
	if err != nil || parsed.Hostname() == "" {
		return urls[0]
	}
	return parsed.Hostname()
}

func nativeFieldString(fields map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := fields[key].(string); ok {
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}
