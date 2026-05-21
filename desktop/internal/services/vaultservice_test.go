package services

// Vault 服务 —— 端到端单元测试
// ---------------------------------------------------------------------------
// 覆盖目标：
//   1. Initialize → 立即处于解锁态、Status 报告 Initialized=true / Unlocked=true
//   2. CRUD：Create / Get / List / Update / Delete 全链路（含密文落 DB、
//      解密能拿回明文、ID 是后端生成的、CreatedAt 不被 Update 覆盖）
//   3. Lock → DEK 抹零、所有需要 DEK 的方法返回 ErrVaultLocked
//   4. Unlock 错密码 → ErrInvalidPassword；正确密码 → 恢复解锁态
//   5. ChangeMasterPassword → 旧密码失效、新密码可解、所有 item 仍可读
//      （DEK 不变 / 重新包装的关键回归）
//   6. 重启后（重新 Open DB + 新建 VaultService）仍能用原密码解锁；
//      之前的 item 仍可读取
//   7. AEAD 防搬移：手工把 item A 的密文写到 item B 行下，解密应失败
//      （aad=id 绑定生效）
//   8. 重复 Initialize → ErrVaultAlreadyInitialized
//   9. 弱密码（< 8 字符）→ ErrPasswordTooWeak
//
// ---------------------------------------------------------------------------
// 测试隔离策略
//
// VaultDB 默认走 ~/.config/zpass/vault.db —— 不能直接拿来测，否则会污染
// 用户真实数据。OpenVaultDB 当前没暴露"测试用临时目录"参数；本测试通过
// 暂时改写 HOME / USERPROFILE 环境变量，把 ensureConfigDir() 的解析路径
// 重定向到 t.TempDir()。
//
// 这种做法的好处：
//   - 不污染真实 ~/.config/zpass/
//   - 测试结束 t.TempDir() 自动清理
//   - 不需要给生产代码加"测试用 DSN"分支，保持 OpenVaultDB 调用面干净
//
// 跨平台细节：
//   - Linux / macOS：os.UserHomeDir() 优先读 $HOME
//   - Windows：os.UserHomeDir() 优先读 %USERPROFILE%（不是 %HOME%）
//   两个平台都覆盖一遍，免得 CI 在 Windows 上跑挂
//
// ---------------------------------------------------------------------------
// 性能
//
// Argon2id 默认参数（64 MiB / 3 iter / 4 lanes）每次派生 ~250-400 ms。
// 一个测试函数里如果 Initialize + Unlock + ChangeMasterPassword 各跑
// 几次，单跑就 2-3 秒。`go test ./...` 全跑通常 5-10 秒，可接受 ——
// 这是真实加密体验的代价，不该用 weak params 给测试加速（那会让测试
// 跟生产路径不一致，掩盖参数 bug）。
//
// 真要加速可以考虑：暴露一个 internal 的 "test KDF params" 注入点；
// 当前阶段不做，等测试成本真的疼了再说。

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

// withTempHome 把 HOME / USERPROFILE 临时改到 t.TempDir()，让
// OpenVaultDB 解析出 <tempdir>/.config/zpass/vault.db
//
// 用 t.Cleanup 还原原值，保证测试间不互相污染。
func withTempHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	// 同时覆盖 HOME 和 USERPROFILE：os.UserHomeDir() 在不同平台读不同
	// 变量，全覆盖一次比 runtime.GOOS 分支判断更稳。
	saveHome, hadHome := os.LookupEnv("HOME")
	saveUserProfile, hadUserProfile := os.LookupEnv("USERPROFILE")

	if err := os.Setenv("HOME", dir); err != nil {
		t.Fatalf("setenv HOME: %v", err)
	}
	if err := os.Setenv("USERPROFILE", dir); err != nil {
		t.Fatalf("setenv USERPROFILE: %v", err)
	}

	t.Cleanup(func() {
		if hadHome {
			_ = os.Setenv("HOME", saveHome)
		} else {
			_ = os.Unsetenv("HOME")
		}
		if hadUserProfile {
			_ = os.Setenv("USERPROFILE", saveUserProfile)
		} else {
			_ = os.Unsetenv("USERPROFILE")
		}
	})

	return dir
}

// openTestVault 在临时 HOME 下打开一个新 VaultDB
//
// 测试结束自动 Close（t.Cleanup）；不需要手动管理生命周期。
func openTestVault(t *testing.T) *VaultDB {
	t.Helper()
	withTempHome(t)
	db, err := OpenVaultDB()
	if err != nil {
		t.Fatalf("open vault db: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})
	return db
}

// newTestService 在临时 HOME 下打开 DB 并构造 VaultService
//
// 返回 (svc, dbPath) —— dbPath 用于 TestRestartUnlock 之类需要"关闭后
// 重新 Open"的场景验证持久化。
func newTestService(t *testing.T) (*VaultService, string) {
	t.Helper()
	home := withTempHome(t)
	dbPath := filepath.Join(home, configRootDirname, appConfigDirname, vaultDBFilename)

	db, err := OpenVaultDB()
	if err != nil {
		t.Fatalf("open vault db: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})
	return NewVaultService(db), dbPath
}

// ---------------------------------------------------------------------------
// 基本：状态机
// ---------------------------------------------------------------------------

// TestStatus_BeforeInit 确认全新 vault 的状态：未初始化 / 未解锁
func TestStatus_BeforeInit(t *testing.T) {
	svc, _ := newTestService(t)

	st, err := svc.Status()
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if st.Initialized {
		t.Errorf("expected Initialized=false on fresh vault, got true")
	}
	if st.Unlocked {
		t.Errorf("expected Unlocked=false on fresh vault, got true")
	}
	if st.ItemCount != 0 {
		t.Errorf("expected ItemCount=0, got %d", st.ItemCount)
	}
}

// TestInitialize_HappyPath 验证 Initialize 后立刻处于"已初始化 + 已解锁"
// —— 与产品流程对齐（Onboarding 设密码后用户立即进入主界面）
func TestInitialize_HappyPath(t *testing.T) {
	svc, _ := newTestService(t)

	if err := svc.Initialize("correct horse battery staple"); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	st, err := svc.Status()
	if err != nil {
		t.Fatalf("status after init: %v", err)
	}
	if !st.Initialized {
		t.Error("expected Initialized=true after Initialize, got false")
	}
	if !st.Unlocked {
		t.Error("expected Unlocked=true after Initialize, got false")
	}
}

// TestInitialize_AlreadyInitialized 重复 Initialize 应返回明确错误
//
// 防御前端 bug：用户绕过 Status 检查直接连续调 Initialize 不应该把已有
// vault 覆盖（那会让所有原 item 永久无法解密 —— 本质上是数据丢失事故）
func TestInitialize_AlreadyInitialized(t *testing.T) {
	svc, _ := newTestService(t)

	if err := svc.Initialize("first password"); err != nil {
		t.Fatalf("first init: %v", err)
	}
	err := svc.Initialize("second password")
	if !errors.Is(err, ErrVaultAlreadyInitialized) {
		t.Errorf("expected ErrVaultAlreadyInitialized, got %v", err)
	}
}

// TestInitialize_WeakPassword 弱密码（< 8 字符）应被拒绝
func TestInitialize_WeakPassword(t *testing.T) {
	svc, _ := newTestService(t)

	cases := []string{"", "1234567"} // 空 / 7 字符
	for _, pw := range cases {
		if err := svc.Initialize(pw); !errors.Is(err, ErrPasswordTooWeak) {
			t.Errorf("password %q: expected ErrPasswordTooWeak, got %v", pw, err)
		}
	}
}

// ---------------------------------------------------------------------------
// 锁定 / 解锁
// ---------------------------------------------------------------------------

// TestLock_WipesDEK 锁定后 DEK 应被抹零，需 DEK 的方法返回 ErrVaultLocked
func TestLock_WipesDEK(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("master-password-123"); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	if err := svc.Lock(); err != nil {
		t.Fatalf("lock: %v", err)
	}

	// 内部状态：dek 必须置 nil
	svc.mu.RLock()
	dek := svc.dek
	svc.mu.RUnlock()
	if dek != nil {
		t.Errorf("expected dek=nil after Lock, got %d bytes", len(dek))
	}

	// 外部行为：CRUD 全部 ErrVaultLocked
	if _, err := svc.ListItems(); !errors.Is(err, ErrVaultLocked) {
		t.Errorf("ListItems after lock: expected ErrVaultLocked, got %v", err)
	}
	if _, err := svc.GetItem("anything"); !errors.Is(err, ErrVaultLocked) {
		t.Errorf("GetItem after lock: expected ErrVaultLocked, got %v", err)
	}
	if _, err := svc.CreateItem(loginItemFixture("Stripe")); !errors.Is(err, ErrVaultLocked) {
		t.Errorf("CreateItem after lock: expected ErrVaultLocked, got %v", err)
	}
	if err := svc.DeleteItem("anything"); !errors.Is(err, ErrVaultLocked) {
		t.Errorf("DeleteItem after lock: expected ErrVaultLocked, got %v", err)
	}
}

// TestLock_Idempotent 未解锁状态下重复 Lock 应安全无副作用
func TestLock_Idempotent(t *testing.T) {
	svc, _ := newTestService(t)
	// 未 Initialize 直接 Lock
	if err := svc.Lock(); err != nil {
		t.Errorf("lock on fresh vault should succeed, got %v", err)
	}
	// 再 Lock 一次
	if err := svc.Lock(); err != nil {
		t.Errorf("second lock should be no-op, got %v", err)
	}
}

// TestUnlock_WrongPassword 错误密码应返回 ErrInvalidPassword
//
// 关键：错误消息不能泄露"是 KEK 解 wrappedDEK 失败还是 verifier 解
// 失败" —— 都统一一个错误。这条用例同时保护了 Unlock 内部那两层 AEAD
// 校验的"模糊化"约定。
func TestUnlock_WrongPassword(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("real-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if err := svc.Lock(); err != nil {
		t.Fatalf("lock: %v", err)
	}

	err := svc.Unlock("wrong-password-xyz")
	if !errors.Is(err, ErrInvalidPassword) {
		t.Errorf("expected ErrInvalidPassword, got %v", err)
	}

	// 失败后仍处于锁定态
	st, _ := svc.Status()
	if st.Unlocked {
		t.Error("expected vault to remain locked after failed unlock")
	}
}

// TestUnlock_CorrectPassword 正确密码应解锁，且能继续读 item
func TestUnlock_CorrectPassword(t *testing.T) {
	svc, _ := newTestService(t)
	const pw = "correct-master-pass"
	if err := svc.Initialize(pw); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	// 创建一条 item，方便后续验证解锁后还能读出来
	created, err := svc.CreateItem(loginItemFixture("GitHub"))
	if err != nil {
		t.Fatalf("create item: %v", err)
	}

	if err := svc.Lock(); err != nil {
		t.Fatalf("lock: %v", err)
	}
	if err := svc.Unlock(pw); err != nil {
		t.Fatalf("unlock with correct pw: %v", err)
	}

	// 解锁后能读
	got, err := svc.GetItem(created.ID)
	if err != nil {
		t.Fatalf("get item after unlock: %v", err)
	}
	if got == nil || got.Name != "GitHub" {
		t.Errorf("expected to read back GitHub item, got %+v", got)
	}
}

// TestUnlock_AlreadyUnlockedCorrectPassword 已解锁状态下输入正确密码
// 应该成功（重新派生 + 替换 dek，仍然是有效会话）
//
// 这是 Unlock 幂等性新语义的正向验证：通过完整校验才算"再次解锁成功"，
// 不走"已解锁就无脑信任"的捷径。代价是多跑一次 Argon2id（~250-400 ms），
// 但这种调用本来就是异常路径（前端状态机 bug），慢一点是合理反馈。
func TestUnlock_AlreadyUnlockedCorrectPassword(t *testing.T) {
	svc, _ := newTestService(t)
	const pw = "test-master-password"
	if err := svc.Initialize(pw); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	// 已经处于解锁态（Initialize 后即解锁），再 Unlock 同一个密码应该
	// 经过完整 KDF + AEAD 验证后仍然成功
	if err := svc.Unlock(pw); err != nil {
		t.Errorf("unlock with correct pw on already-unlocked vault should succeed, got %v", err)
	}
	// 仍处于解锁态
	st, _ := svc.Status()
	if !st.Unlocked {
		t.Error("expected vault to remain unlocked")
	}
}

// TestUnlock_AlreadyUnlockedWrongPassword_RejectsAndPreservesSession
//
// **关键安全回归**：早期 Unlock 实现里有
//
//	if s.dek != nil { return nil }
//
// 的"幂等捷径"——已解锁状态下输入任何密码都直接返回 nil。这导致一个
// 严重漏洞链：
//
//  1. 用户 Initialize → s.dek 持有 DEK
//  2. 前端某个 lock 入口忘了调 vaultApi.Lock()（仅翻前端 useLockStore.locked
//     标志位）→ 后端 s.dek 仍然 != nil
//  3. 路由守卫把用户送回 /unlock 页
//  4. 用户输入**任何**密码（包括空 / 错的）→ 后端命中幂等捷径返回 nil
//  5. 前端以为解锁成功 → 攻击者用空密码绕过所有保护
//
// 修复后：已解锁状态下输入错密码必须返回 ErrInvalidPassword，且**不**
// 清除当前 s.dek（合法用户的会话不应被攻击者错误尝试打断）。
//
// 这条用例锁死该行为，未来任何重新引入"幂等捷径"的 refactor 都会立刻
// 在这里挂掉。
func TestUnlock_AlreadyUnlockedWrongPassword_RejectsAndPreservesSession(t *testing.T) {
	svc, _ := newTestService(t)
	const realPw = "real-master-password"
	if err := svc.Initialize(realPw); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	// 在已解锁状态下创建一条 item，验证后续会话还能访问它
	created, err := svc.CreateItem(loginItemFixture("CanaryItem"))
	if err != nil {
		t.Fatalf("create canary: %v", err)
	}

	// 攻击者尝试：在 s.dek != nil 的状态下输入错密码
	// 期望：返回 ErrInvalidPassword（不是 nil！）
	cases := []string{
		"",                     // 空密码
		"wrong-password",       // 完全错的密码
		"real-master-passwo",   // 差一个字符
		"REAL-MASTER-PASSWORD", // 大小写不同
	}
	for _, badPw := range cases {
		err := svc.Unlock(badPw)
		if !errors.Is(err, ErrInvalidPassword) {
			t.Errorf("Unlock(%q) on already-unlocked vault: expected ErrInvalidPassword, got %v",
				badPw, err)
		}
	}

	// 错误尝试不应破坏合法用户的解锁会话：
	//   - Status 仍报告 Unlocked=true
	//   - 仍能读出之前创建的 item（说明 s.dek 没被错误尝试清掉）
	st, err := svc.Status()
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !st.Unlocked {
		t.Error("expected vault to remain unlocked after rejecting wrong-password attempts")
	}
	got, err := svc.GetItem(created.ID)
	if err != nil {
		t.Fatalf("get canary after wrong-pw attempts: %v", err)
	}
	if got == nil || got.Name != "CanaryItem" {
		t.Errorf("legitimate session broken by wrong-pw attempts: got %+v", got)
	}
}

// ---------------------------------------------------------------------------
// 条目 CRUD
// ---------------------------------------------------------------------------

// loginItemFixture 构造一个 LoginItem 风格的 ItemPayload，便于在多个
// 测试里复用。Fields 模拟前端传过来的"登录类型特定字段"。
func loginItemFixture(name string) ItemPayload {
	return ItemPayload{
		// ID 故意留空 —— CreateItem 应该忽略前端传入的 ID 自己生成
		ID:   "",
		Type: ItemTypeLogin,
		Name: name,
		Fields: map[string]any{
			"username": "alex@zpass.dev",
			"password": "S3cret!Pass-" + name,
			"url":      name + ".com",
			"notes":    "fixture note",
		},
	}
}

// TestCreateItem_GeneratesIDAndTimestamps 验证 CreateItem 后端生成 ID
// 与时间戳，前端传入的 ID/CreatedAt/UpdatedAt 被忽略
func TestCreateItem_GeneratesIDAndTimestamps(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	in := loginItemFixture("Vercel")
	in.ID = "client-tried-to-set-this"
	in.CreatedAt = 1
	in.UpdatedAt = 1

	out, err := svc.CreateItem(in)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if out.ID == "" || out.ID == "client-tried-to-set-this" {
		t.Errorf("expected backend-generated ID, got %q", out.ID)
	}
	if len(out.ID) != 32 { // 16 bytes hex
		t.Errorf("expected 32-char hex ID, got len=%d (%q)", len(out.ID), out.ID)
	}
	if out.CreatedAt == 1 || out.UpdatedAt == 1 {
		t.Errorf("expected backend timestamps, got created=%d updated=%d", out.CreatedAt, out.UpdatedAt)
	}
	if out.CreatedAt != out.UpdatedAt {
		t.Errorf("on create, CreatedAt should equal UpdatedAt; got %d vs %d", out.CreatedAt, out.UpdatedAt)
	}
}

// TestCreateItem_InvalidType 未知 type 应被拒绝
func TestCreateItem_InvalidType(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	bad := ItemPayload{Type: "not-a-real-type", Name: "x"}
	if _, err := svc.CreateItem(bad); err == nil {
		t.Error("expected error on invalid type, got nil")
	}
}

// TestGetItem_Roundtrip 建+读应得到完全相同的 Fields（密文回路无损）
func TestGetItem_Roundtrip(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	in := loginItemFixture("Linear")
	in.Fields["totp"] = "JBSW Y3DP EHPK 3PXP"
	in.Fields["tags"] = []any{"dev", "2fa"}

	created, err := svc.CreateItem(in)
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := svc.GetItem(created.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got == nil {
		t.Fatal("expected item, got nil")
	}
	if got.Name != "Linear" {
		t.Errorf("name mismatch: %q", got.Name)
	}
	if got.Type != ItemTypeLogin {
		t.Errorf("type mismatch: %q", got.Type)
	}
	if got.Fields["username"] != "alex@zpass.dev" {
		t.Errorf("username mismatch: %v", got.Fields["username"])
	}
	if got.Fields["totp"] != "JBSW Y3DP EHPK 3PXP" {
		t.Errorf("totp mismatch: %v", got.Fields["totp"])
	}

	// JSON unmarshal 后切片是 []any，不是 []string —— 这是 map[string]any
	// 的固有行为；前端 TS 拿到也是 unknown[]，正确处理即可。
	tags, ok := got.Fields["tags"].([]any)
	if !ok || len(tags) != 2 || tags[0] != "dev" || tags[1] != "2fa" {
		t.Errorf("tags roundtrip mismatch: %v", got.Fields["tags"])
	}
}

// TestGetItem_NotFound 不存在的 ID 应返回 (nil, nil)（不是错误）
//
// 这一条契约让前端能干净地处理"条目已被删除/不存在"，不必把这种情况
// 当成错误弹错误提示。
func TestGetItem_NotFound(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	got, err := svc.GetItem("00000000000000000000000000000000")
	if err != nil {
		t.Errorf("expected nil error for missing item, got %v", err)
	}
	if got != nil {
		t.Errorf("expected nil item for missing ID, got %+v", got)
	}
}

// TestListItems_OrderAndContents 列表按 updated_at 倒序，包含 name/type
func TestListItems_OrderAndContents(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	// 创建三条；为保证 updated_at 顺序可控，每次创建后立刻 Update
	// （Update 会刷新 updated_at），这样最后 Update 的排在最前。
	a, err := svc.CreateItem(loginItemFixture("A"))
	if err != nil {
		t.Fatalf("create A: %v", err)
	}
	b, err := svc.CreateItem(loginItemFixture("B"))
	if err != nil {
		t.Fatalf("create B: %v", err)
	}
	c, err := svc.CreateItem(loginItemFixture("C"))
	if err != nil {
		t.Fatalf("create C: %v", err)
	}

	// 通过 Update 显式让 a 的 updated_at 跑到最新（原本顺序是 c>b>a）
	upd := loginItemFixture("A-updated")
	upd.ID = a.ID
	if _, err := svc.UpdateItem(upd); err != nil {
		t.Fatalf("update A: %v", err)
	}

	list, err := svc.ListItems()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("expected 3 items, got %d", len(list))
	}
	// 期望顺序：A-updated（最新 update）, c, b
	if list[0].ID != a.ID {
		t.Errorf("expected updated A first, got %s", list[0].ID)
	}
	if list[0].Name != "A-updated" {
		t.Errorf("expected updated name 'A-updated', got %q", list[0].Name)
	}
	if list[1].ID != c.ID || list[2].ID != b.ID {
		t.Errorf("unexpected order: [%s, %s, %s]", list[0].ID, list[1].ID, list[2].ID)
	}
}

// TestUpdateItem_PreservesCreatedAt Update 不应覆盖 CreatedAt
//
// 这是"创建时间是不可变事实"约定的回归 —— 即便前端在 ItemPayload 里
// 传了 CreatedAt，后端必须保留 DB 里的原值。
func TestUpdateItem_PreservesCreatedAt(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	created, err := svc.CreateItem(loginItemFixture("Stripe"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	originalCreatedAt := created.CreatedAt

	// 故意传一个晚得多的 CreatedAt，验证后端忽略它
	upd := loginItemFixture("Stripe-renamed")
	upd.ID = created.ID
	upd.CreatedAt = originalCreatedAt + 999_999

	updatedSummary, err := svc.UpdateItem(upd)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updatedSummary.CreatedAt != originalCreatedAt {
		t.Errorf("CreatedAt should be preserved: original=%d got=%d",
			originalCreatedAt, updatedSummary.CreatedAt)
	}
	if updatedSummary.UpdatedAt <= originalCreatedAt {
		t.Errorf("UpdatedAt should advance: created=%d updated=%d",
			originalCreatedAt, updatedSummary.UpdatedAt)
	}

	// 全量 Get 一次再确认
	got, err := svc.GetItem(created.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.CreatedAt != originalCreatedAt {
		t.Errorf("Get: CreatedAt mismatch %d vs %d", got.CreatedAt, originalCreatedAt)
	}
	if got.Name != "Stripe-renamed" {
		t.Errorf("Get: Name not updated: %q", got.Name)
	}
}

// TestUpdateItem_NotFound 更新不存在的 ID 应返回 ErrItemNotFound
func TestUpdateItem_NotFound(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	upd := loginItemFixture("Ghost")
	upd.ID = "deadbeefdeadbeefdeadbeefdeadbeef"
	_, err := svc.UpdateItem(upd)
	if !errors.Is(err, ErrItemNotFound) {
		t.Errorf("expected ErrItemNotFound, got %v", err)
	}
}

// TestDeleteItem 验证删除生效；重复删返回 ErrItemNotFound
func TestDeleteItem(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	created, err := svc.CreateItem(loginItemFixture("Notion"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := svc.DeleteItem(created.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}

	got, err := svc.GetItem(created.ID)
	if err != nil {
		t.Fatalf("get after delete: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil after delete, got %+v", got)
	}

	// 重复删
	if err := svc.DeleteItem(created.ID); !errors.Is(err, ErrItemNotFound) {
		t.Errorf("expected ErrItemNotFound on second delete, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// 修改主密码
// ---------------------------------------------------------------------------

// TestChangeMasterPassword_HappyPath 改密后旧密码失效 / 新密码可解 /
// 所有 item 仍可读（DEK 不变 / 只重新包装的关键回归）
func TestChangeMasterPassword_HappyPath(t *testing.T) {
	svc, _ := newTestService(t)
	const oldPw = "old-master-password"
	const newPw = "new-master-password"

	if err := svc.Initialize(oldPw); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	// 建一条 item，作为"DEK 没换 / item 还能读"的活证据
	created, err := svc.CreateItem(loginItemFixture("AWS"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	if err := svc.ChangeMasterPassword(oldPw, newPw); err != nil {
		t.Fatalf("change pw: %v", err)
	}

	// 改完仍处于解锁态（约定：用户不需要重新输密码）
	st, _ := svc.Status()
	if !st.Unlocked {
		t.Error("expected vault to stay unlocked after ChangeMasterPassword")
	}

	// item 仍可读
	got, err := svc.GetItem(created.ID)
	if err != nil {
		t.Fatalf("get after pw change: %v", err)
	}
	if got == nil || got.Name != "AWS" {
		t.Errorf("expected to still read AWS item after pw change, got %+v", got)
	}

	// 锁了之后旧密码应不能解
	if err := svc.Lock(); err != nil {
		t.Fatalf("lock: %v", err)
	}
	if err := svc.Unlock(oldPw); !errors.Is(err, ErrInvalidPassword) {
		t.Errorf("old pw should fail after change, got %v", err)
	}
	// 新密码能解
	if err := svc.Unlock(newPw); err != nil {
		t.Fatalf("unlock with new pw: %v", err)
	}
	// 解完仍能读
	got, err = svc.GetItem(created.ID)
	if err != nil || got == nil || got.Name != "AWS" {
		t.Errorf("read after relock+newpw failed: got=%+v err=%v", got, err)
	}
}

// TestChangeMasterPassword_WrongOldPassword 旧密码错应被拒绝
func TestChangeMasterPassword_WrongOldPassword(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("real-old-pw-1234"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	err := svc.ChangeMasterPassword("not-the-old-pw", "new-strong-pw-9876")
	if !errors.Is(err, ErrInvalidPassword) {
		t.Errorf("expected ErrInvalidPassword, got %v", err)
	}
}

// TestChangeMasterPassword_RequiresUnlocked 锁定状态下改密应被拒绝
//
// 产品约定：必须已解锁状态才能改密（防止 attacker 拿到桌面后用旧密码
// 算 KEK 直接改密把用户锁外面）
func TestChangeMasterPassword_RequiresUnlocked(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("real-old-pw-1234"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if err := svc.Lock(); err != nil {
		t.Fatalf("lock: %v", err)
	}
	err := svc.ChangeMasterPassword("real-old-pw-1234", "new-pw-9876")
	if !errors.Is(err, ErrVaultLocked) {
		t.Errorf("expected ErrVaultLocked, got %v", err)
	}
}

// TestChangeMasterPassword_WeakNewPassword 弱新密码应被拒绝
func TestChangeMasterPassword_WeakNewPassword(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("real-old-pw-1234"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	err := svc.ChangeMasterPassword("real-old-pw-1234", "1234567")
	if !errors.Is(err, ErrPasswordTooWeak) {
		t.Errorf("expected ErrPasswordTooWeak, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// 持久化（重启）
// ---------------------------------------------------------------------------

// TestRestart_DataPersists 关闭 service / DB → 重新 Open → 用原密码解锁
// → 之前的 item 仍可读
//
// 这条用例验证了"vault.db 是真正的持久化存储"，而不只是内存 mock。
// 也间接验证了 SQLite WAL 在 Close 后能正确合并到主文件。
func TestRestart_DataPersists(t *testing.T) {
	home := withTempHome(t)

	const pw = "restart-test-master-pw"

	// 第一阶段：建 vault + 建 item + 关闭
	db1, err := OpenVaultDB()
	if err != nil {
		t.Fatalf("open db1: %v", err)
	}
	svc1 := NewVaultService(db1)
	if err := svc1.Initialize(pw); err != nil {
		t.Fatalf("init: %v", err)
	}
	created, err := svc1.CreateItem(loginItemFixture("Persistent"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	originalID := created.ID
	if err := svc1.Lock(); err != nil {
		t.Fatalf("lock: %v", err)
	}
	if err := db1.Close(); err != nil {
		t.Fatalf("close db1: %v", err)
	}

	// 验证文件确实落到磁盘了
	dbPath := filepath.Join(home, configRootDirname, appConfigDirname, vaultDBFilename)
	if _, err := os.Stat(dbPath); err != nil {
		t.Fatalf("vault.db should exist after close: %v", err)
	}

	// 第二阶段：重新 Open + 解锁 + 读 item
	db2, err := OpenVaultDB()
	if err != nil {
		t.Fatalf("open db2: %v", err)
	}
	defer db2.Close()
	svc2 := NewVaultService(db2)

	st, err := svc2.Status()
	if err != nil {
		t.Fatalf("status after restart: %v", err)
	}
	if !st.Initialized {
		t.Error("expected Initialized=true after restart")
	}
	if st.Unlocked {
		t.Error("expected Unlocked=false after restart (cold start)")
	}

	if err := svc2.Unlock(pw); err != nil {
		t.Fatalf("unlock after restart: %v", err)
	}
	got, err := svc2.GetItem(originalID)
	if err != nil {
		t.Fatalf("get after restart: %v", err)
	}
	if got == nil {
		t.Fatal("item disappeared after restart")
	}
	if got.Name != "Persistent" {
		t.Errorf("name mismatch after restart: %q", got.Name)
	}
	if got.Fields["username"] != "alex@zpass.dev" {
		t.Errorf("fields mismatch after restart: %v", got.Fields)
	}
}

// ---------------------------------------------------------------------------
// 安全：AEAD 防搬移
// ---------------------------------------------------------------------------

// TestAEAD_BindToItemID 把 item A 的密文 BLOB 直接写到 item B 的行下，
// 解密 B 应该失败（aad=id 不匹配 → AEAD tag 失败）
//
// 这条用例验证了"加密 item 时 aad=item.id"的核心安全约定 —— 攻击者即便
// 能写 DB，也不能把密文搬来搬去骗解密器。如果某次 refactor 不小心改成
// aad=固定字符串，这条测试会立刻挂。
func TestAEAD_BindToItemID(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("aead-binding-test-pw"); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	a, err := svc.CreateItem(loginItemFixture("ItemA"))
	if err != nil {
		t.Fatalf("create A: %v", err)
	}
	b, err := svc.CreateItem(loginItemFixture("ItemB"))
	if err != nil {
		t.Fatalf("create B: %v", err)
	}

	// 取出 A 的密文，覆盖 B 的密文
	rowA, err := svc.db.GetItem(a.ID)
	if err != nil || rowA == nil {
		t.Fatalf("get raw row A: %v", err)
	}
	rowB, err := svc.db.GetItem(b.ID)
	if err != nil || rowB == nil {
		t.Fatalf("get raw row B: %v", err)
	}
	// 先确认两条密文不相等（防御 fixture 写得太一致让测试假阳性）
	if bytes.Equal(rowA.Payload, rowB.Payload) {
		t.Fatal("A and B ciphertexts are identical, fixture is too deterministic")
	}

	tampered := *rowB
	tampered.Payload = append([]byte(nil), rowA.Payload...) // 拷贝避免共享底层数组
	if err := svc.db.UpdateItem(&tampered); err != nil {
		t.Fatalf("tamper update: %v", err)
	}

	// 现在 B 行存的是 A 的密文。GetItem(B.ID) 应该解密失败 ——
	//   - aad = B.ID，但密文是用 aad = A.ID 加密的
	//   - AEAD tag 校验过不去 → OpenAEAD 返回错误
	//
	// vaultservice.GetItem 把这种错误包装成 "decrypt item: aead authentication failed"
	got, err := svc.GetItem(b.ID)
	if err == nil {
		t.Errorf("expected decrypt failure on swapped ciphertext, got item=%+v", got)
	}
}

// ---------------------------------------------------------------------------
// 安全：拖库分析（白盒）
// ---------------------------------------------------------------------------

// TestDB_NoPlaintextLeakage 直接读 vault.db 文件，确认没有任何明文 item 字段
//
// 这条是"拖库零信息"约定的回归测试：把 item 的明文字段（用户名 / 密码 /
// URL / notes / verifier 明文 / 主密码本身）做 byte 级别搜索，DB 文件
// 里都不应该出现。
//
// SQLite 的存储格式包含若干元数据（页头、表名、列名、SQL 语句本身），
// 所以 "vault_meta" / "argon2id" 之类的字符串会出现在文件里 —— 但用户
// 数据不应该。
func TestDB_NoPlaintextLeakage(t *testing.T) {
	home := withTempHome(t)
	const pw = "dragdb-test-master-password"
	const secretUser = "very-unique-username-marker-x9k2"
	const secretPass = "very-unique-password-marker-z8m1"
	const secretURL = "very-unique-url-marker-q7n3"

	db, err := OpenVaultDB()
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	svc := NewVaultService(db)
	if err := svc.Initialize(pw); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	in := ItemPayload{
		Type: ItemTypeLogin,
		Name: secretUser, // 故意把名字也设成 marker，看名字是不是真的加密了
		Fields: map[string]any{
			"username": secretUser,
			"password": secretPass,
			"url":      secretURL,
			"notes":    "this should never appear in raw db",
		},
	}
	if _, err := svc.CreateItem(in); err != nil {
		t.Fatalf("create: %v", err)
	}

	// 关闭 DB 让 WAL 合并 —— 否则部分明文可能在 wal 文件里而不在主文件
	if err := db.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	// 读所有相关文件（vault.db / vault.db-wal / vault.db-shm）做扫描
	dir := filepath.Join(home, configRootDirname, appConfigDirname)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	var corpus []byte
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", e.Name(), err)
		}
		corpus = append(corpus, data...)
	}
	if len(corpus) == 0 {
		t.Fatal("no db files found to scan")
	}

	// 搜索敏感明文 marker
	mustNotContain := []string{
		secretUser,
		secretPass,
		secretURL,
		"this should never appear in raw db",
		pw,                // 主密码本身
		VerifierPlaintext, // verifier 明文（被 DEK 加密前的字符串）
	}
	for _, needle := range mustNotContain {
		if bytes.Contains(corpus, []byte(needle)) {
			t.Errorf("plaintext leakage: db files contain %q", needle)
		}
	}
}

// ---------------------------------------------------------------------------
// 平台兜底
// ---------------------------------------------------------------------------

// TestOpenVaultDB_FilePermissions 在 POSIX 平台验证 vault.db 的文件权限
// 是 0600（仅当前用户读写）
//
// Windows 上 os.Chmod 是 no-op，跳过这条断言 —— Windows 的文件 ACL
// 由用户目录默认权限接管，os.Stat 拿不到等价信息。
func TestOpenVaultDB_FilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file mode bits not meaningful on Windows; ACL is handled by NTFS")
	}
	withTempHome(t)
	db, err := OpenVaultDB()
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	info, err := os.Stat(db.Path())
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	mode := info.Mode().Perm()
	if mode != 0o600 {
		t.Errorf("expected mode 0600, got %o", mode)
	}
}

// ---------------------------------------------------------------------------
// JSON 序列化兜底
// ---------------------------------------------------------------------------

// TestItemPayload_JSONShape 验证 ItemPayload 的 JSON tag 形状符合前端约定
//
// 前端 src/data/vault.ts / 未来的 vault-api.ts 会按这些字段名解码：
//
//	{ id, type, name, fields, createdAt, updatedAt }
//
// 改 struct tag 时这条用例会立刻挂，提醒同步前端类型定义。
func TestItemPayload_JSONShape(t *testing.T) {
	p := ItemPayload{
		ID:        "abc",
		Type:      ItemTypeLogin,
		Name:      "X",
		Fields:    map[string]any{"k": "v"},
		CreatedAt: 1,
		UpdatedAt: 2,
	}
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// 用 unmarshal 回 map 检查字段名（避免依赖具体序列化顺序）
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	expectKeys := []string{"id", "type", "name", "fields", "createdAt", "updatedAt"}
	for _, k := range expectKeys {
		if _, ok := got[k]; !ok {
			t.Errorf("missing JSON key %q in: %s", k, raw)
		}
	}
}
