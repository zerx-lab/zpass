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
)

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
}

type queryLoginsResult struct {
	Unlocked bool                 `json:"unlocked"`
	Origin   string               `json:"origin"`
	Items    []loginSummaryNative `json:"items"`
}

type loginSecretNative struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Username string `json:"username"`
	Password string `json:"password"`
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
		if summary.Type != ItemTypeLogin {
			continue
		}
		item, err := vault.GetItem(summary.ID)
		if err != nil || item == nil || !itemMatchesOrigin(item, origin) {
			continue
		}
		items = append(items, loginSummaryNative{
			ID:         item.ID,
			Name:       item.Name,
			Username:   nativeFieldString(item.Fields, "username", "email", "login"),
			DisplayURL: firstDisplayURL(item.Fields),
			UpdatedAt:  item.UpdatedAt,
		})
	}
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].UpdatedAt > items[j].UpdatedAt
	})
	return &queryLoginsResult{Unlocked: true, Origin: origin.String(), Items: items}, nil
}

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
	if item == nil || item.Type != ItemTypeLogin || !itemMatchesOrigin(item, origin) {
		return nil, errors.New("This ZPass login does not match the current site.")
	}
	password := nativeFieldString(item.Fields, "password")
	if password == "" {
		return nil, errors.New("This ZPass login has no password.")
	}
	return &loginSecretNative{
		ID:       item.ID,
		Name:     item.Name,
		Username: nativeFieldString(item.Fields, "username", "email", "login"),
		Password: password,
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
	return pageHost == credentialHost || strings.HasSuffix(pageHost, "."+credentialHost)
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
