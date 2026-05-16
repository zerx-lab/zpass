package main

// breachcheck.go — 密码泄露检测模块
// ---------------------------------------------------------------------------
// 对接 Have I Been Pwned (HIBP) Pwned Passwords API，使用 k-Anonymity 模型
// 检测密码是否出现在已知泄露数据库中。
//
// 隐私保护：只将密码 SHA-1 哈希的前 5 位发送给 HIBP API，本地比对剩余
// 35 位后缀，HIBP 服务端永远无法得知用户的完整密码哈希。
//
// 供前端通过 Wails 3 Call.ByName 调用 VaultService.CheckBreachedPasswords
// 批量扫描所有 login 类型条目。
//
// 缓存策略 ——————————————————————————————————————————————————————————————
//
// 以「密码 SHA-1 哈希」为 key 缓存检测结果（不是 itemId）。这样同一密码
// 即便被多个条目共用，也只发一次 HIBP 请求；用户改密码后哈希变化，下次
// 扫描自动 miss → 重查 → 写回新结果。
//
// 缓存生命周期：与 dek 同周期，Lock() 时一并清空。HIBP 数据库自身以「月」
// 为单位更新，常驻一个 unlock 会话内不会显著降低时效。
// ---------------------------------------------------------------------------

import (
	"bufio"
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// BreachResult 单条密码的泄露检测结果
//
// 前端按 itemId 匹配列表项渲染红色告警徽标。
// Pwned==true && Count>0 表示该密码在泄露库中出现过 Count 次。
// Error 非空时表示该条检测失败（网络异常等），前端可展示"检测失败"。
// CheckedAt 是该条结果首次写入缓存的 Unix 毫秒时间戳，前端可据此显示
// "上次检测时间"。
type BreachResult struct {
	ItemID    string `json:"itemId"`
	ItemName  string `json:"itemName"`
	Pwned     bool   `json:"pwned"`
	Count     int    `json:"count"`           // 在泄露数据库中出现的次数
	Error     string `json:"error,omitempty"` // 单条检测失败时的错误信息
	CheckedAt int64  `json:"checkedAt"`       // 该密码哈希被检测的时间（毫秒）
}

// breachCacheEntry 缓存中的单条记录，key 为密码 SHA-1 哈希。
//
// 不缓存 Error 状态：网络失败的条目下次扫描应重试，而不是把"检测失败"
// 永久钉在缓存里。
type breachCacheEntry struct {
	Pwned     bool
	Count     int
	CheckedAt int64 // Unix 毫秒
}

// hibpClient 是用于请求 HIBP API 的 http.Client，设置 5 秒超时。
// 包级别复用，避免每次请求都新建。
var hibpClient = &http.Client{
	Timeout: 5 * time.Second,
}

// hashPassword 计算密码的 SHA-1 大写十六进制哈希（40 字符）。
//
// 单独抽出是为了让缓存查询和 HIBP 请求复用同一份哈希结果，避免在
// CheckPasswordBreach 内重复计算。
func hashPassword(password string) string {
	return fmt.Sprintf("%X", sha1.Sum([]byte(password)))
}

// CheckPasswordBreach 检测单个密码是否出现在 HIBP 泄露数据库中。
//
// 入参 hash 必须是已用 hashPassword 计算好的大写 SHA-1 哈希（40 字符）。
// 之所以让调用方先算哈希再传入，是为了让缓存查询与本函数共用同一份哈希。
//
// 实现流程：
//  1. 取 hash 前 5 字符作为 prefix，剩余 35 字符作为 suffix
//  2. 请求 GET https://api.pwnedpasswords.com/range/{prefix}
//  3. 逐行解析响应（格式 SUFFIX:COUNT），本地匹配 suffix
//  4. HIBP 启用 Add-Padding 后会插入 count=0 的填充行，过滤掉
//
// 返回值：
//   - pwned: 密码是否已泄露
//   - count: 泄露次数（未泄露时为 0）
//   - err:   网络或解析错误
func CheckPasswordBreach(hash string) (pwned bool, count int, err error) {
	if len(hash) != 40 {
		return false, 0, fmt.Errorf("invalid sha-1 hash length: got %d, want 40", len(hash))
	}

	prefix := hash[:5]
	suffix := hash[5:]

	url := "https://api.pwnedpasswords.com/range/" + prefix

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return false, 0, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("User-Agent", "ZPass-PasswordManager")
	req.Header.Set("Add-Padding", "true")

	resp, err := hibpClient.Do(req)
	if err != nil {
		return false, 0, fmt.Errorf("hibp request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return false, 0, fmt.Errorf("hibp returned status %d", resp.StatusCode)
	}

	// 逐行解析响应，每行格式：SUFFIX:COUNT
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}

		lineSuffix := strings.TrimSpace(parts[0])
		lineCountStr := strings.TrimSpace(parts[1])

		// 不区分大小写比对 suffix
		if !strings.EqualFold(lineSuffix, suffix) {
			continue
		}

		n, err := strconv.Atoi(lineCountStr)
		if err != nil {
			return false, 0, fmt.Errorf("parse count %q: %w", lineCountStr, err)
		}

		// padding 行的 count 为 0，视为未泄露
		if n == 0 {
			return false, 0, nil
		}

		return true, n, nil
	}

	if err := scanner.Err(); err != nil {
		return false, 0, fmt.Errorf("read response: %w", err)
	}

	// suffix 未在响应中找到 → 密码未泄露
	return false, 0, nil
}

// ClearBreachCache 清空 HIBP 泄露检测缓存。
//
// 用于「重新扫描」按钮强制刷新：用户点击后调用本方法清缓存，再调用
// CheckBreachedPasswords 即可绕过缓存命中、对所有密码重新发起 HIBP 请求。
//
// vault 锁定状态下也允许调用（清空空缓存是 no-op，无副作用）。
func (s *VaultService) ClearBreachCache() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.breachCache = nil
	return nil
}

// lookupBreachCache 在缓存中查询某密码哈希的检测结果，命中返回 (entry, true)。
// 内部使用读锁，调用方不需要额外加锁。
func (s *VaultService) lookupBreachCache(hash string) (breachCacheEntry, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.breachCache == nil {
		return breachCacheEntry{}, false
	}
	entry, ok := s.breachCache[hash]
	return entry, ok
}

// storeBreachCache 把单条检测结果写入缓存，key 为密码哈希。
// 首次写入会懒初始化 map。
func (s *VaultService) storeBreachCache(hash string, entry breachCacheEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.breachCache == nil {
		s.breachCache = make(map[string]breachCacheEntry)
	}
	s.breachCache[hash] = entry
}

// CheckBreachedPasswords 批量扫描保险库中所有 login 类型条目的密码泄露情况。
//
// 前端可通过 Wails 3 调用此方法：
//
//	wails.Call.ByName("main.VaultService.CheckBreachedPasswords")
//
// 行为说明：
//   - 必须先解锁 vault（dek != nil），否则返回 ErrVaultLocked
//   - 筛选 type == "login" 的条目，逐条解密并检测 Fields["password"]
//   - 缓存命中（按密码 SHA-1 哈希）：直接复用结果，不发 HIBP 请求
//   - 缓存未命中：发 HIBP 请求，每次请求间隔 100ms，写回缓存
//   - 单条检测失败不中断整体，错误信息记录在该条的 Error 字段（不入缓存）
//   - GetItem 内部已加读锁，外层无需额外锁
//
// 想强制重新检测所有密码？先调用 ClearBreachCache 清空缓存。
func (s *VaultService) CheckBreachedPasswords() ([]BreachResult, error) {
	// 先读锁检查解锁状态
	s.mu.RLock()
	if s.dek == nil {
		s.mu.RUnlock()
		return nil, ErrVaultLocked
	}
	s.mu.RUnlock()

	// 获取所有条目摘要（ListItems 内部会加读锁）
	items, err := s.ListItems()
	if err != nil {
		return nil, fmt.Errorf("list items: %w", err)
	}

	// 筛选 login 类型条目
	var loginItems []ItemSummary
	for _, item := range items {
		if item.Type == ItemTypeLogin {
			loginItems = append(loginItems, item)
		}
	}

	results := make([]BreachResult, 0, len(loginItems))

	// networkCallCount 用于在缓存命中时跳过 100ms 间隔节流。
	// 节流是为了对 HIBP 友好，缓存命中时没发请求自然不需要等。
	networkCallCount := 0

	for _, item := range loginItems {
		result := BreachResult{
			ItemID:   item.ID,
			ItemName: item.Name,
		}

		// 获取完整条目（GetItem 内部加读锁并解密）
		payload, err := s.GetItem(item.ID)
		if err != nil {
			result.Error = fmt.Sprintf("get item: %v", err)
			results = append(results, result)
			continue
		}
		if payload == nil {
			result.Error = "item not found (may have been deleted)"
			results = append(results, result)
			continue
		}

		// 从 Fields 中提取密码
		rawPassword, ok := payload.Fields["password"]
		if !ok {
			// 没有 password 字段 → 跳过（不算错误，也不算泄露）
			continue
		}

		password, ok := rawPassword.(string)
		if !ok || password == "" {
			// password 不是字符串或为空 → 跳过
			continue
		}

		// 计算密码哈希一次，缓存查询和 HIBP 请求共用
		hash := hashPassword(password)

		// 1) 缓存命中：直接复用结果
		if entry, ok := s.lookupBreachCache(hash); ok {
			result.Pwned = entry.Pwned
			result.Count = entry.Count
			result.CheckedAt = entry.CheckedAt
			results = append(results, result)
			continue
		}

		// 2) 缓存未命中：调用 HIBP API，节流 100ms
		if networkCallCount > 0 {
			time.Sleep(100 * time.Millisecond)
		}
		networkCallCount++

		pwned, count, err := CheckPasswordBreach(hash)
		if err != nil {
			// 网络/解析失败：填到 Error 字段，不写缓存（下次扫描重试）
			result.Error = fmt.Sprintf("breach check: %v", err)
			results = append(results, result)
			continue
		}

		now := time.Now().UnixMilli()
		result.Pwned = pwned
		result.Count = count
		result.CheckedAt = now

		// 写回缓存（成功结果才入缓存）
		s.storeBreachCache(hash, breachCacheEntry{
			Pwned:     pwned,
			Count:     count,
			CheckedAt: now,
		})

		results = append(results, result)
	}

	// Auto-persist after full scan; fire-and-forget (save failure does not affect return value).
	go func() {
		if err := s.SaveBreachSnapshot(results); err != nil {
			fmt.Printf("[breach] save snapshot failed: %v\n", err)
		}
	}()
	return results, nil
}


// breachSnapshotNamespace is the namespace key used to persist breach check
// results via ConfigService. Stores []BreachResult (with CheckedAt), no
// plaintext passwords or hashes are written to disk.
const breachSnapshotNamespace = "health-cache"

// SaveBreachSnapshot persists the latest breach-check results to
// ~/.config/zpass/health-cache.json.
//
// Called automatically by CheckBreachedPasswords after a full scan, or
// triggered manually by the frontend after a forced re-scan.
//
// The file contains only itemId / itemName / pwned / count / checkedAt
// fields — no plaintext passwords or hashes — so its sensitivity is
// equivalent to a log file. It is used to restore the last result set
// across restarts without re-querying HIBP.
func (s *VaultService) SaveBreachSnapshot(results []BreachResult) error {
	data, err := json.Marshal(results)
	if err != nil {
		return fmt.Errorf("marshal breach snapshot: %w", err)
	}
	dir, err := ensureConfigDir()
	if err != nil {
		return fmt.Errorf("ensure config dir: %w", err)
	}
	path := resolveFilePath(dir, breachSnapshotNamespace)
	if err := writeAndSync(path, string(data)); err != nil {
		return fmt.Errorf("write breach snapshot: %w", err)
	}
	return nil
}

// LoadBreachSnapshot reads the previously persisted breach-check results
// from disk.
//
// Returns (nil, nil) when the file does not exist (normal on first launch).
// Returns (nil, err) on JSON parse failure; the caller should delete the
// corrupted file and fall back to a full re-scan.
func (s *VaultService) LoadBreachSnapshot() ([]BreachResult, error) {
	dir, err := ensureConfigDir()
	if err != nil {
		return nil, fmt.Errorf("ensure config dir: %w", err)
	}
	path := resolveFilePath(dir, breachSnapshotNamespace)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil // normal: first launch
		}
		return nil, fmt.Errorf("read breach snapshot: %w", err)
	}
	var results []BreachResult
	if err := json.Unmarshal(data, &results); err != nil {
		// corrupted file — let the caller decide whether to delete it
		return nil, fmt.Errorf("parse breach snapshot: %w", err)
	}
	return results, nil
}

// CheckItemBreach checks whether a single vault item's password appears in
// the HIBP breached-passwords database.
//
// Unlike CheckBreachedPasswords (which scans the entire vault), this method
// targets one item and is intended for use after a create/update operation
// to provide an immediate result without the cost of a full scan.
//
// Return values:
//   - (result, nil)  — check succeeded (result.Pwned indicates breach status)
//   - (nil, ErrVaultLocked)   — vault is not unlocked
//   - (nil, ErrItemNotFound)  — no item with the given ID exists
//   - (nil, err)     — any other error
func (s *VaultService) CheckItemBreach(itemID string) (*BreachResult, error) {
	payload, err := s.GetItem(itemID)
	if err != nil {
		return nil, err
	}
	if payload == nil {
		return nil, ErrItemNotFound
	}
	if payload.Type != ItemTypeLogin {
		return nil, nil // non-login items have no password to check
	}

	result := &BreachResult{
		ItemID:   payload.ID,
		ItemName: payload.Name,
	}

	rawPw, ok := payload.Fields["password"]
	if !ok {
		return result, nil // no password field — not a breach
	}
	password, ok := rawPw.(string)
	if !ok || password == "" {
		return result, nil
	}

	hash := hashPassword(password)

	// fast path: in-memory cache hit
	if entry, ok := s.lookupBreachCache(hash); ok {
		result.Pwned = entry.Pwned
		result.Count = entry.Count
		result.CheckedAt = entry.CheckedAt
		return result, nil
	}

	// cache miss: query HIBP
	pwned, count, err := CheckPasswordBreach(hash)
	if err != nil {
		// network failure is non-fatal; surface the error in the result
		result.Error = fmt.Sprintf("breach check: %v", err)
		return result, nil
	}

	now := time.Now().UnixMilli()
	result.Pwned = pwned
	result.Count = count
	result.CheckedAt = now

	s.storeBreachCache(hash, breachCacheEntry{
		Pwned:     pwned,
		Count:     count,
		CheckedAt: now,
	})
	return result, nil
}
