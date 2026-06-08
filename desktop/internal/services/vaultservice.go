package services

// Vault 服务层 —— ZPass 桌面客户端
// ---------------------------------------------------------------------------
// 把 cryptoutil（加密原语）和 vaultdb（SQLite 存储）粘合成对前端暴露的
// 高层 API。所有"用户级"操作（初始化主密码 / 解锁 / 锁定 / 增删改查
// 条目 / 修改主密码）都在这里完成，前端通过 Wails 3 的 Call.ByName
// 路由到本服务的导出方法。
//
// ---------------------------------------------------------------------------
// 安全模型概览
//
// 1. 主密码（master password）只在用户输入时短暂存在于内存，派生 KEK
//    后立即丢弃；从不落盘、从不进日志、从不在 IPC 中回传给前端。
//
// 2. 双层密钥（KEK + DEK）：
//      KEK = Argon2id(masterPassword, salt)            —— 仅用于包装 DEK
//      DEK = 随机 32 字节，初始化时生成                —— 仅用于加密 item
//      WrappedDEK = XChaCha20-Poly1305_Seal(KEK, DEK)  —— 存入 vault_meta
//      Verifier   = XChaCha20-Poly1305_Seal(DEK, "zpass-vault-verifier-v1")
//
//    解锁时：派生 KEK → 解 WrappedDEK → 解 Verifier；任意一步 AEAD tag
//    失败 = 主密码错误。这条流程的关键在于：从未在磁盘上存任何"主密码
//    哈希" —— 攻击者拖库后必须真正做完整的 Argon2id 派生才能验证一次
//    猜测，每次成本数百毫秒，离线爆破成本陡升。
//
// 3. 改主密码代价低：只需用旧 KEK 解出 DEK，再用新 KEK 重新包装。
//    所有 vault_items 的密文（用 DEK 加密）保持不变，无需重写整库。
//
// 4. Item 加密绑定 ID：SealAEAD 的 aad = item.id 字符串字节。攻击者
//    即便有 DB 写权限，把 item A 的密文搬到 item B 行也无法解 —— aad
//    不匹配，AEAD tag 失败。
//
// 5. 锁定时显式 WipeBytes(DEK)，让密钥材料尽快从内存消失。Go GC 不
//    保证及时清理但循环置零至少能减少残留窗口。
//
// ---------------------------------------------------------------------------
// 暴露给前端的方法（首字母大写才能被 Wails 反射注册）
//
//   Status()                                    → VaultStatus            (未初始化 / 锁定 / 解锁)
//   Initialize(password)                        → error                  (首次设置主密码)
//   Unlock(password)                            → error                  (输入主密码解锁)
//   Lock()                                      → error                  (主动锁定，清空内存 DEK)
//   ChangeMasterPassword(oldPwd, newPwd)        → error                  (修改主密码)
//
//   ListItems()                                 → []ItemSummary          (列表用，含 name + type)
//   GetItem(id)                                 → ItemPayload            (完整字段)
//   CreateItem(itemPayload)                     → ItemSummary            (新建，返回带 id)
//   UpdateItem(itemPayload)                     → ItemSummary            (整体覆盖，按 id 更新)
//   DeleteItem(id)                              → error
//
// 所有需要明文 DEK 的方法在 VaultService 锁定时返回 ErrVaultLocked。
// 前端遇到这种错误应该把 UI 切到 UnlockPage。
//
// ---------------------------------------------------------------------------
// 并发
//
// 每个 Wails 调用走独立 goroutine。我们用 sync.RWMutex 保护内存中的
// DEK：读路径（ListItems / GetItem / CreateItem 等）取读锁，状态切换
// （Initialize / Unlock / Lock / ChangeMasterPassword）取写锁。
//
// 这避免"解锁中"和"读条目"在不同 goroutine 间的竞争，也避免 Lock()
// 在某个查询中途把 DEK 抹掉导致解密野指针。
//
// SQLite 自身的并发控制由 modernc 驱动 + WAL 模式 + MaxOpenConns=1
// 兜底，VaultDB 的方法本来就线程安全，这里的锁只针对内存 DEK 的状态。

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// 类型与错误定义
// ---------------------------------------------------------------------------

// VaultStatus 是 Status() 方法返回给前端的"vault 当前状态快照"
//
// 三态组合：
//   - Initialized=false  → 尚未设置主密码，前端引导用户走"创建主密码"流程
//   - Initialized=true & Unlocked=false → 已初始化但未解锁，前端进 UnlockPage
//   - Initialized=true & Unlocked=true  → 已解锁，前端进主界面
//
// 字段用 JSON tag 显式声明小写驼峰，Wails 3 会按这个序列化给前端
// （前端 TS 端无需手动 transform），与 zustand store 字段命名一致。
type VaultStatus struct {
	Initialized bool `json:"initialized"`
	Unlocked    bool `json:"unlocked"`
	// ItemCount 仅在 Unlocked=true 时有意义；锁定状态下我们不暴露条目数
	// （即便密文已加密，条目数量本身也是侧信道信息，少暴露是少暴露）。
	ItemCount int `json:"itemCount"`
}

// ItemType 是条目类型枚举 —— 与前端 src/data/vault.ts 的 VaultItemType
// 一致。后端不解释具体类型语义（除了校验取值合法），所有字段都塞进
// 同一个加密 payload；前端按 type 分支渲染不同表单。
type ItemType string

const (
	ItemTypeLogin    ItemType = "login"
	ItemTypeCard     ItemType = "card"
	ItemTypeNote     ItemType = "note"
	ItemTypeIdentity ItemType = "identity"
	ItemTypeSSH      ItemType = "ssh"
	// ItemTypePasskey 是 WebAuthn / FIDO2 passkey 凭据条目。
	//
	// 当前桌面端先实现密码管理器最关键的"核心认证器"能力：
	//   - 在加密 vault 内生成并保存 ES256 私钥
	//   - 暴露注册所需的 authenticatorData / attestationObject
	//   - 暴露断言签名能力，并持久推进 WebAuthn signCount
	//
	// 浏览器自动填充 / Windows WebAuthn provider 集成需要系统级 provider 或
	// 浏览器扩展桥接，不应混在 vault 加密层里；未来桥接层只需要调用
	// passkeyservice.go 中的 CreatePasskey / ListPasskeys / SignPasskeyAssertion。
	ItemTypePasskey ItemType = "passkey"
	// ItemTypeTOTP 独立的「身份验证器条目」：只存账户名 + TOTP 密钥
	//
	// 设计动机：
	//   - login 条目本就允许 fields["totp"] 携带 TOTP 密钥（密码 + 二步验证一站式管理）
	//   - 但用户也可能希望像 Authy / Google Authenticator 一样独立管理 TOTP，
	//     比如某些账户没有密码（仅扫码登录）或者由其它密码管理器托管密码。
	//   - 因此新增独立类型，前端 TOTP 聚合页同时收纳两类来源：
	//       1. login 类型且 fields["totp"] 非空
	//       2. totp 类型条目本身
	//
	// 字段约定（与 login 共享 totp 字段名，方便聚合视图复用同一计算逻辑）：
	//   fields["totp"]      —— TOTP 密钥（base32 字符串，可含空格）
	//   fields["issuer"]    —— 发行者（可选，例如 "GitHub" / "Google"）
	//   fields["account"]   —— 账户标识（可选，邮箱 / 用户名）
	//   fields["notes"]     —— 备注
	ItemTypeTOTP ItemType = "totp"
)

// validItemTypes 用于 CreateItem / UpdateItem 时校验前端传入的 type
// 字符串落在已知枚举内 —— 防御未来前端打错 typo 把垃圾数据写进 vault。
var validItemTypes = map[ItemType]struct{}{
	ItemTypeLogin:    {},
	ItemTypeCard:     {},
	ItemTypeNote:     {},
	ItemTypeIdentity: {},
	ItemTypeSSH:      {},
	ItemTypePasskey:  {},
	ItemTypeTOTP:     {},
}

// legacyWalletType 是已废弃的「加密钱包」类型，不再出现在 validItemTypes 中。
// 仅在 migrateLegacyTypeInPlace 中用作识别旧数据的字面量。
const legacyWalletType ItemType = "wallet"

// migrateLegacyTypeInPlace 透明地将旧 wallet 条目降级为 note，在 ListItems / GetItem
// 读取路径上应用，让前端看到的 schema 中不再存在 wallet 类型。
//
// 设计取舍：
//   - DB 中原始数据不动（避免启动时全量重写事务），仅在读出后将 Type 厝制成 note；
//     当用户下次编辑该条目并保存时，前端会送 type="note"，UpdateItem 才会持久化迁移。
//   - 原有的 address / seed 字段同时合并进 fields["notes"]（仅在该字段为空时），
//     让用户在 note 详情页仍能读到助记词 / 地址，不造成数据丢失。
func migrateLegacyTypeInPlace(p *ItemPayload) {
	if p == nil || p.Type != legacyWalletType {
		return
	}
	p.Type = ItemTypeNote
	if p.Fields == nil {
		p.Fields = map[string]any{}
	}
	existingNote, _ := p.Fields["notes"].(string)
	if strings.TrimSpace(existingNote) != "" {
		return
	}
	address, _ := p.Fields["address"].(string)
	seed, _ := p.Fields["seed"].(string)
	var merged strings.Builder
	if address != "" {
		merged.WriteString("Address: ")
		merged.WriteString(address)
		merged.WriteString("\n")
	}
	if seed != "" {
		merged.WriteString("Seed phrase: ")
		merged.WriteString(seed)
	}
	if merged.Len() > 0 {
		p.Fields["notes"] = merged.String()
	}
}

// ItemPayload 是"条目的完整内容"在 Go 侧的内存表示
//
// 设计原则：**字段宽松**。后端不规定 LoginItem 必须有 username、CardItem
// 必须有 number 等 —— 那些校验放前端表单层做。后端仅保证：
//  1. ID / Type / Name 必填且类型合法
//  2. 整个结构能 JSON 序列化（用于加密前的 payload）
//  3. 反序列化后的字段名 / 嵌套结构与前端约定一致
//
// 用 map[string]any 存"额外字段"而不是为每种类型定义 struct：
//   - 后端只是"加密保险柜"，不参与业务逻辑解释
//   - 前端 TS 类型系统已经精确建模了 LoginItem / CardItem / ... 的差异
//   - 加新字段时前端独立改即可，不必同步改 Go struct
//   - JSON marshal/unmarshal 对 map[string]any 完全够用
//
// 字段映射（前端 → 后端）：
//
//	id        → ID         (UUID v4 / 短随机)
//	type      → Type       (枚举字符串)
//	name      → Name       (列表展示用，加密在 payload 内不单独存)
//	modified  → 由 UpdatedAt 派生，不在 payload 里持久化
//	一切其它字段（username/password/url/notes/totp/...） → Fields[]
type ItemPayload struct {
	ID   string   `json:"id"`
	Type ItemType `json:"type"`
	Name string   `json:"name"`
	// SpaceID 空间归属 —— 见 VaultItemRow.SpaceID。这是加密 payload 内的权威
	// 副本（随同步跨设备传播，对端解密后据此落本端 space_id 列）；DB 明文列
	// space_id 是它的查询投影。前端 createItem 时携带当前激活空间；decryptItem
	// 读出后会用 DB 行的 space_id 覆盖本字段（DB 列是读路径的事实来源）。
	// omitempty：v5 之前写入的老 payload 没有此字段，解码为 ""，读路径用 DB 列补上。
	SpaceID   string         `json:"spaceId,omitempty"`
	Fields    map[string]any `json:"fields"`    // 类型特定字段
	CreatedAt int64          `json:"createdAt"` // unix ms（后端写入，前端只读）
	UpdatedAt int64          `json:"updatedAt"` // unix ms（后端写入，前端只读）

	// DeletedAt 软删除时间戳（unix ms）—— 同步 tombstone。
	//
	// 用指针表达可空：nil = 未删除，*ptr > 0 = tombstone。
	// 设计要点：
	//   - ListItems / GetItem 必须过滤 DeletedAt 非 nil 的条目（对前端不可见）
	//   - 同步协议保留 tombstone 以告诉对端"此条已删除"，避免对端复活
	//   - 物理清除由未来的 GC 在 90 天后执行；当前阶段无限保留
	DeletedAt *int64 `json:"deletedAt,omitempty"`

	// Revision 单设备内写入版本号（每次 create/update/delete 递增）。
	// 不参与冲突判定（UpdatedAt 决定），仅用于审计 / 调试。
	Revision int64 `json:"revision,omitempty"`
}

// ItemSummary 是列表 API 返回的"轻量摘要" —— 包含足够渲染列表项的字段
// 但不含敏感字段（password / totp / seed 等）。
//
// 当前实现里 ListItems 必须解密所有 item 才能给出 name/type，所以摘要
// 与 payload 的成本差异不大；保留 Summary 作为独立类型主要是给前端 TS
// 留个清晰的"列表项 vs 详情"边界，未来如果改成"name 单独加密 + 详情
// 懒加载"也能平滑过渡。
type ItemSummary struct {
	ID        string   `json:"id"`
	Type      ItemType `json:"type"`
	Name      string   `json:"name"`
	CreatedAt int64    `json:"createdAt"`
	UpdatedAt int64    `json:"updatedAt"`
	// HasTOTP 表示该条目是否配置了 TOTP 密钥。
	// 列表接口在解密时顺手检查 fields["totp"] 是否非空字符串，
	// 避免前端需要额外 fetchItem 来判断条目是否出现在身份验证器视图。
	HasTOTP bool `json:"hasTOTP"`
}

// 暴露给前端的标准错误 —— 前端按 message 分支处理 UX。
// 这些 error 不携带任何关于"内部失败原因"的细节（避免给攻击者侧信道），
// 真正的诊断细节走 log，不进 IPC 响应。
var (
	// ErrVaultNotInitialized：vault 尚未设置主密码，前端应跳到引导页
	ErrVaultNotInitialized = errors.New("vault not initialized")

	// ErrVaultAlreadyInitialized：重复 Initialize 时返回；防御前端 bug
	ErrVaultAlreadyInitialized = errors.New("vault already initialized")

	// ErrVaultLocked：解锁前调用需要 DEK 的方法时返回；前端跳 UnlockPage
	ErrVaultLocked = errors.New("vault is locked")

	// ErrInvalidPassword：主密码错误 / Verifier 解密失败 / WrappedDEK 解
	// 密失败 都统一翻译成这个错误。模糊化是刻意的 —— 让攻击者无法
	// 区分"密码错"vs"DB 损坏"vs"参数被改"，减少侧信道。
	ErrInvalidPassword = errors.New("invalid master password")

	// ErrPasswordTooWeak：Initialize / ChangeMasterPassword 时主密码不
	// 满足最低强度要求。前端会展示提示让用户重输。
	ErrPasswordTooWeak = errors.New("master password too weak (minimum 8 characters)")

	// ErrSpaceNotSelected：在 currentSpaceID 为空（尚未 SetActiveSpace）时
	// 调用需要空间归属的写操作（CreateItem / UpdateItem / DeleteItem）返回。
	// 前端正常流程会在解锁后、首次 load 前先 SetActiveSpace，不应触达此分支；
	// 触达说明前端状态机有 bug（类似 Unlock 的「不做幂等捷径」防御思路）。
	ErrSpaceNotSelected = errors.New("no active space selected")
)

// ---------------------------------------------------------------------------
// VaultService
// ---------------------------------------------------------------------------

// VaultService 是注入到 Wails 应用的服务对象
//
// 字段：
//   - db：底层 SQLite 句柄包装；进程生命期内常驻，关闭由 main.go 兜底
//   - mu：保护内存中的 DEK / 解锁状态，避免并发竞态
//   - dek：解锁后的明文 DEK（32 字节）；锁定时为 nil 并被 WipeBytes 抹零
//
// 不内嵌 sync.Mutex 而是用字段：让 VaultService 的方法签名干净，且
// 反射注册到 Wails 时不会暴露 Lock/Unlock 等 mutex 方法（Wails 3 按
// 首字母大写筛选导出方法 —— sync.Mutex 的 Lock/Unlock 也是大写！）。
type VaultService struct {
	db  *VaultDB
	mu  sync.RWMutex
	dek []byte // 明文 DEK；nil = 已锁定

	// currentSpaceID 是「当前激活空间」的会话态（受 s.mu 保护，与 dek 同层）。
	//
	// 空间隔离的核心：所有面向用户的读写（ListItems / CreateItem / GetItem /
	// passkey 认证 / SSH agent / autofill / 导出）默认只作用于这个空间。前端
	// 在解锁后及每次切空间调 SetActiveSpace(id) 推送。后台入口（浏览器扩展的
	// passkey 认证、agent daemon 转发的 SSH sign、native host 的 autofill）
	// 自身拿不到「当前空间」，靠共享这个进程级会话态被统一约束 —— 这正是
	// 选「会话态」而非「每个 API 加 spaceId 参数」的根本原因。
	//
	// 取值约定：
	//   - ""  = 未选择空间。CreateItem/UpdateItem/DeleteItem 拒绝（ErrSpaceNotSelected）；
	//          ListItems 返回空列表（不报错，避免切空间瞬间 UI 抖动）。**绝不**
	//          用 "" 去匹配 DB 里 space_id='' 的 orphan —— 二者语义不同，必须解耦。
	//   - 非空 = 当前空间 id（与前端 spaces store 的 Space.id 对应）。
	//
	// 同步是唯一例外：sync 走 db 层全空间遍历，不读 currentSpaceID（见 syncservice）。
	//
	// 生命周期：Lock() 不清空它（空间选择是设备级偏好，跨锁定保留可减少解锁后
	// 重设的时序窗口）；进程级单状态，单 webview 桌面端足够。
	currentSpaceID string

	// breachCache 缓存 HIBP 泄露检测结果，key = 密码的 SHA-1 哈希（大写十六进制）。
	//
	// 设计要点：
	//   - 以「密码哈希」为 key 而非「itemId」：用户在多个站点用同一密码 → 只查 HIBP 一次；
	//     用户改了某条密码 → 哈希变了 → 自动 miss → 重查；删了再加同密码 → 命中缓存。
	//   - 仅在 unlock 周期内有效：Lock() 时清空，符合"锁定即清空内存视图"约定。
	//   - 复用 s.mu 读写锁保护，不引入新锁：写操作（写缓存项 / 清空）走 Lock()，
	//     读操作（命中检查）走 RLock()。
	//   - HIBP 数据库自身更新频率以"月"为单位，缓存常驻整个会话不会显著影响时效。
	breachCache map[string]breachCacheEntry

	// lastTsMs 是单调递增的毫秒时间戳水位线
	//
	// 为什么需要它：
	//   - time.Now().UnixMilli() 在 Windows 上的实际分辨率约 1-15 ms（取决于
	//     系统计时器配置）。如果用户在同一毫秒内连续调用 CreateItem 两次，
	//     或 Update 紧跟 Create，两条记录会拿到相同的 UpdatedAt —— 这会
	//     破坏"按 updated_at desc 排序"的列表稳定性，也让"刚改的记录排
	//     最前"的产品语义在边界条件下失效。
	//   - 系统时钟回拨（NTP 同步、用户手动改时间）也会让 UnixMilli 倒退，
	//     已存在的 item.UpdatedAt 可能比新写入的还大，列表顺序紊乱。
	//
	// 解法：每次需要新时间戳时取 max(time.Now().UnixMilli(), lastTsMs+1)，
	// 既贴合真实墙上时间，又保证严格单调递增。lastTsMs 受 s.mu 写锁保护，
	// 所有写路径（Initialize / Create / Update / Delete / 改密）都应通过
	// nowMs() 获取时间戳，不直接调用 time.Now().UnixMilli()。
	//
	// 注意：这是"服务进程内单调"，不是"绝对全局单调"。重启进程后水位线
	// 重置，新的 nowMs() 会再次以 time.Now().UnixMilli() 起步 —— 在多数
	// 场景下足够（用户重启 app 至少要 1 秒以上，时钟肯定推进过）。如果
	// 真要跨进程单调，需要把 lastTsMs 持久化到 vault_meta，当前不必要。
	lastTsMs int64

	// hotpAdvanceMu serializes HOTP counter advance operations.
	//
	// Why a separate lock instead of reusing s.mu:
	//   - AdvanceHOTPCounter is read-modify-write: load counter, +1, persist.
	//     Without atomicity, two concurrent advances may both read N, both
	//     compute N+1, both write N+1 - counter only advances by 1 instead
	//     of 2, causing HOTP desync against the server.
	//   - Can't reuse s.mu directly: GetItem/UpdateItem internally lock s.mu;
	//     since sync.Mutex is non-reentrant, holding s.mu around them deadlocks.
	//   - hotpAdvanceMu sits ABOVE s.mu in lock ordering: take hotpAdvanceMu
	//     first, then GetItem/UpdateItem manage s.mu themselves.
	//
	// Granularity: global rather than per-item. HOTP is low-frequency (user
	// presses a button), so global serialization is not a throughput concern
	// and avoids the bookkeeping of a per-item lock map.
	//
	// Lock ordering: any code path that needs both hotpAdvanceMu and s.mu
	// MUST acquire hotpAdvanceMu first. Currently only AdvanceHOTPCounter
	// uses this lock.
	hotpAdvanceMu sync.Mutex

	// sshAgentNotifier 是 SSH agent 服务的后向通知接口
	//
	// 设置时机：由 main.go 在 service 实例创建后调 setSshAgentNotifier
	// 注入，避免循环依赖（VaultService 不能直接 import SshAgentService
	// 的具体类型 —— 二者同在 main 包不存在 import 物理问题，但语义
	// 上仍是 vault 是底层、ssh agent 是上层）。
	//
	// nil 允许 —— 未启用 SSH agent 功能时仍能处于合法状态。调用点
	// 都需要 nil check（或使用辅助函数 notifySshAgent*）。
	sshAgentNotifier SshAgentNotifier

	// emit 用于向前端发送 vault 变更事件。
	//
	// 浏览器扩展 / native bridge 可以在 GUI 进程内直接写入 vault（例如
	// WebAuthn passkey 注册），这类写入绕过了前端 zustand action。如果
	// 不发事件，桌面列表只能等用户手动刷新后才看到新条目。emit 由 main.go
	// 在 application.New 后注入；nil 表示没有 Wails 前端监听者。
	eventMu sync.RWMutex
	emit    func(event string, payload any)
}

// SshAgentNotifier 是 VaultService 反向通知 SSH agent 的接口
//
// 不直接引用 *SshAgentService 是为了让三点：
//  1. 接口化后单测可以用 mock notifier 验证 vault 调用语义
//  2. 调用点不必担心 SshAgentService 的实现细节
//  3. 如果未来要加别的“vault 变更订阅者”（如浏览器拓展 autofill bridge）
//     可复用同一接口
//
// 接口调用约定：实现须在内部加锁保护状态，且不能同步阶段
// 调用回 VaultService 的任何需要 mu 的方法 —— 否则会死锁。发现需要取 vault
// 数据时，实现需启 goroutine 异步处理。
type SshAgentNotifier interface {
	// NotifyVaultUnlocked 在 vault 解锁后调 —— 同步状态 + 推送 keys
	NotifyVaultUnlocked()
	// NotifyVaultLocked 在 vault 锁定后调 —— 推送 unlocked=false
	NotifyVaultLocked()
	// PushVaultKeys 重新读 vault 中的 ssh 条目并推给 agent
	PushVaultKeys() error
}

// NewVaultService 构造一个新 VaultService
//
// 参数 db 由 main.go 的启动流程提供（OpenVaultDB 在 main 里跑一次）。
// 这种依赖注入让单元测试可以塞 mock DB；也让 Wails 启动顺序明确：
// 先建 DB，再建 Service，再 application.NewService 注册。
func NewVaultService(db *VaultDB) *VaultService {
	return &VaultService{db: db}
}

// setSshAgentNotifier 注入 SSH agent 服务的后向通知接口
//
// 由 main.go 在两个 service 都创建后调用一次。传 nil 可以解除通知
// （主要单测场景）。
//
// 本方法不加锁 —— 预计仅在 main 启动期调用一次，运行期不会变。运行
// 期动态切换 notifier 的场景（如重启 SSH agent 服务）不会出现，因为
// SshAgentService 是进程级单例。
//
// 注意：故意 unexported —— 这是后端依赖注入用，不应该被 wails3 binding
// 暴露给前端。若改成 exported，wails3 binding generator 会扫到此方法
// 参数中的 interface 类型 SshAgentNotifier，发出 JSON 反序列化警告，
// 并且前端可借此 setter 解除 SSH agent 通知（意外的攻击面）。
// SetSshAgentNotifier injects the SSH-agent service so VaultService can
// notify it on unlock/lock and on SSH-item changes. Exported so the main
// command can wire the back-reference after both services exist.
func (s *VaultService) SetSshAgentNotifier(n SshAgentNotifier) {
	s.setSshAgentNotifier(n)
}

func (s *VaultService) setSshAgentNotifier(n SshAgentNotifier) {
	s.sshAgentNotifier = n
}

// notifySshAgentSafe 给物理调用点用的「安全调用」辅助 —— nil check + recover
//
// notifier 实现可能报 panic（代码 bug），在 vault 主路径上不该以此炸须
// vault 服务。用 defer recover 兑提供「通知是 best-effort」语义。
func (s *VaultService) notifySshAgentSafe(op func(SshAgentNotifier)) {
	n := s.sshAgentNotifier
	if n == nil {
		return
	}
	defer func() {
		// notifier 出 panic 不该让 vault 主路径崩；log 后安全继续
		if r := recover(); r != nil {
			fmt.Printf("[vault] ssh-agent notifier panic: %v\n", r)
		}
	}()
	op(n)
}

// nowMs 返回严格单调递增的毫秒时间戳
//
// 调用方必须已经持有 s.mu 写锁 —— 本函数会读写 s.lastTsMs，无锁竞态会让
// 单调性失效。所有写路径（Initialize / CreateItem / UpdateItem /
// ChangeMasterPassword）都应通过此方法取时间戳，避免在毫秒粒度过粗的
// 平台（Windows）出现两次连续操作时间相同 / 时钟回拨倒退的问题。
//
// 算法：max(time.Now().UnixMilli(), lastTsMs + 1)
//   - 正常情况下贴合真实墙上时间
//   - 同毫秒内连续调用：每次 +1 ms，保持递增
//   - 时钟回拨：忽略系统时钟，继续以 lastTsMs+1 推进
func (s *VaultService) nowMs() int64 {
	wall := time.Now().UnixMilli()
	next := wall
	if next <= s.lastTsMs {
		next = s.lastTsMs + 1
	}
	s.lastTsMs = next
	return next
}

// ---------------------------------------------------------------------------
// 状态查询
// ---------------------------------------------------------------------------

// IsUnlocked 返回当前 vault 是否处于解锁状态
//
// 与 Status() 的区别：
//   - Status 给前端（Wails 导出），返回完整 VaultStatus，会读 DB
//   - IsUnlocked 仅给同一 main 包内其它代码用（如 SshAgentService），
//     快路径，只看内存 dek 状态，不抽 DB
//
// 并发安全：内部取读锁，可在任何 goroutine 调用。调用方不需要产生
// 其它同步手动。
func (s *VaultService) IsUnlocked() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.dek != nil
}

// Status 返回 vault 当前状态快照
//
// 前端在路由守卫里调用 Status 决定渲染哪个屏：
//   - 未初始化 → /onboarding（设置主密码）
//   - 已初始化未解锁 → /unlock
//   - 已解锁 → /vault
//
// 此方法不需要 DEK，可在锁定状态下安全调用。
func (s *VaultService) Status() (VaultStatus, error) {
	hasMeta, err := s.db.HasMeta()
	if err != nil {
		return VaultStatus{}, fmt.Errorf("check meta: %w", err)
	}
	st := VaultStatus{Initialized: hasMeta}

	s.mu.RLock()
	defer s.mu.RUnlock()
	st.Unlocked = s.dek != nil

	// 仅在解锁状态下暴露条目数 —— 锁定时连 COUNT(*) 都不报，最小化侧
	// 信道信息（虽然条目数从加密 vault 推断不出明文，但攻击者根本拿
	// 不到这个数据库时也不应通过 IPC 探到）。
	if st.Unlocked && hasMeta {
		// 用 SQL COUNT 过滤 tombstone，避免每次 Status 都全表解密
		if n, err := s.db.CountLiveItems(); err == nil {
			st.ItemCount = n
		}
		// CountLiveItems 失败时 ItemCount 留 0，不让 Status 整个失败 —— 状态
		// 探测要尽可能容错。
	}
	return st, nil
}

// ---------------------------------------------------------------------------
// 初始化（首次设置主密码）
// ---------------------------------------------------------------------------

// Initialize 首次创建 vault：生成 salt / DEK / Verifier，落盘 vault_meta，
// 并立即把 vault 置为"已解锁"状态（持有 DEK），用户无需重新输入密码就
// 可以开始添加条目。
//
// 为什么 Initialize 后直接进入解锁态：
//   - 与产品流程对齐：用户在 Onboarding 设完主密码 → 立刻进主界面 → 添加
//     第一条记录。如果 Initialize 之后还要立刻调一次 Unlock 输同样的密码，
//     UX 莫名其妙
//   - 安全上等价：刚刚做完 Argon2id 派生，KEK 和 DEK 都已经在内存里，
//     "已解锁"只是不再丢弃 DEK 而已
//
// 错误：
//   - vault 已经初始化过 → ErrVaultAlreadyInitialized
//   - 密码弱 / 空 → ErrPasswordTooWeak
//   - 加密 / DB 写入失败 → 内部错误（包装上抛）
func (s *VaultService) Initialize(password string) error {
	// 在拿写锁之前做廉价校验，避免长时间持锁
	if err := validatePasswordStrength(password); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// 防御重复初始化：检查 DB 是否已经有 meta 行
	hasMeta, err := s.db.HasMeta()
	if err != nil {
		return fmt.Errorf("check meta: %w", err)
	}
	if hasMeta {
		return ErrVaultAlreadyInitialized
	}

	// 1. 生成随机 salt（KDF 输入）和 DEK（数据加密密钥）
	salt, err := GenerateRandomBytes(SaltSize)
	if err != nil {
		return fmt.Errorf("gen salt: %w", err)
	}
	dek, err := GenerateRandomBytes(KeySize)
	if err != nil {
		return fmt.Errorf("gen dek: %w", err)
	}

	// 2. 派生 KEK（Argon2id 慢哈希，~250-400ms）
	params := DefaultArgon2id()
	kek, err := DeriveKEK(password, salt, params)
	if err != nil {
		return fmt.Errorf("derive kek: %w", err)
	}
	// 用完 KEK 立即抹零；DEK 保留在 s.dek（解锁状态）
	defer WipeBytes(kek)

	// 3. 用 KEK 包装 DEK（aad="zpass:dek" 绑定上下文）
	wrappedDEK, err := SealAEAD(kek, dek, []byte(aadDEK))
	if err != nil {
		return fmt.Errorf("wrap dek: %w", err)
	}

	// 4. 用 DEK 加密 verifier（aad="zpass:verifier"）
	//    Unlock 时反向操作：拿候选密码派生 KEK → 解 wrappedDEK → 解 verifier
	//    解 verifier 成功且明文匹配 → 密码正确
	verifier, err := SealAEAD(dek, []byte(VerifierPlaintext), []byte(aadVerifier))
	if err != nil {
		return fmt.Errorf("seal verifier: %w", err)
	}

	// 5. 写 vault_meta
	now := s.nowMs()
	meta := &VaultMeta{
		Version:    vaultSchemaVersion,
		KDF:        kdfNameArgon2id,
		KDFSalt:    salt,
		KDFParams:  params,
		WrappedDEK: wrappedDEK,
		Verifier:   verifier,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if err := s.db.WriteMeta(meta); err != nil {
		return fmt.Errorf("write meta: %w", err)
	}

	// 6. 持有 DEK，进入解锁状态
	s.dek = dek
	return nil
}

// ---------------------------------------------------------------------------
// 解锁 / 锁定
// ---------------------------------------------------------------------------

// Unlock 用主密码解锁 vault
//
// 流程：
//  1. 读 vault_meta（拿 salt / params / wrappedDEK / verifier）
//  2. Argon2id(password, salt) → KEK
//  3. OpenAEAD(KEK, wrappedDEK) → DEK
//  4. OpenAEAD(DEK, verifier) → 应该等于 VerifierPlaintext
//  5. 一切通过则把 DEK 存进 s.dek，进入解锁态
//
// 失败的所有路径（vault 未初始化除外）都翻译成 ErrInvalidPassword：
//   - WrappedDEK 解密失败 → 密码错（KEK 错，AEAD tag 失败）
//   - Verifier 解密失败 → 密码错（DEK 错，AEAD tag 失败）
//   - Verifier 明文不匹配 → 密码错（理论上 AEAD tag 已经堵死这条路，
//     但显式 bytes.Equal 多一层防御）
//
// 这种"统一返回错误"是刻意的 —— 让攻击者无法通过错误信息细分原因，
// 也让前端不需要分支处理一堆边界情况。
//
// ---------------------------------------------------------------------------
// 重要：为什么**不**做"已解锁就直接返回成功"的幂等捷径
//
// 早期版本里这里有一段 `if s.dek != nil { return nil }` 的快捷路径，
// 本意是让重复 Unlock 调用幂等。**这是严重安全漏洞**：
//
//	场景复现：
//	  1. 用户首次 Initialize → s.dek 持有有效 DEK
//	  2. 用户通过某入口"锁定"（前端有多个 lock 入口，部分历史实现仅
//	     翻前端 useLockStore.locked 标志位、漏调 vaultApi.Lock）
//	  3. 后端 s.dek 仍然 != nil
//	  4. 用户被路由守卫送回 /unlock 页
//	  5. 输入**任何**密码（包括错的）→ 命中幂等捷径 → 返回 nil
//	  6. 前端以为解锁成功，进入主界面 —— 攻击者用空密码即可绕过！
//
// 修复策略：永远做完整的 KDF + AEAD 验证，不信任内存状态做捷径。代价
// 是已解锁状态下重复 Unlock 会再跑一次 250-400ms 的 Argon2id —— 但
// 这种调用本来就是异常路径（用户已经在主界面了为什么要再解锁？），慢
// 一点反而是正确的反馈，告诉前端"你的状态机有 bug 该 sync 一下了"。
//
// 验证策略：派生 KEK + 解 wrappedDEK + 解 verifier。全通过才认为密码
// 正确；通过后**用新派生的 DEK 替换 s.dek**（理论上字节相同，但显式
// 替换 + WipeBytes 老 dek 的"恒新"语义更清晰，避免内存里同时存两份
// DEK 副本被 swap 暴露）。任何一步失败都返回 ErrInvalidPassword 且
// **不**清除当前 s.dek —— 正合法用户的会话不应被攻击者的错误尝试打断。
func (s *VaultService) Unlock(password string) error {
	if password == "" {
		return ErrInvalidPassword
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	meta, err := s.db.ReadMeta()
	if err != nil {
		return fmt.Errorf("read meta: %w", err)
	}
	if meta == nil {
		return ErrVaultNotInitialized
	}

	// 派生 KEK（慢哈希）—— 即使 s.dek 已存在也强制做完整验证，不走捷径。
	// 见函数头部"为什么不做幂等捷径"的注释。
	kek, err := DeriveKEK(password, meta.KDFSalt, meta.KDFParams)
	if err != nil {
		// DeriveKEK 内部错误（参数非法等）—— 模糊化为"密码错"
		// 不动 s.dek：合法用户的会话不应被错误尝试打断
		return ErrInvalidPassword
	}
	defer WipeBytes(kek)

	// 用 KEK 解出 DEK
	dek, err := OpenAEAD(kek, meta.WrappedDEK, []byte(aadDEK))
	if err != nil {
		// AEAD tag 失败 = 密码错；不抛底层 err 信息，不动 s.dek
		return ErrInvalidPassword
	}

	// 验证 DEK 能正确解 verifier —— 双重防御：
	//   即使前面 OpenAEAD 因为某种巧合通过了（理论上不会），verifier 这
	//   一层会再过一遍 AEAD tag。同时 verifier 明文有版本号，未来格式
	//   迁移可以从这里识别出"老 vault 版本"。
	verPlain, err := OpenAEAD(dek, meta.Verifier, []byte(aadVerifier))
	if err != nil {
		WipeBytes(dek)
		return ErrInvalidPassword
	}
	if string(verPlain) != VerifierPlaintext {
		WipeBytes(dek)
		WipeBytes(verPlain)
		return ErrInvalidPassword
	}
	WipeBytes(verPlain)

	// 通过所有校验 —— 持有 DEK。
	// 如果之前已经持有一份 dek（重复 Unlock 场景），先把老的抹零再替换，
	// 避免内存里短暂存在两份 DEK 副本扩大密钥泄露窗口。
	if s.dek != nil {
		WipeBytes(s.dek)
	}
	s.dek = dek

	// 通知 SSH agent vault 已解锁 —— 他会推 OpState 给 zpass-agent
	// 并拉全量 SSH 公钥。这里不能同步等 —— PushVaultKeys 会调
	// ListItems/GetItem，需 mu.RLock。我们现在持有 mu 写锁，同步调
	// 会死锁。NotifyVaultUnlocked 实现内部已经启 goroutine 处理。
	s.notifySshAgentSafe(func(n SshAgentNotifier) {
		n.NotifyVaultUnlocked()
	})
	return nil
}

// Lock 显式锁定 vault：抹零内存中的 DEK
//
// 幂等：未解锁时调用直接返回 nil。
//
// 调用方：
//   - 用户点"立即锁定"按钮
//   - 空闲超时（前端定时器到点后调）
//   - 系统休眠唤醒（未来加平台事件订阅）
//
// 注意：Lock 不影响 vault.db 文件，只清内存状态。下次 Unlock 必须重新
// 派生 KEK + 解 DEK（用户重新输入主密码）。
func (s *VaultService) Lock() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.dek != nil {
		WipeBytes(s.dek)
		s.dek = nil
	}
	// 清空 HIBP 泄露检测缓存 —— 与 dek 同周期，符合"锁定即清空内存视图"约定。
	// 不同用户切换 vault 时，前一个用户的密码哈希查询结果不应被复用。
	s.breachCache = nil

	// 同步通知 SSH agent 进入锁定状态 —— agent 会拒绝后续所有 sign 请求。
	// 调用是同步的但 NotifyVaultLocked 不读 vault 数据，不存在重入锁问题。
	s.notifySshAgentSafe(func(n SshAgentNotifier) {
		n.NotifyVaultLocked()
	})
	return nil
}

// ---------------------------------------------------------------------------
// 空间隔离（Space）
// ---------------------------------------------------------------------------

// SetActiveSpace 设置「当前激活空间」会话态
//
// 前端在以下时机调用：
//   - 解锁成功后、首次 ListItems 之前（保证 currentSpaceID 在第一次读之前就位）
//   - 用户通过 WorkspaceSwitcher 切换空间时
//
// 不要求 vault 已解锁 —— 前端可能在解锁流程中先设空间；真正需要 DEK 的 CRUD
// 仍各自校验 s.dek。spaceID 不能为空（空 = 未选择，是 CRUD 的拒绝态，不应被
// 显式设置）。
//
// 副作用：切换空间后主动通知 SSH agent 重推公钥 —— 严格隔离下 agent 只应暴露
// 当前空间的 ssh key，切空间必须让 agent 立即刷新（否则它持有旧空间的 key
// 直到下次 vault 变更事件）。通知在锁外异步发，避免 PushVaultKeys 内部 RLock
// 与本处写锁重入死锁。
func (s *VaultService) SetActiveSpace(spaceID string) error {
	if strings.TrimSpace(spaceID) == "" {
		return errors.New("spaceID cannot be empty")
	}
	s.mu.Lock()
	changed := s.currentSpaceID != spaceID
	s.currentSpaceID = spaceID
	s.mu.Unlock()

	if changed {
		s.notifySshAgentSafe(func(n SshAgentNotifier) {
			go func() { _ = n.PushVaultKeys() }()
		})
	}
	return nil
}

// GetActiveSpace 返回当前激活空间 id（"" = 未选择）
//
// 给前端回读校验用（确认后端会话态与前端 activeSpaceId 一致）。在锁定态也
// 可安全调用。
func (s *VaultService) GetActiveSpace() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.currentSpaceID
}

// ClaimOrphanItems 把所有「未归属空间」（space_id=”）的历史条目认领到指定空间
//
// 用途：v4→v5 迁移后老条目 space_id 为空（orphan）。前端首次解锁后调用本方法
// （传当前激活空间）把这批历史数据一次性归到用户当前所在的空间，并由前端持久化
// 一个「已认领」标记防止重复调用。
//
// 实现要点：
//   - 对每条 orphan：解密 → 设 payload.SpaceID=spaceID → 重新加密(aad=id) →
//     UpdateItemSpace（同时改 payload 与 space_id 列）。**时间戳不变** —— 认领不是
//     「修改」，不污染列表排序，也不污染同步 LWW。
//   - 含 tombstone（ListOrphanItems 返回墓碑）：墓碑也认领，否则它们永远 orphan
//     且会把「未归属」状态传播给同步对端造成漂移。
//   - 密文损坏无法解密的条目：仅用 SetItemSpace 改 space_id 列（至少脱离 orphan），
//     log 跳过，不让一条坏数据中断整批认领。
//
// 返回认领的条目数。幂等：再次调用时已无 orphan，返回 0。需要 dek（已解锁）。
func (s *VaultService) ClaimOrphanItems(spaceID string) (int, error) {
	if strings.TrimSpace(spaceID) == "" {
		return 0, errors.New("spaceID cannot be empty")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dek == nil {
		return 0, ErrVaultLocked
	}

	rows, err := s.db.ListOrphanItems()
	if err != nil {
		return 0, fmt.Errorf("list orphan items: %w", err)
	}

	claimed := 0
	for i := range rows {
		row := &rows[i]
		payload, err := s.decryptItem(row)
		if err != nil {
			// 密文损坏：仅改 space_id 列，至少脱离 orphan（否则每次启动都重扫）
			fmt.Printf("[vault] claim orphan: decrypt %s failed: %v\n", row.ID, err)
			if e := s.db.SetItemSpace(row.ID, spaceID); e != nil {
				fmt.Printf("[vault] claim orphan: set space %s failed: %v\n", row.ID, e)
				continue
			}
			claimed++
			continue
		}
		// decryptItem 把 payload.SpaceID 设成了 row.SpaceID（=''），这里覆盖为目标空间
		payload.SpaceID = spaceID
		plaintext, err := json.Marshal(payload)
		if err != nil {
			fmt.Printf("[vault] claim orphan: marshal %s failed: %v\n", row.ID, err)
			continue
		}
		ciphertext, err := SealAEAD(s.dek, plaintext, []byte(row.ID))
		WipeBytes(plaintext)
		if err != nil {
			fmt.Printf("[vault] claim orphan: seal %s failed: %v\n", row.ID, err)
			continue
		}
		if err := s.db.UpdateItemSpace(row.ID, spaceID, ciphertext); err != nil {
			fmt.Printf("[vault] claim orphan: update %s failed: %v\n", row.ID, err)
			continue
		}
		claimed++
	}

	if claimed > 0 {
		// 认领改变了当前空间的可见集合，通知前端刷新列表
		s.notifyVaultChanged("claim-orphans", "", "")
	}
	return claimed, nil
}

// CountItemsInSpace 返回指定空间的未删除条目数（不切换当前激活空间）
//
// 给前端「删除空间」前的非空校验用：禁止删除还有条目的空间，避免留下永久不可见
// 且仍参与同步的孤儿数据（删空间只删前端 UI 记录，后端 vault_items 不会被清）。
// 需要 dek（已解锁）—— count 本身不解密，但锁定态不暴露条目数（与 Status 的侧
// 信道考量一致）。spaceID 为空返回 0。
func (s *VaultService) CountItemsInSpace(spaceID string) (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.dek == nil {
		return 0, ErrVaultLocked
	}
	if strings.TrimSpace(spaceID) == "" {
		return 0, nil
	}
	return s.db.CountLiveItemsBySpace(spaceID)
}

// ClearSpace 软删除指定空间内的所有活动条目（写 tombstone），返回清空的条目数
//
// 用途：设置页「清空空间内账户」—— 删除空间前必须先清空（禁止删非空空间）。
//
// 为什么软删除而非物理删除：与 DeleteItem 一致，同步需要 tombstone 让对端也
// 删除对应条目，否则下次同步对端会把它们当「我有他没有的新条目」复活回来。
//
// **不受 currentSpaceID 约束**：用户在设置页可对任意空间（含非当前激活空间）
// 操作，故按传入 spaceID 直接清空，不做空间门禁。复用 softDeleteRowLocked，
// 每条会各自通知 SSH agent / 前端 vault:changed（前端有防抖会合并成一次刷新）。
//
// 单条软删除失败 log + 跳过，不让一条损坏中断整批。需要 dek（已解锁）。
func (s *VaultService) ClearSpace(spaceID string) (int, error) {
	if strings.TrimSpace(spaceID) == "" {
		return 0, errors.New("spaceID cannot be empty")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dek == nil {
		return 0, ErrVaultLocked
	}

	// ListItemsBySpace 只返回活动行（deleted_at IS NULL），正好是要清空的集合；
	// 已是 tombstone 的不在内，避免重复写墓碑污染同步顺序。
	rows, err := s.db.ListItemsBySpace(spaceID)
	if err != nil {
		return 0, fmt.Errorf("list space items: %w", err)
	}

	cleared := 0
	for i := range rows {
		if err := s.softDeleteRowLocked(rows[i].ID, &rows[i]); err != nil {
			fmt.Printf("[vault] clear space: soft delete %s failed: %v\n", rows[i].ID, err)
			continue
		}
		cleared++
	}
	return cleared, nil
}

// ---------------------------------------------------------------------------
// 信任设备 / 自动解锁
// ---------------------------------------------------------------------------
//
// 「信任设备」让用户在指定设备上重启 ZPass 后无需输入主密码即可进入保险库。
// 实现思路：把 DEK 用 OS 设备绑定密钥（Windows DPAPI / macOS Keychain /
// Linux libsecret）再加密一层，落盘到 vault_trusted_device 表。下次启动
// 直接用 OS API 解封还原 DEK，跳过主密码 KDF 流程。
//
// 详见：
//   - trusteddevice.go            跨平台接口与安全模型
//   - trusteddevice_windows.go    DPAPI 实现（与 Bitwarden「永不超时」明文
//                                 落盘相比的优势对照）
//   - frontend/src/app/LockSync.tsx 启动时优先尝试 trusted-device 解锁
//
// 安全约束：
//   1. 启用必须在已解锁状态下进行 + 二次验证主密码（防止已被劫持的会话
//      恶意启用），见 EnableTrustedDevice 注释
//   2. 关闭无需主密码（只是降低安全等级，不存在提权风险）
//   3. ChangeMasterPassword 不影响 trusted blob —— DEK 不变就不需要重新
//      封装；trusted blob 包装的是 DEK 本身
//   4. Unprotect 失败时静默清掉 vault_trusted_device 行 —— 调用方据此
//      回退到主密码模式，不向用户暴露 DPAPI/Keychain 内部错误

// IsTrustedDeviceSupported 当前平台是否支持「信任设备」自动解锁
//
// 在锁定状态下也能安全调用 —— 不需要 DEK，仅探测 OS API 可用性。
// 前端用此结果决定 SettingsPage 开关是否置灰。
//
// Windows 始终返回 true；非 Windows 平台当前返回 false（见
// trusteddevice_unsupported.go）。
func (s *VaultService) IsTrustedDeviceSupported() bool {
	return trustedDeviceProtector != nil && trustedDeviceProtector.Available()
}

// IsTrustedDeviceEnabled 当前 vault 是否已经在此设备启用了自动解锁
//
// 在锁定状态下也能安全调用 —— 仅查询单例表是否有行。前端用此结果决定
// SettingsPage 开关的初始勾选状态。
//
// 注意：返回 true 仅表示 vault_trusted_device 有行，不代表 blob 真的能
// 解开（OS 凭据可能已变化）。真正解封要等 TryUnlockWithTrustedDevice
// 实际调用 Unprotect。
func (s *VaultService) IsTrustedDeviceEnabled() (bool, error) {
	return s.db.HasTrustedDevice()
}

// EnableTrustedDevice 启用「在此设备上自动解锁」
//
// 流程：
//  1. 检查平台支持（不支持直接报错，前端不应让用户走到这步）
//  2. 检查已解锁（必须持有 DEK 才能封装）
//  3. **必须**用 confirmPassword 二次验证主密码身份 —— 防止已被劫持的
//     会话（攻击者短暂控制了已解锁的进程）恶意启用此功能从而长期免密
//     访问。这一步走完整 KDF + AEAD 验证，与 Unlock 同等强度。
//  4. 用 trustedDeviceProtector 包装 s.dek 得到 blob
//  5. 写入 vault_trusted_device
//
// 错误：
//   - 平台不支持             → ErrTrustedDeviceUnsupported
//   - vault 锁定             → ErrVaultLocked（前端应当不可触达此分支）
//   - confirmPassword 不正确 → ErrInvalidPassword
//   - DPAPI/OS 调用失败      → 包装上抛
func (s *VaultService) EnableTrustedDevice(confirmPassword string) error {
	if trustedDeviceProtector == nil || !trustedDeviceProtector.Available() {
		return ErrTrustedDeviceUnsupported
	}
	if confirmPassword == "" {
		return ErrInvalidPassword
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.dek == nil {
		return ErrVaultLocked
	}

	meta, err := s.db.ReadMeta()
	if err != nil {
		return fmt.Errorf("read meta: %w", err)
	}
	if meta == nil {
		return ErrVaultNotInitialized
	}

	// 二次验证主密码 —— 走与 Unlock 等价的 KDF + AEAD 路径，确保此刻
	// 输入密码的人确实知道主密码。这里必须做完整验证，不能仅比对
	// "派生出的 DEK 是否等于内存中的 s.dek"（虽然字节相等就足够证明），
	// 因为后者会让"DEK 已被泄漏到攻击者手里"的极端场景下绕过验证。
	kek, err := DeriveKEK(confirmPassword, meta.KDFSalt, meta.KDFParams)
	if err != nil {
		return ErrInvalidPassword
	}
	defer WipeBytes(kek)

	candidateDEK, err := OpenAEAD(kek, meta.WrappedDEK, []byte(aadDEK))
	if err != nil {
		return ErrInvalidPassword
	}
	defer WipeBytes(candidateDEK)

	if !constantTimeEqual(candidateDEK, s.dek) {
		// 派生出的 DEK 与内存中的不一致 —— 极端异常状态
		// （vault_meta 被外部改过 / DEK 内存损坏 / 多窗口竞态）。
		// 拒绝继续，避免把"错误的 DEK"封装进 trusted blob 导致下次
		// 自动解锁后所有条目都解不开。
		return ErrInvalidPassword
	}

	// 验证通过 —— 用 OS 设备绑定密钥包装 DEK
	blob, err := trustedDeviceProtector.Protect(s.dek)
	if err != nil {
		return fmt.Errorf("trusted device protect: %w", err)
	}

	row := &TrustedDeviceRow{
		Method:    trustedDeviceProtector.Method(),
		Blob:      blob,
		CreatedAt: s.nowMs(),
	}
	if err := s.db.WriteTrustedDevice(row); err != nil {
		return fmt.Errorf("write trusted_device: %w", err)
	}
	return nil
}

// DisableTrustedDevice 关闭「在此设备上自动解锁」
//
// 不需要主密码确认 —— 关闭只是降低安全等级（下次启动重新要求输主密码），
// 不存在提权风险。即便恶意会话调用此方法，最坏后果也只是合法用户下次启动
// 多输一次密码而已。
//
// 幂等：未启用时调用直接返回 nil。
//
// 错误：
//   - DB I/O 失败 → 包装上抛
func (s *VaultService) DisableTrustedDevice() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.DeleteTrustedDevice()
}

// TryUnlockWithTrustedDevice 启动时尝试用「信任设备」自动解锁
//
// 设计：返回 (success bool, error)，bool 表达「是否已解锁成功」，error
// 仅在 DB I/O 等真异常时非 nil。
//   - (false, nil) 是合法返回，表示「未启用 / Unprotect 失败 / OS 凭据
//     已变化」等所有需要让用户走主密码流程的情况。前端不应该把这种
//     情况展示为错误。
//   - (true, nil)  解锁成功，s.dek 已注入；前端应当 navigate 到主界面。
//   - (_, err)     仅 vault_meta 损坏 / DB 不可读等真异常时返回。
//
// Unprotect 失败的处理：
//
//	静默调 db.DeleteTrustedDevice() 清掉过期 blob。原因见 EnableTrustedDevice
//	头部对 OS 凭据变化的分析。下次启动用户只会被要求输一次主密码，
//	完全不会看到任何错误提示。
//
// 幂等：
//   - 已经持有 s.dek 时（webview 刷新场景）直接返回 (true, nil)，不重复
//     做 DB 读 + Unprotect 的开销。这与 LockSync 中已有的 status 探测
//     行为对齐。
//
// 调用频率：每次 webview 挂载时调一次，由 LockSync 触发。
func (s *VaultService) TryUnlockWithTrustedDevice() (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// 已解锁 → 直接返回，不必重复读盘
	if s.dek != nil {
		return true, nil
	}

	// 平台不支持就直接告诉前端「没启用」即可，错误码留给手动启用流程用
	if trustedDeviceProtector == nil || !trustedDeviceProtector.Available() {
		return false, nil
	}

	row, err := s.db.ReadTrustedDevice()
	if err != nil {
		return false, fmt.Errorf("read trusted_device: %w", err)
	}
	if row == nil {
		// 未启用 —— 完全合法路径，让前端走主密码流程
		return false, nil
	}

	// 防御 method 不匹配（理论上不会发生：只有同平台的 Protect 能写入
	// 当前平台 Method 标识；跨平台拷 vault.db 才会触发）
	if row.Method != trustedDeviceProtector.Method() {
		// 静默清掉异常行 —— 与 Unprotect 失败同样处理
		_ = s.db.DeleteTrustedDevice()
		return false, nil
	}

	dek, err := trustedDeviceProtector.Unprotect(row.Blob)
	if err != nil {
		// Unprotect 失败 = OS 凭据已变化 → 静默清行回退主密码流程
		// 不把 err 上抛 —— 用户看到「自动解锁失败」会困惑，让 UnlockPage
		// 自然显示主密码输入框即可
		_ = s.db.DeleteTrustedDevice()
		return false, nil
	}

	// 健全性检查：DEK 字节长度必须等于 KeySize（DEK 是 32 字节随机串）
	// 防御 blob 被外部篡改成解出来"看似成功但长度不对"的字节
	if len(dek) != KeySize {
		WipeBytes(dek)
		_ = s.db.DeleteTrustedDevice()
		return false, nil
	}

	// 进一步验证：用解出的 DEK 解 verifier，确保它确实是当前 vault 的 DEK
	// 而不是攻击者塞进 trusted_device 表的某个其它字节串
	meta, err := s.db.ReadMeta()
	if err != nil || meta == nil {
		WipeBytes(dek)
		return false, fmt.Errorf("read meta during trusted unlock: %w", err)
	}
	verPlain, err := OpenAEAD(dek, meta.Verifier, []byte(aadVerifier))
	if err != nil || string(verPlain) != VerifierPlaintext {
		// verifier 不匹配 —— blob 被篡改或对应不上当前 vault
		// 当 vault 经历过"删除 → 重新初始化"流程而 trusted_device 行
		// 没被同步清掉时也会落到这里。同样静默回退。
		if verPlain != nil {
			WipeBytes(verPlain)
		}
		WipeBytes(dek)
		_ = s.db.DeleteTrustedDevice()
		return false, nil
	}
	WipeBytes(verPlain)

	// 全部验证通过 —— 进入解锁态
	s.dek = dek
	return true, nil
}

// ---------------------------------------------------------------------------
// 修改主密码
// ---------------------------------------------------------------------------

// ChangeMasterPassword 修改主密码
//
// 关键设计：**不重写所有 vault_items**。
//   - 用旧密码派生 oldKEK → 解出 DEK
//   - 用新密码派生 newKEK（生成新 salt，更新参数到 DefaultArgon2id）
//   - 用 newKEK 重新包装同一个 DEK → 写回 wrappedDEK
//   - DEK 不变 → 所有 item 密文不变 → 不需要重写大量数据
//
// 这是双层密钥架构的最大优势之一。1Password / Bitwarden / Proton Pass
// 都是这么做的。
//
// 副作用：
//   - vault_meta.kdf_salt / kdf_params / wrapped_dek / updated_at 全部更新
//   - verifier 不变（DEK 没变就不需要重新加密 verifier）
//   - 内存中的 dek 保持不变（用户不需要重新解锁）
//
// 错误：
//   - vault 未初始化 → ErrVaultNotInitialized
//   - vault 锁定 → ErrVaultLocked（必须先解锁才能改密）
//     —— 即便我们用 oldPassword 也能再算一次 KEK，但要求"已解锁状态下改密"
//     是更安全的产品约定（攻击者拿到桌面访问权时不能直接改密把用户锁外面）
//   - 旧密码错 → ErrInvalidPassword
//   - 新密码弱 → ErrPasswordTooWeak
func (s *VaultService) ChangeMasterPassword(oldPassword, newPassword string) error {
	if err := validatePasswordStrength(newPassword); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.dek == nil {
		return ErrVaultLocked
	}

	meta, err := s.db.ReadMeta()
	if err != nil {
		return fmt.Errorf("read meta: %w", err)
	}
	if meta == nil {
		return ErrVaultNotInitialized
	}

	// 用旧密码派生 oldKEK，验证它能解开当前 wrappedDEK
	oldKEK, err := DeriveKEK(oldPassword, meta.KDFSalt, meta.KDFParams)
	if err != nil {
		return ErrInvalidPassword
	}
	defer WipeBytes(oldKEK)

	dekFromOld, err := OpenAEAD(oldKEK, meta.WrappedDEK, []byte(aadDEK))
	if err != nil {
		return ErrInvalidPassword
	}
	defer WipeBytes(dekFromOld)

	// 双重防御：解出来的 DEK 应当与内存中的 s.dek 字节相等。如果不等
	// 说明 vault_meta 与运行时状态对不上（DB 被外部改过 / 内存损坏），
	// 应当拒绝继续操作。
	if !constantTimeEqual(dekFromOld, s.dek) {
		return ErrInvalidPassword
	}

	// 生成新 salt + 用最新参数派生 newKEK
	// —— 顺便把 KDF 参数升级到 DefaultArgon2id 的当前推荐值
	newSalt, err := GenerateRandomBytes(SaltSize)
	if err != nil {
		return fmt.Errorf("gen new salt: %w", err)
	}
	newParams := DefaultArgon2id()
	newKEK, err := DeriveKEK(newPassword, newSalt, newParams)
	if err != nil {
		return fmt.Errorf("derive new kek: %w", err)
	}
	defer WipeBytes(newKEK)

	// 用 newKEK 重新包装 DEK（DEK 本身不变 → vault_items 全部继续可用）
	newWrapped, err := SealAEAD(newKEK, s.dek, []byte(aadDEK))
	if err != nil {
		return fmt.Errorf("rewrap dek: %w", err)
	}

	// 落盘新 meta（CreatedAt 保留原值靠 WriteMeta 的 ON CONFLICT 不更新）
	meta.KDFSalt = newSalt
	meta.KDFParams = newParams
	meta.WrappedDEK = newWrapped
	meta.UpdatedAt = s.nowMs()
	if err := s.db.WriteMeta(meta); err != nil {
		return fmt.Errorf("write new meta: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// 条目 CRUD
// ---------------------------------------------------------------------------

// ListItems 返回所有条目摘要
//
// 必须解密所有 item 才能给出 name / type —— 这是"全字段加密"的代价。
// 在桌面端（< 10k 条目）完全可接受。
func (s *VaultService) ListItems() ([]ItemSummary, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.dek == nil {
		return nil, ErrVaultLocked
	}
	// 未选择空间 → 返回空列表（不报错）。前端在切空间瞬间、或 spaces store
	// hydration 尚未完成时可能短暂处于这个状态；报错会让 UI 闪烁，空列表是
	// 更平滑的中间态。注意：绝不用 "" 去 ListItemsBySpace 匹配 orphan。
	if s.currentSpaceID == "" {
		return []ItemSummary{}, nil
	}

	rows, err := s.db.ListItemsBySpace(s.currentSpaceID)
	if err != nil {
		return nil, fmt.Errorf("list items: %w", err)
	}

	out := make([]ItemSummary, 0, len(rows))
	for _, r := range rows {
		payload, err := s.decryptItem(&r)
		if err != nil {
			// 单条解密失败不应让整个列表崩 —— 可能是 vault.db 局部损坏。
			// log 一下继续，前端看到的是"少了几条"而非"列表打不开"。
			// 真要强一致也可以改成 return err。
			fmt.Printf("[vault] decrypt item %s failed: %v\n", r.ID, err)
			continue
		}
		// tombstone（同步保留的软删除墓碑）对前端列表不可见
		if payload.DeletedAt != nil && *payload.DeletedAt > 0 {
			continue
		}
		// 透明迁移旧 wallet 条目为 note（仅读路径，不改改 DB）
		migrateLegacyTypeInPlace(payload)
		totpSecret, _ := payload.Fields["totp"].(string)
		out = append(out, ItemSummary{
			ID:        payload.ID,
			Type:      payload.Type,
			Name:      payload.Name,
			CreatedAt: r.CreatedAt,
			UpdatedAt: r.UpdatedAt,
			HasTOTP:   strings.TrimSpace(totpSecret) != "",
		})
	}
	return out, nil
}

// getItemAnySpace 按 id 读取完整 payload（解密），**不做空间校验**
//
// 与导出的 GetItem 的唯一区别：不检查条目是否属于当前激活空间。专供需要
// 跨空间访问条目的内部调用方使用 —— 当前只有同步（syncservice）：同步必须
// 能读到所有空间的条目才能正确构建 manifest / fetch records，若走带 space
// 校验的 GetItem 会把非当前空间的条目误判为「不存在」而漏传（隔离漏洞）。
//
// 找不到 / tombstone 返回 (nil, nil)，与 GetItem 一致。自己取 RLock。
func (s *VaultService) getItemAnySpace(id string) (*ItemPayload, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.dek == nil {
		return nil, ErrVaultLocked
	}
	if id == "" {
		return nil, errors.New("item id cannot be empty")
	}

	row, err := s.db.GetItem(id)
	if err != nil {
		return nil, fmt.Errorf("get item: %w", err)
	}
	if row == nil {
		return nil, nil
	}
	payload, err := s.decryptItem(row)
	if err != nil {
		return nil, fmt.Errorf("decrypt item: %w", err)
	}
	// tombstone 对前端不可见 —— 返回 (nil, nil) 与"未找到"语义对齐
	if payload.DeletedAt != nil && *payload.DeletedAt > 0 {
		return nil, nil
	}
	// 透明迁移旧 wallet 条目为 note（仅读路径，不改改 DB）
	migrateLegacyTypeInPlace(payload)
	// 用 DB 行的时间戳覆盖 payload 内的 —— DB 是事实来源
	payload.CreatedAt = row.CreatedAt
	payload.UpdatedAt = row.UpdatedAt
	return payload, nil
}

// GetItem 按 id 读取完整 payload（解密），**带空间校验**
//
// 跨空间访问（条目不属于当前激活空间）视作未找到，返回 (nil, nil) —— 与
// WebAuthn 式「不泄露存在性」对齐，也防止前端通过直接传 id 越过空间隔离。
// currentSpaceID 为空（未选择空间）时一律返回未找到，不泄露任何 orphan。
//
// 找不到返回 (nil, nil)；前端据此渲染"条目已被删除"提示。
func (s *VaultService) GetItem(id string) (*ItemPayload, error) {
	payload, err := s.getItemAnySpace(id)
	if err != nil || payload == nil {
		return payload, err
	}
	s.mu.RLock()
	cur := s.currentSpaceID
	s.mu.RUnlock()
	// payload.SpaceID 已由 decryptItem 用 DB 行的 space_id 覆盖（事实来源）。
	if cur == "" || payload.SpaceID != cur {
		return nil, nil
	}
	return payload, nil
}

// CreateItem 新建条目
//
// 流程：
//  1. 校验 type / name 合法
//  2. 生成 UUID v4 作为 id（不让前端传 id —— 防止 id 冲突 / 注入控制）
//  3. JSON 序列化 payload → SealAEAD（aad=id）→ 写 vault_items
//  4. 返回带 id 的 ItemSummary 给前端
//
// 前端传入的 in.ID 会被忽略；in.CreatedAt / UpdatedAt 也由后端覆盖
// （客户端时钟不可信，时间戳必须由权威来源生成）。
func (s *VaultService) CreateItem(in ItemPayload) (*ItemSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.dek == nil {
		return nil, ErrVaultLocked
	}
	if s.currentSpaceID == "" {
		return nil, ErrSpaceNotSelected
	}
	// 强制归当前激活空间，忽略前端传入的 SpaceID（防越权写进别的空间）。
	return s.createItemLocked(in, s.currentSpaceID)
}

// createItemInSpace 在指定空间新建条目，**不做 currentSpaceID 门禁**（同步专用）
//
// 同步的冲突解决（duplicate）需要把对端条目以新 id 复制进**对端原本所属的
// 空间**，而不是本端当前激活空间；走 CreateItem 会强制塞进 currentSpaceID 且
// 在未选空间时被拒。spaceID 取对端 payload.SpaceID，为空则 fallback 当前激活
// 空间（与 IngestForeignPayload 的兜底一致）。调用方：syncservice。自己取写锁。
func (s *VaultService) createItemInSpace(in ItemPayload, spaceID string) (*ItemSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dek == nil {
		return nil, ErrVaultLocked
	}
	if spaceID == "" {
		spaceID = s.currentSpaceID
	}
	return s.createItemLocked(in, spaceID)
}

// createItemLocked 是 CreateItem / createItemInSpace 共用的核心
//
// 调用方须已持有 s.mu 写锁 + dek != nil。spaceID 即条目归属，同时写进加密
// payload 与 DB 明文列，保持双存一致。
func (s *VaultService) createItemLocked(in ItemPayload, spaceID string) (*ItemSummary, error) {
	if _, ok := validItemTypes[in.Type]; !ok {
		return nil, fmt.Errorf("invalid item type: %q", in.Type)
	}
	if in.Name == "" {
		return nil, errors.New("item name cannot be empty")
	}
	if in.Fields == nil {
		in.Fields = map[string]any{}
	}
	// passkey 条目可能携带导入器原始密钥材料（Bitwarden 的 PKCS#8 私钥 +
	// GUID credentialId），在落库前补全公钥派生与字段归一化，使其与
	// CreatePasskey 产物字节兼容，可被 ListPasskeys / SignPasskeyAssertion 使用。
	if in.Type == ItemTypePasskey {
		if err := completeImportedPasskey(in.Fields); err != nil {
			return nil, fmt.Errorf("prepare passkey item: %w", err)
		}
	}

	id, err := newItemID()
	if err != nil {
		return nil, fmt.Errorf("gen item id: %w", err)
	}
	now := s.nowMs()
	in.ID = id
	in.CreatedAt = now
	in.UpdatedAt = now
	in.Revision = 1
	in.DeletedAt = nil
	in.SpaceID = spaceID

	// 加密整个 payload；aad=id 绑定上下文（防止条目调换攻击）
	plaintext, err := json.Marshal(&in)
	if err != nil {
		return nil, fmt.Errorf("marshal payload: %w", err)
	}
	ciphertext, err := SealAEAD(s.dek, plaintext, []byte(id))
	if err != nil {
		return nil, fmt.Errorf("seal payload: %w", err)
	}
	// 即便 plaintext 还没明显的密钥材料，也覆盖一下 —— 防止后续 GC
	// 之前被 swap 出去
	WipeBytes(plaintext)

	row := &VaultItemRow{
		ID:        id,
		Payload:   ciphertext,
		CreatedAt: now,
		UpdatedAt: now,
		SpaceID:   spaceID,
	}
	if err := s.db.InsertItem(row); err != nil {
		return nil, fmt.Errorf("insert item: %w", err)
	}

	// SSH 条目变更 —— 异步通知 agent 重拉公钥列表
	if in.Type == ItemTypeSSH {
		s.notifySshAgentSafe(func(n SshAgentNotifier) {
			go func() { _ = n.PushVaultKeys() }()
		})
	}

	totpSecret, _ := in.Fields["totp"].(string)
	summary := &ItemSummary{
		ID:        id,
		Type:      in.Type,
		Name:      in.Name,
		CreatedAt: now,
		UpdatedAt: now,
		HasTOTP:   strings.TrimSpace(totpSecret) != "",
	}
	s.notifyVaultChanged("create", in.Type, id)
	return summary, nil
}

// BatchCreateItems 批量新建条目
//
// 与 CreateItem 相比，所有条目在单次持锁周期内完成加密，
// 并通过 InsertItemBatch 用单个 SQLite 事务一次性写入，
// 彻底消除 N 次 IPC + N 次独立事务的开销。
//
// 前端传入的 in.ID / in.CreatedAt / in.UpdatedAt 均被后端覆盖。
// 返回与输入等长的 []ItemSummary（顺序对应）；任意一条加密失败
// 或 DB 写入失败则整批回滚并返回 error。
func (s *VaultService) BatchCreateItems(inputs []ItemPayload) ([]ItemSummary, error) {
	if len(inputs) == 0 {
		return nil, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.dek == nil {
		return nil, ErrVaultLocked
	}
	if s.currentSpaceID == "" {
		return nil, ErrSpaceNotSelected
	}

	now := s.nowMs()
	rows := make([]*VaultItemRow, 0, len(inputs))
	summaries := make([]ItemSummary, 0, len(inputs))

	for i := range inputs {
		in := &inputs[i]
		if _, ok := validItemTypes[in.Type]; !ok {
			return nil, fmt.Errorf("invalid item type: %q", in.Type)
		}
		if in.Name == "" {
			return nil, errors.New("item name cannot be empty")
		}
		if in.Fields == nil {
			in.Fields = map[string]any{}
		}
		// 与 CreateItem 一致：passkey 条目落库前补全公钥派生与字段归一化。
		// 单条失败会让整批返回 error，importMany 随即降级为逐条 createItem，
		// 仅坏条目失败，其余照常导入（见 stores/vault.ts importMany）。
		if in.Type == ItemTypePasskey {
			if err := completeImportedPasskey(in.Fields); err != nil {
				return nil, fmt.Errorf("prepare passkey item[%d]: %w", i, err)
			}
		}

		id, err := newItemID()
		if err != nil {
			return nil, fmt.Errorf("gen item id: %w", err)
		}
		in.ID = id
		in.CreatedAt = now
		in.UpdatedAt = now
		in.Revision = 1
		in.DeletedAt = nil
		// 强制归属当前激活空间（payload 内 + DB 列双存）
		in.SpaceID = s.currentSpaceID

		plaintext, err := json.Marshal(in)
		if err != nil {
			return nil, fmt.Errorf("marshal payload[%d]: %w", i, err)
		}
		ciphertext, err := SealAEAD(s.dek, plaintext, []byte(id))
		WipeBytes(plaintext)
		if err != nil {
			return nil, fmt.Errorf("seal payload[%d]: %w", i, err)
		}

		rows = append(rows, &VaultItemRow{
			ID:        id,
			Payload:   ciphertext,
			CreatedAt: now,
			UpdatedAt: now,
			SpaceID:   s.currentSpaceID,
		})
		totpSecret, _ := in.Fields["totp"].(string)
		summaries = append(summaries, ItemSummary{
			ID:        id,
			Type:      in.Type,
			Name:      in.Name,
			CreatedAt: now,
			UpdatedAt: now,
			HasTOTP:   strings.TrimSpace(totpSecret) != "",
		})
	}

	if err := s.db.InsertItemBatch(rows); err != nil {
		return nil, fmt.Errorf("batch insert: %w", err)
	}
	s.notifyVaultChanged("batch-create", "", "")
	return summaries, nil
}

// UpdateItem 整体覆盖现有条目
//
// 输入必须含 ID，且 ID 在 vault_items 中存在；不存在返回 ErrItemNotFound。
//
// CreatedAt 不会被覆盖（事实不可变）；UpdatedAt 由后端取当前时间。
//
// 字段级 patch（只改 password 不动 username）由前端组合：先 GetItem
// 拿全量 → 改字段 → 调 UpdateItem。后端不做 patch 是为了把"完整对象
// 替换"语义保持简单且可审计。
func (s *VaultService) UpdateItem(in ItemPayload) (*ItemSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.dek == nil {
		return nil, ErrVaultLocked
	}
	if in.ID == "" {
		return nil, errors.New("item id cannot be empty")
	}
	if _, ok := validItemTypes[in.Type]; !ok {
		return nil, fmt.Errorf("invalid item type: %q", in.Type)
	}
	if in.Name == "" {
		return nil, errors.New("item name cannot be empty")
	}
	if in.Fields == nil {
		in.Fields = map[string]any{}
	}

	// 先确认存在 + 拿 CreatedAt（不可变事实，不让前端覆盖）
	existing, err := s.db.GetItem(in.ID)
	if err != nil {
		return nil, fmt.Errorf("get existing: %w", err)
	}
	if existing == nil {
		return nil, ErrItemNotFound
	}
	// tombstone 行对前端不可见，禁止经普通 UpdateItem 路径复活 ——
	// 同步合并时若需要撤销删除，应该走 sync 模块的 RestoreItem 路径
	if existing.DeletedAt != nil && *existing.DeletedAt > 0 {
		return nil, ErrItemNotFound
	}
	// 空间校验：跨空间更新视作未找到（防前端越权改别的空间的条目）。
	// currentSpaceID 为空时一律拒绝。
	if s.currentSpaceID == "" || existing.SpaceID != s.currentSpaceID {
		return nil, ErrItemNotFound
	}
	// 先把单调水位线推到既有项的 UpdatedAt，再生成新时间戳。
	//
	// 为什么这一步必要：
	//   nowMs() 默认基于"上次本服务生成的时间戳"做单调推进，但 existing
	//   是从 DB 读出来的 —— 可能是上一次进程会话或被外部工具写入的，
	//   它的 UpdatedAt 不在 lastTsMs 跟踪范围内。如果系统时钟回拨 / 用户
	//   把本机时间改到比 existing.UpdatedAt 还早的过去，nowMs() 会算出
	//   一个 <= existing.UpdatedAt 的新时间戳，列表"最近改的在最前"
	//   排序就会错位（旧版本反而排到前面）。
	//
	//   显式把 lastTsMs 提到 existing.UpdatedAt，再调 nowMs() 时它会
	//   返回 max(wall, existing.UpdatedAt + 1)，既贴合真实墙上时间又
	//   保证严格 > 旧版本的 UpdatedAt。
	if existing.UpdatedAt > s.lastTsMs {
		s.lastTsMs = existing.UpdatedAt
	}
	now := s.nowMs()
	in.CreatedAt = existing.CreatedAt
	in.UpdatedAt = now
	// 防御性：前端不应该通过 UpdateItem 设置 DeletedAt（请走 DeleteItem 路径）
	in.DeletedAt = nil
	// 空间归属不可变：保留原 space_id（忽略前端传入的，不支持「移动到其他空间」）。
	// 写进加密 payload；DB 列由 db.UpdateItem 保持不动（它不改 space_id）。
	in.SpaceID = existing.SpaceID
	// Revision 自增；从 existing payload 读出当前值需要解密，开销可接受
	if existingPayload, err := s.decryptItem(existing); err == nil {
		in.Revision = existingPayload.Revision + 1
	} else {
		// 解密失败极罕见 —— 用墙钟兜底，保证严格大于先前任意值
		in.Revision = now
	}

	plaintext, err := json.Marshal(&in)
	if err != nil {
		return nil, fmt.Errorf("marshal payload: %w", err)
	}
	ciphertext, err := SealAEAD(s.dek, plaintext, []byte(in.ID))
	if err != nil {
		return nil, fmt.Errorf("seal payload: %w", err)
	}
	WipeBytes(plaintext)

	row := &VaultItemRow{
		ID:        in.ID,
		Payload:   ciphertext,
		CreatedAt: existing.CreatedAt,
		UpdatedAt: now,
	}
	if err := s.db.UpdateItem(row); err != nil {
		return nil, fmt.Errorf("update item: %w", err)
	}

	// 安全起见每次 UpdateItem 都通知 SSH agent 重推 —— 无法从 existing
	// VaultItemRow 直接知道原类型（原 Type 在加密 payload 内部，读出需
	// 再解密），不值得为了 noop 别动多一次解密。反正 PushVaultKeys 本身
	// 是幂等 + 当服务未启用 / 无 ssh item 时快路径返回。
	if in.Type == ItemTypeSSH {
		s.notifySshAgentSafe(func(n SshAgentNotifier) {
			go func() { _ = n.PushVaultKeys() }()
		})
	} else {
		// 非 ssh 类型的更新也可能是「从 ssh 改为 note」，同样需重推。但
		// 这种场景极罕见（用户不会把 SSH key 改为 note），为了不付出「每
		// 次 update 都抹底 push」的代价，MVP 阶段跳过；docs 提醒用户
		// 遇到类型转换后上最低影响的「重启 agent」。
	}

	totpSecret, _ := in.Fields["totp"].(string)
	summary := &ItemSummary{
		ID:        in.ID,
		Type:      in.Type,
		Name:      in.Name,
		CreatedAt: existing.CreatedAt,
		UpdatedAt: now,
		HasTOTP:   strings.TrimSpace(totpSecret) != "",
	}
	s.notifyVaultChanged("update", in.Type, in.ID)
	return summary, nil
}

// DeleteItem 软删除 —— 写 tombstone 而不是物理移除
//
// 为什么不物理删：同步语义需要让对端知道"这条已被删"；如果直接 DELETE，
// 下次与对端同步时对端会把它当作"我有他没有的新条目"复活回来。tombstone
// 保留 id + updatedAt + deletedAt 让冲突检测算法正确。
//
// 实现：解密 → 标 DeletedAt = now → 重新加密 → UpdateItem 落回。
// 物理清除留给未来 GC（90 天后清理）。
//
// 找不到 id 返回 ErrItemNotFound；已 tombstone 的条目幂等 nil。
func (s *VaultService) DeleteItem(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.dek == nil {
		return ErrVaultLocked
	}
	if id == "" {
		return errors.New("item id cannot be empty")
	}

	existingRow, err := s.db.GetItem(id)
	if err != nil {
		return fmt.Errorf("get existing: %w", err)
	}
	if existingRow == nil {
		return ErrItemNotFound
	}
	// 空间校验：跨空间删除视作未找到（防前端越权删别的空间的条目）。
	// currentSpaceID 为空时一律拒绝。同步路径走 deleteItemAnySpace 绕过。
	if s.currentSpaceID == "" || existingRow.SpaceID != s.currentSpaceID {
		return ErrItemNotFound
	}
	return s.softDeleteRowLocked(id, existingRow)
}

// deleteItemAnySpace 软删除指定条目，**不做空间校验**（同步专用）
//
// 同步收到对端 tombstone 时需要删除本端任意空间的对应条目；走带空间校验的
// DeleteItem 会把非当前空间的条目误判为「不存在」而漏删，导致两端状态发散。
// 调用方：syncservice。自己取写锁。
func (s *VaultService) deleteItemAnySpace(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.dek == nil {
		return ErrVaultLocked
	}
	if id == "" {
		return errors.New("item id cannot be empty")
	}
	existingRow, err := s.db.GetItem(id)
	if err != nil {
		return fmt.Errorf("get existing: %w", err)
	}
	if existingRow == nil {
		return ErrItemNotFound
	}
	return s.softDeleteRowLocked(id, existingRow)
}

// softDeleteRowLocked 把一行软删除为 tombstone（写本端 DEK 加密的墓碑）
//
// 调用方须已持有 s.mu 写锁 + dek != nil + 已取得 existingRow。DeleteItem /
// deleteItemAnySpace 共用此核心，差别仅在前者多一道空间校验。
func (s *VaultService) softDeleteRowLocked(id string, existingRow *VaultItemRow) error {
	existing, err := s.decryptItem(existingRow)
	if err != nil {
		// 行密文损坏 —— 无法构造有效 tombstone，回退物理删除
		// 这是兼容路径：vault.db 局部损坏时也要让用户能"删"掉烦人项
		if dbErr := s.db.DeleteItem(id); dbErr != nil {
			return dbErr
		}
		s.notifyVaultChanged("delete", "", id)
		return nil
	}
	// 已 tombstone → 幂等返回成功，不重写时间戳避免污染同步顺序
	if existing.DeletedAt != nil && *existing.DeletedAt > 0 {
		return nil
	}

	if existingRow.UpdatedAt > s.lastTsMs {
		s.lastTsMs = existingRow.UpdatedAt
	}
	now := s.nowMs()
	existing.UpdatedAt = now
	existing.DeletedAt = &now
	existing.Revision = existing.Revision + 1

	plaintext, err := json.Marshal(existing)
	if err != nil {
		return fmt.Errorf("marshal tombstone: %w", err)
	}
	ciphertext, err := SealAEAD(s.dek, plaintext, []byte(id))
	WipeBytes(plaintext)
	if err != nil {
		return fmt.Errorf("seal tombstone: %w", err)
	}
	if err := s.db.SoftDeleteItem(id, ciphertext, now, now); err != nil {
		return fmt.Errorf("soft delete: %w", err)
	}

	// 删除后也该通知 —— 如果是刚删的 ssh item，该 fingerprint 不应再
	// 出现在 agent 的公钥索引中。
	s.notifySshAgentSafe(func(n SshAgentNotifier) {
		go func() { _ = n.PushVaultKeys() }()
	})
	s.notifyVaultChanged("delete", "", id)
	return nil
}

// ---------------------------------------------------------------------------
// 同步专用 API（被 SyncService 调用，前端不应直接走）
// ---------------------------------------------------------------------------

// IngestForeignPayload 把对端同步过来的 plaintext payload 用本端 DEK 加密落盘
//
// 两端 vault 独立，DEK 不同；同步协议在 wire 上只传 plaintext payload（外层
// 有 session AEAD 保护），本端用自己的 DEK 重新加密写入。
//
// 行为：
//   - 本端不存在 id → InsertItem（保留 remote 的 createdAt/updatedAt）
//   - 本端已有但 updatedAt < remote → UpdateItem 或 RestoreItem（tombstone → 活动）
//   - 本端已有且 updatedAt >= remote → 跳过（LWW）
//
// 调用方负责保证 payload.DeletedAt == nil（tombstone 走 DeleteItem 路径）。
func (s *VaultService) IngestForeignPayload(id string, payload *ItemPayload, createdAt, updatedAt int64) (applied bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dek == nil {
		return false, ErrVaultLocked
	}
	if id == "" || payload == nil {
		return false, errors.New("ingest: empty id or payload")
	}

	existing, err := s.db.GetItem(id)
	if err != nil {
		return false, fmt.Errorf("get existing: %w", err)
	}

	// 空间归属（space_id）：
	//   - 本端已有此条目 → 保持本端原归属（sync 不改变 item 的空间，与
	//     UpdateItem「空间不可变」一致），即使对端 payload 声称别的空间也不动。
	//   - 本端没有（新条目）→ 用对端 payload 的 SpaceID；对端不支持 space
	//     （旧版本，SpaceID 为空）则 fallback 到当前激活空间（可能仍为空=orphan，
	//     待 ClaimOrphanItems 认领）。
	// 在 marshal 之前确定，保证密文内 SpaceID 与 DB 列一致。
	var spaceID string
	if existing != nil {
		spaceID = existing.SpaceID
	} else {
		spaceID = payload.SpaceID
		if spaceID == "" {
			spaceID = s.currentSpaceID
		}
	}

	// 强制 id / 时间戳 / 空间与权威一致；本端不重新生成 id（保持跨端可识别）
	payload.ID = id
	payload.CreatedAt = createdAt
	payload.UpdatedAt = updatedAt
	payload.DeletedAt = nil
	payload.SpaceID = spaceID
	if payload.Fields == nil {
		payload.Fields = map[string]any{}
	}

	plaintext, err := json.Marshal(payload)
	if err != nil {
		return false, fmt.Errorf("marshal ingest payload: %w", err)
	}
	ciphertext, err := SealAEAD(s.dek, plaintext, []byte(id))
	WipeBytes(plaintext)
	if err != nil {
		return false, fmt.Errorf("seal ingest payload: %w", err)
	}

	if existing == nil {
		row := &VaultItemRow{
			ID:        id,
			Payload:   ciphertext,
			CreatedAt: createdAt,
			UpdatedAt: updatedAt,
			SpaceID:   spaceID,
		}
		if err := s.db.InsertItem(row); err != nil {
			return false, fmt.Errorf("insert: %w", err)
		}
		return true, nil
	}
	if existing.UpdatedAt >= updatedAt {
		return false, nil // LWW: 本端更新或一样新，不覆盖
	}
	// db.RestoreItem / db.UpdateItem 都不改 space_id 列；上面已令 spaceID =
	// existing.SpaceID，列保持不变即正确，密文内 SpaceID 也已对齐。
	if existing.DeletedAt != nil {
		// 本端原是 tombstone，对端是活动版本且更新 → 复活
		if err := s.db.RestoreItem(id, ciphertext, updatedAt); err != nil {
			return false, fmt.Errorf("restore: %w", err)
		}
		return true, nil
	}
	row := &VaultItemRow{
		ID:        id,
		Payload:   ciphertext,
		CreatedAt: existing.CreatedAt,
		UpdatedAt: updatedAt,
		SpaceID:   spaceID,
	}
	if err := s.db.UpdateItem(row); err != nil {
		return false, fmt.Errorf("update: %w", err)
	}
	return true, nil
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

// AAD 上下文标签 —— 见 cryptoutil.go SealAEAD 的注释
//
// 用 const 而不是字面量散在各处，便于将来加新加密上下文（比如 attachment）
// 时统一管理 + 避免 typo。前缀 "zpass:" 是为了与未来其它项目的密文做
// 区分（万一密文被混同到别处使用，aad 会立刻 mismatch 暴露错误）。
const (
	aadDEK      = "zpass:dek"
	aadVerifier = "zpass:verifier"
)

// TOTPResult 是 BatchGenerateTOTP 每条条目的返回结果
//
//   - ItemID  : 请求的条目 ID（顺序与入参对应）
//   - Code    : 生成成功时的 TOTPCode；失败时为 nil
//   - Err     : 生成失败的原因；成功时为 ""
//
// 使用独立结构体而非 ([]TOTPCode, error) 是因为批量接口应该
// 局部容错：单条 secret 非法不应让整批失败。
type TOTPResult struct {
	ItemID string    `json:"itemId"`
	Code   *TOTPCode `json:"code"`
	Err    string    `json:"err"`
}

// BatchGenerateTOTP 批量生成 TOTP 验证码
//
// 与逐条调用 GenerateTOTP 相比，本方法：
//  1. 只持一次读锁，在锁内完成所有条目的解密 + OTP 计算
//  2. 返回与入参等长的 []TOTPResult，单条失败不影响其他条目
//
// 前端 TotpPage 首次进入时调用本方法替代逐条 generateTOTP IPC，
// 可把 N 次 IPC 压缩为 1 次。
func (s *VaultService) BatchGenerateTOTP(itemIDs []string) ([]TOTPResult, error) {
	if len(itemIDs) == 0 {
		return nil, nil
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.dek == nil {
		return nil, ErrVaultLocked
	}

	now := time.Now()
	results := make([]TOTPResult, len(itemIDs))

	for i, id := range itemIDs {
		results[i].ItemID = id

		row, err := s.db.GetItem(id)
		if err != nil {
			results[i].Err = err.Error()
			continue
		}
		if row == nil {
			results[i].Err = ErrItemNotFound.Error()
			continue
		}

		payload, err := s.decryptItem(row)
		if err != nil {
			results[i].Err = err.Error()
			continue
		}
		// 空间隔离：跨空间条目不计算 TOTP（防越权拿别的空间的验证码）。
		// payload.SpaceID 已由 decryptItem 用 DB 行 space_id 覆盖。
		if s.currentSpaceID == "" || payload.SpaceID != s.currentSpaceID {
			results[i].Err = ErrItemNotFound.Error()
			continue
		}

		if payload.Type != ItemTypeLogin && payload.Type != ItemTypeTOTP {
			results[i].Err = ErrTOTPSecretMissing.Error()
			continue
		}

		params, err := extractOTPParams(payload.Fields)
		if err != nil {
			results[i].Err = err.Error()
			continue
		}

		code, err := computeOTP(params, now)
		if err != nil {
			results[i].Err = err.Error()
			continue
		}
		results[i].Code = code
	}

	return results, nil
}

// decryptItem 把数据库里的密文行还原成 ItemPayload
//
// 私有方法（不导出给 Wails）。调用方必须在持有 s.mu 读锁 / 写锁的
// 情况下使用，且必须已确认 s.dek != nil。
func (s *VaultService) decryptItem(row *VaultItemRow) (*ItemPayload, error) {
	plaintext, err := OpenAEAD(s.dek, row.Payload, []byte(row.ID))
	if err != nil {
		return nil, err
	}
	var payload ItemPayload
	if err := json.Unmarshal(plaintext, &payload); err != nil {
		WipeBytes(plaintext)
		return nil, fmt.Errorf("unmarshal payload: %w", err)
	}
	WipeBytes(plaintext)
	// 兜底：DB 行的 ID / SpaceID 永远是读路径的事实来源。
	//   - ID：防止 payload 内 id 与行 id 不一致（历史脏数据）
	//   - SpaceID：payload 内的是同步传播副本，可能为空（v5 前写入的老条目、
	//     或尚未 ClaimOrphanItems 认领的 orphan）；DB 明文列才是查询/隔离依据，
	//     用它覆盖避免归属错乱。
	payload.ID = row.ID
	payload.SpaceID = row.SpaceID
	return &payload, nil
}

// validatePasswordStrength 检查主密码最低强度
//
// 当前规则简单：长度 >= 8。后续可以加：
//   - 字符类型多样性（大小写 / 数字 / 符号至少 3 类）
//   - HIBP 已泄露密码黑名单（需要本地哈希前缀文件）
//   - zxcvbn 风格的熵估计
//
// 故意不做"必须包含特殊字符"之类的硬性规则 —— NIST SP 800-63B 已经明确
// 反对，这类规则反而降低密码熵（用户被迫加 "!" 后缀）。长 passphrase
// 比短复杂密码更安全。
func validatePasswordStrength(password string) error {
	if len(password) < 8 {
		return ErrPasswordTooWeak
	}
	return nil
}

// newItemID 生成新条目 ID（UUID v4 风格的 16 字节随机 → hex 字符串）
//
// 不引入 google/uuid 依赖（会拉一个新 module）—— 自己用 crypto/rand 生
// 16 字节，按 RFC 4122 v4 设置 version 与 variant 位，hex 编码 32 字符
// 输出（不带连字符，节省 4 字节存储且查询匹配更简单）。
//
// 32 hex 字符 = 16 字节 = 128 bit 熵，碰撞概率在 vault 单库 < 10k 条
// 时可忽略（生日界 2^64 才有 50% 概率）。
func newItemID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("rand for item id: %w", err)
	}
	// RFC 4122 v4：version=4 在第 7 字节高位；variant=10 在第 9 字节高位
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return hex.EncodeToString(b[:]), nil
}

// constantTimeEqual 是 bytes.Equal 的恒定时间版本，防止侧信道
//
// 用于 ChangeMasterPassword 里比较"从旧密码解出的 DEK"与"内存中的 DEK"。
// 这里其实没有真正的攻击窗口（这两个值都已经在我们进程内），但密钥
// 材料比较一律走恒定时间是好习惯，未来 refactor 不会因为某次随手改成
// bytes.Equal 留下侧信道隐患。
//
// 实现：subtle.ConstantTimeCompare 的内联版（避免再 import 一个 pkg），
// 长度不等直接返回 false（这本身不是恒定时间，但长度不等于"不同密钥"
// 的语义对应不上，本来就不该恒定时间隐藏）。
func constantTimeEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := range a {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

// ---------------------------------------------------------------------------
// 审计日志加密存储
// ---------------------------------------------------------------------------
//
// vault_audit 表存加密后的 AuditEntry JSON 供 SSH agent 服务调。不直接在
// SshAgentService 里跳过 VaultService 加密 —— 保持「只有 vault 加密路径需要用
// DEK」的不变量，让未来的安全审计能集中看 vault 密钥使用。
//
// AEAD 设计：aad = "audit:v1"（区别于 item.id，防「把 item 密文拼到 audit
// 表上试兙」的跳区攻击）。同一 aad 践过所有 audit 条目，不以 id 参与
// AEAD —— audit 条目本身不需要「防 row 互换」语义（全部类型同，同表）。

// auditAAD 是加密 audit payload 的上下文标签
//
// 「audit:v1」带版本号是为了未来可以轮换加密格式（加字段 / 换算法）
// 时带 aad 一起跳版本。当前不变。
const auditAAD = "audit:v1"

// EncryptAuditPayload 用 DEK 加密 audit JSON 字节
//
// 调用者：SshAgentService 在准备入库一条 AuditEntry 时调。vault 锁定时
// 返回 ErrVaultLocked，调用者应当对此充任为「现在不能落盘，暂存内存」。
func (s *VaultService) EncryptAuditPayload(plaintext []byte) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.dek == nil {
		return nil, ErrVaultLocked
	}
	return SealAEAD(s.dek, plaintext, []byte(auditAAD))
}

// DecryptAuditPayload 用 DEK 解密 audit 存储的密文
//
// 调用者：SshAgentService.GetAuditLog 合并内存 + DB 来源时。vault 锁定时
// 返回 ErrVaultLocked；DB 数据损坏 / 被篡改 → AEAD 校验失败 → 返错。
func (s *VaultService) DecryptAuditPayload(ciphertext []byte) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.dek == nil {
		return nil, ErrVaultLocked
	}
	return OpenAEAD(s.dek, ciphertext, []byte(auditAAD))
}

// cloudCredAAD 是加密「云自动登录凭据」(云主密码)的上下文标签,与 audit/item
// 的 aad 域分离,防止把别处密文拼接到云凭据槽位上试探。带版本号便于未来轮换。
const cloudCredAAD = "cloud-cred:v1"

// SealCloudCredential 用本地保险库 DEK 加密一段云自动登录凭据(云主密码)。
//
// 供 CloudService 在登录成功后,把云账户主密码以「仅本地解锁后可解」的形式
// 落盘——这样即便本地解锁密码与云密码不同,解锁后也能重建云会话。CloudService
// 只传明文、拿密文,永不接触 DEK,保持「只有 vault 持有 DEK」的不变量。
// vault 锁定时返回 ErrVaultLocked。
func (s *VaultService) SealCloudCredential(plaintext []byte) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.dek == nil {
		return nil, ErrVaultLocked
	}
	return SealAEAD(s.dek, plaintext, []byte(cloudCredAAD))
}

// OpenCloudCredential 用 DEK 解密 SealCloudCredential 落盘的云凭据密文。
// vault 锁定时返回 ErrVaultLocked;密文损坏/被篡改 → AEAD 校验失败 → 返错。
func (s *VaultService) OpenCloudCredential(ciphertext []byte) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.dek == nil {
		return nil, ErrVaultLocked
	}
	return OpenAEAD(s.dek, ciphertext, []byte(cloudCredAAD))
}

// AuditDBRow 是返回给 SshAgentService 的「DB 中一条 audit」表示
//
// Plaintext 是解密后的 JSON 字节，调用者负责 unmarshal 到 AuditEntry。
// 不在 vault 依赖 AuditEntry struct —— それ是 SshAgentService 的类型。
type AuditDBRow struct {
	ID        int64
	CreatedAt int64
	Plaintext []byte
}

// ListAuditEntries 返回最近 limit 条解密后的审计记录
//
// 单条解密失败 → log + 跳过，不让一条损坏让整个列表不可读。与 ListItems
// 同机制。
func (s *VaultService) ListAuditEntries(limit int) ([]AuditDBRow, error) {
	s.mu.RLock()
	dek := s.dek
	s.mu.RUnlock()
	if dek == nil {
		return nil, ErrVaultLocked
	}

	rows, err := s.db.ListAuditEntries(limit)
	if err != nil {
		return nil, err
	}

	out := make([]AuditDBRow, 0, len(rows))
	for _, r := range rows {
		pt, err := OpenAEAD(dek, r.Payload, []byte(auditAAD))
		if err != nil {
			fmt.Printf("[vault] decrypt audit %d failed: %v\n", r.ID, err)
			continue
		}
		out = append(out, AuditDBRow{
			ID:        r.ID,
			CreatedAt: r.CreatedAt,
			Plaintext: pt,
		})
	}
	return out, nil
}

// InsertAuditEntry 加密 + 插入一条审计记录。返回生成的 row ID。
func (s *VaultService) InsertAuditEntry(plaintext []byte) (int64, error) {
	s.mu.RLock()
	dek := s.dek
	s.mu.RUnlock()
	if dek == nil {
		return 0, ErrVaultLocked
	}
	ct, err := SealAEAD(dek, plaintext, []byte(auditAAD))
	if err != nil {
		return 0, fmt.Errorf("encrypt audit: %w", err)
	}
	return s.db.InsertAuditEntry(&AuditRow{
		Payload:   ct,
		CreatedAt: time.Now().UnixMilli(),
	})
}

// PruneAuditEntries 删除除「最新 keep 条」以外的审计记录
//
// 不需要 DEK（只是 DELETE），不检查锁定状态。
func (s *VaultService) PruneAuditEntries(keep int) error {
	return s.db.PruneAuditEntries(keep)
}

// DeleteAllAuditEntries 清空全部审计记录。同样不需要 DEK。
func (s *VaultService) DeleteAllAuditEntries() error {
	return s.db.DeleteAllAuditEntries()
}

// ---------------------------------------------------------------------------
// 导出（明文）
// ---------------------------------------------------------------------------

// exportAllPayloads 内部辅助：在已解锁状态下解密所有条目，返回完整 ItemPayload 列表。
//
// 设计意图：
//   - 私有方法（小写），不会被 Wails 反射暴露给前端，避免把整库明文一次性
//     通过 IPC 回传到 webview（增加内存暴露面 + JSON marshal 风险）。
//   - 仅供同 main 包的 ExportService 调用，由它在进程内组装 JSON 并直接
//     写入用户通过 SaveFile dialog 选定的文件。
//   - 一次性持读锁完成所有解密，避免逐条 GetItem 反复抢锁的开销。
//
// 与 ListItems / GetItem 的差异：
//   - 不应用 migrateLegacyTypeInPlace —— 导出是「快照」语义，保留 DB 中原始
//     类型（包括历史遗留的 wallet）让用户备份/迁移时可以看到完整数据。
//   - 返回的 CreatedAt / UpdatedAt 以 DB 行为事实来源（覆盖 payload 内的时间戳）。
//
// 空间隔离：导出受隔离约束，只导**当前激活空间**的条目（用户在某空间点导出，
// 期望导出看到的那批）。未选择空间 → 空导出。
//
// 单条解密失败按 ListItems 的做法 log + 跳过，不让一条损坏让整次导出失败。
func (s *VaultService) exportAllPayloads() ([]ItemPayload, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.dek == nil {
		return nil, ErrVaultLocked
	}
	if s.currentSpaceID == "" {
		return []ItemPayload{}, nil
	}

	rows, err := s.db.ListItemsBySpace(s.currentSpaceID)
	if err != nil {
		return nil, fmt.Errorf("list items: %w", err)
	}

	out := make([]ItemPayload, 0, len(rows))
	for _, r := range rows {
		payload, err := s.decryptItem(&r)
		if err != nil {
			fmt.Printf("[vault] export decrypt item %s failed: %v\n", r.ID, err)
			continue
		}
		payload.CreatedAt = r.CreatedAt
		payload.UpdatedAt = r.UpdatedAt
		out = append(out, *payload)
	}
	return out, nil
}

// VerifyMasterPassword 用给定密码尝试派生 KEK 并解开 WrappedDEK + Verifier。
//
// 与 Unlock 的差异：
//   - 不改变 VaultService 的运行时状态：不替换 s.dek、不通知 SSH agent、不发
//     vault 解锁事件；解出的 DEK 在校验后立刻 WipeBytes 抹零。
//   - 仅作为「敏感操作前的二次确认」凭据使用（如导出明文备份）。
//
// 错误语义与 Unlock 一致：密码错误 / Verifier 校验失败 / WrappedDEK 解密失败
// 都统一返回 ErrInvalidPassword，避免侧信道区分。
//
// 调用方应在 vault 已解锁状态下调用 —— 锁定状态没有 sensible 的「二次确认」
// 语义（用户连 vault 都还没开）。若 vault 锁定，直接返回 ErrVaultLocked，
// 让前端走正常解锁流程。
func (s *VaultService) VerifyMasterPassword(password string) error {
	if password == "" {
		return ErrInvalidPassword
	}

	s.mu.RLock()
	unlocked := s.dek != nil
	s.mu.RUnlock()
	if !unlocked {
		return ErrVaultLocked
	}

	meta, err := s.db.ReadMeta()
	if err != nil {
		return fmt.Errorf("load vault meta: %w", err)
	}
	if meta == nil {
		return ErrVaultNotInitialized
	}

	kek, err := DeriveKEK(password, meta.KDFSalt, meta.KDFParams)
	if err != nil {
		return fmt.Errorf("derive kek: %w", err)
	}
	defer WipeBytes(kek)

	dek, err := OpenAEAD(kek, meta.WrappedDEK, []byte(aadDEK))
	if err != nil {
		return ErrInvalidPassword
	}
	defer WipeBytes(dek)

	if _, err := OpenAEAD(dek, meta.Verifier, []byte(aadVerifier)); err != nil {
		return ErrInvalidPassword
	}
	return nil
}
