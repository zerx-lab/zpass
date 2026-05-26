package services

// Vault 数据库层 —— ZPass 桌面客户端
// ---------------------------------------------------------------------------
// 本文件封装 SQLite 数据库的"低级"读写：连接管理、schema 创建/迁移、
// 元数据 CRUD、条目 CRUD。**不**包含任何加密原语 —— 加密在 vaultservice
// 调用前完成（"加密在外，存储在内"），这一层只看到密文 BLOB。
//
// 设计目标：
//   - 拖库零信息：DB 表里**只**存 ciphertext + 必要 ID + 时间戳，不留
//     条目类型 / 条目名 / URL / 标签 等任何明文元数据。攻击者拿到整库
//     除了"用户有几条记录、每条多大、什么时候创建的"以外，啥都得不到。
//   - 升级友好：vault_meta.version 字段记录 schema 版本，未来增字段
//     走显式 migration 链，不靠"列存在与否"的脆弱探测。
//   - 跨平台无 CGO：用 `modernc.org/sqlite`（纯 Go 翻译版 SQLite），
//     与 Wails 跨平台编译流程零摩擦，不需要 gcc / mingw 工具链。
//
// ---------------------------------------------------------------------------
// 表结构
//
//   vault_meta —— 元数据单行表（id 强制为 1，禁止多行）
//     id              INTEGER PRIMARY KEY CHECK (id = 1)
//     version         INTEGER NOT NULL    -- schema 版本，用于迁移
//     kdf             TEXT    NOT NULL    -- "argon2id"，未来若换 KDF 这里换
//     kdf_salt        BLOB    NOT NULL    -- 32 字节随机 salt
//     kdf_memory_kib  INTEGER NOT NULL    -- Argon2id memory 参数
//     kdf_iterations  INTEGER NOT NULL    -- Argon2id iterations 参数
//     kdf_parallelism INTEGER NOT NULL    -- Argon2id parallelism 参数
//     wrapped_dek     BLOB    NOT NULL    -- KEK 包装的 DEK（XChaCha 密文）
//     verifier        BLOB    NOT NULL    -- DEK 加密的已知明文，验证密码用
//     created_at      INTEGER NOT NULL    -- vault 创建 unix ms
//     updated_at      INTEGER NOT NULL    -- 最近一次元数据写入 unix ms
//
//   vault_items —— 条目表
//     id              TEXT    PRIMARY KEY -- UUID v4 / 短随机串
//     payload         BLOB    NOT NULL    -- DEK 加密的整条 item JSON
//     created_at      INTEGER NOT NULL    -- 创建 unix ms
//     updated_at      INTEGER NOT NULL    -- 最近修改 unix ms
//
//   vault_items 不存条目类型、名称、tag、URL —— 全部塞进 payload 加密。
//   牺牲点：列表 / 过滤 / 搜索都必须解密后在内存做。10k 条目以内性能
//   完全可接受（XChaCha20-Poly1305 在桌面 CPU 上 ~1 GB/s，10k * 2KB =
//   20 MB 解密 ~20 ms）。换来的好处是数据库被拖走对攻击者基本无用。
//
// ---------------------------------------------------------------------------
// 路径与权限
//
//   DB 文件落在 `~/.config/zpass/vault.db`（与 ConfigService 共用配置目录）。
//   首次创建用 0600 权限（仅当前用户读写）；Windows NTFS 由用户目录默认
//   ACL 接管，os.Chmod 在 Windows 上是 no-op，靠 OS 默认安全。
//
//   开启 SQLite 的 WAL 模式 + foreign_keys：
//     - WAL：写不阻塞读，崩溃恢复鲁棒；vault.db-wal / vault.db-shm 副本
//       会出现在同目录，正常关闭后会被合并掉
//     - foreign_keys：未来如果加 vault_items_history 之类的子表能用
//
// ---------------------------------------------------------------------------
// 连接管理
//
//   一个进程内只持有一个 *sql.DB（VaultDB.handle），传给 modernc.org/sqlite
//   驱动后内部维护连接池。锁定状态由 vaultservice 控制（持有 DEK 与否），
//   DB 句柄本身在整个进程生命周期保持打开 —— 不需要"锁定 = 关闭 DB"，
//   因为 DB 里全是密文，没有 DEK 谁都读不出明文。

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	// modernc.org/sqlite 是纯 Go 实现的 SQLite，import 后会注册 "sqlite"
	// 驱动名。我们用 _ 别名仅触发其 init()。
	_ "modernc.org/sqlite"
)

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const (
	// vaultDBFilename 是 vault 数据库文件名，落在 ~/.config/zpass/<这里>
	vaultDBFilename = "vault.db"

	// vaultSchemaVersion 是当前 schema 版本号
	// 每次给 vault_meta / vault_items 加列、改约束都要 +1，并在
	// migrate() 函数里加对应的迁移分支
	//
	// v1 → v2：新增 vault_trusted_device 表，存储 DPAPI/Keychain 包装的
	// DEK 备份，让用户可在「信任设备」上重启免输主密码。
	// v2 → v3：新增 vault_audit 表，持久化 SSH agent 签名审计日志。
	// v3 → v4：vault_items 新增 deleted_at 列（软删除 tombstone）+ 索引。
	// 同步功能需要保留删除标记以避免对端把已删条目「复活」回来。
	vaultSchemaVersion = 4

	// kdfNameArgon2id 写入 vault_meta.kdf 字段的标识
	// 未来若引入新 KDF（比如 PHC 接班的算法），这里增加新常量并在
	// vaultservice 解锁路径分流派生
	kdfNameArgon2id = "argon2id"

	// metaSingletonID 是 vault_meta 唯一行的 id 值
	// 用 CHECK 约束确保表里只有一行 —— vault 是单例，不存在多 vault 共存
	metaSingletonID = 1

	// trustedDeviceSingletonID 是 vault_trusted_device 唯一行的 id 值
	// 与 metaSingletonID 同样用 CHECK 约束锁成单例 —— 一个 vault 只对应
	// 当前这一台设备的一份 trusted blob，不存在多设备 blob 共存
	trustedDeviceSingletonID = 1
)

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

// VaultMeta 是 vault_meta 表的内存表示
//
// 字段一对一映射 SQL 列。VaultDB 的读写方法直接吐出 / 接收这个结构，
// 上层 vaultservice 不需要触碰 *sql.Row。
type VaultMeta struct {
	Version    int
	KDF        string
	KDFSalt    []byte
	KDFParams  Argon2idParams
	WrappedDEK []byte
	Verifier   []byte
	CreatedAt  int64 // unix ms
	UpdatedAt  int64 // unix ms
}

// VaultItemRow 是 vault_items 表的内存表示
//
// Payload 是密文 BLOB，明文结构由 vaultservice 自己定义并 JSON
// 序列化，DB 层不感知。这是"加密在外、存储在内"原则的体现 —— 即使
// 未来换数据库（比如改 BoltDB）也只动这一层，密文格式不变。
//
// DeletedAt 软删除时间戳（unix ms）—— 同步 tombstone：
//   - nil = 未删除（默认值），与 SQL deleted_at IS NULL 对应
//   - 非 nil = 该时刻被删除；ListItems 默认过滤；ListItemsWithTombstones 才返回
//
// 顶层缓存方便 SQL 层快速过滤；权威值仍在加密 payload 内（AEAD 保护）。
type VaultItemRow struct {
	ID        string
	Payload   []byte
	CreatedAt int64
	UpdatedAt int64
	DeletedAt *int64
}

// TrustedDeviceRow 是 vault_trusted_device 表的内存表示
//
// 该表为单例（CHECK id = 1），存储「在此设备上自动解锁」功能的 DEK 包装：
//   - Method：保护方式标识（"dpapi" / "keychain" / "libsecret"）
//     用于未来跨平台 / 跨保护方案识别。当前 Windows 实现写 "dpapi"。
//   - Blob：被 OS 设备绑定密钥包装后的 DEK 密文。具体字节布局由 Method
//     决定，VaultDB 层不感知 —— 与 vault_items.Payload 同样的"加密在外、
//     存储在内"原则。
//   - CreatedAt：用户启用「信任此设备」的时间戳；UI 可展示「已信任 X 天」。
//
// 安全约定：
//   - 该表的内容**不应**被同步到云端 / 其它设备 —— DPAPI blob 离开当前
//     Windows 用户会话即无法解密，Keychain 项绑定到当前 macOS 用户。
//     未来做云同步时，明确把 vault_trusted_device 排除在同步集合外。
//   - 删除 vault / 重置流程必须显式 DELETE 本表，不能留孤儿行。
//   - ChangeMasterPassword **不影响**本表 —— DEK 本身不变，只是
//     wrapped_dek 重新封装；trusted blob 包装的是 DEK，无需重建。
type TrustedDeviceRow struct {
	Method    string
	Blob      []byte
	CreatedAt int64
}

// VaultDB 是 vault 数据库的封装
//
// 调用方持有一个实例（vaultservice 内嵌），方法都是线程安全的（database/sql
// 的连接池天然 goroutine 安全）。
type VaultDB struct {
	handle *sql.DB
	path   string // DB 文件绝对路径，用于诊断 / 错误信息
}

// ---------------------------------------------------------------------------
// 打开 / 关闭
// ---------------------------------------------------------------------------

// OpenVaultDB 打开（或首次创建）vault.db 并完成 schema 初始化
//
// 流程：
//  1. 解析 ~/.config/zpass 目录路径并 mkdir -p（与 ConfigService 共用）
//  2. 打开 sqlite 文件（不存在则由驱动创建）
//  3. 设置文件权限 0600（POSIX，Windows 上 chmod 是 no-op）
//  4. 启用 WAL + foreign_keys + secure_delete pragma
//  5. CREATE TABLE IF NOT EXISTS（schema v1）
//  6. 必要时跑 migration（v1→v2 等）
//
// 返回 *VaultDB；调用方负责在进程退出时 Close。
func OpenVaultDB() (*VaultDB, error) {
	dir, err := ensureConfigDir()
	if err != nil {
		return nil, fmt.Errorf("ensure config dir: %w", err)
	}
	dbPath := filepath.Join(dir, vaultDBFilename)

	// modernc.org/sqlite 的 DSN 接受 file URI 或裸路径。裸路径足够，避免
	// Windows 反斜杠在 URI 编码下的歧义。`?_pragma=...` 形式被 driver 解析。
	//
	// 关键 pragma：
	//   journal_mode=WAL      —— 写不阻塞读
	//   synchronous=NORMAL    —— WAL 下安全且性能良好（FULL 太慢、OFF 不安全）
	//   foreign_keys=ON       —— 默认是 OFF，显式开启
	//   secure_delete=ON      —— DELETE 时把数据页填零，避免删除的密文残留
	//                            在文件未使用页里被恢复（即便加密了，最小化
	//                            攻击面也是好习惯；性能影响在桌面端可忽略）
	dsn := fmt.Sprintf(
		"%s?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)&_pragma=secure_delete(ON)",
		dbPath,
	)

	handle, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite %s: %w", dbPath, err)
	}

	// SQLite 单文件场景，把最大连接数压到 1 可避免 "database is locked"
	// 在 WAL 下其实读多写一也没问题，但保守起见 + 简化心智模型。
	// 真要并发优化时可以解开，目前 vault 操作低频，无所谓。
	handle.SetMaxOpenConns(1)
	handle.SetMaxIdleConns(1)

	// Ping 一次确认可达
	if err := handle.Ping(); err != nil {
		_ = handle.Close()
		return nil, fmt.Errorf("ping sqlite %s: %w", dbPath, err)
	}

	// 修正文件权限到 0600（仅当前用户）
	// 第一次创建时 driver 默认按 umask 走，可能是 0644；显式 chmod 一次。
	// Windows 上 os.Chmod 不影响 ACL，等于 no-op，无副作用。
	if err := os.Chmod(dbPath, 0o600); err != nil {
		// 仅记录失败，不阻塞启动 —— 部分文件系统（FAT32 / 网络盘）不支持
		// 完整 POSIX 权限。安全敏感性已经被加密层兜底，权限是次级防护。
		// 这里如果真要严格化可以改成返回错误。
		_ = err
	}

	db := &VaultDB{
		handle: handle,
		path:   dbPath,
	}

	if err := db.initSchema(); err != nil {
		_ = handle.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	return db, nil
}

// Close 关闭底层 *sql.DB
//
// 幂等 —— 多次调用 / 在未打开实例上调用都安全
func (db *VaultDB) Close() error {
	if db == nil || db.handle == nil {
		return nil
	}
	return db.handle.Close()
}

// Path 返回 vault.db 的绝对路径，仅用于诊断 / Settings 展示
func (db *VaultDB) Path() string {
	if db == nil {
		return ""
	}
	return db.path
}

// ---------------------------------------------------------------------------
// Schema 初始化与迁移
// ---------------------------------------------------------------------------

// initSchema 创建表结构并跑必要的迁移
//
// 第一次启动：CREATE TABLE IF NOT EXISTS 走两次（meta / items）
// 后续启动：检查 vault_meta.version，若小于 vaultSchemaVersion 跑 migrate
//
// 注意：vault_meta 在 Initialize 之前是空的（没有任何行），无法读到 version。
// 所以"迁移"只在 vault_meta 已经至少有一行时才执行。第一次 Initialize 落入
// 的就是当前最新 schema 版本，不需要迁移。
func (db *VaultDB) initSchema() error {
	// 用 IF NOT EXISTS 让重复启动幂等。CHECK (id = 1) 把 vault_meta 锁成
	// 单例（任何 INSERT 不带 id=1 会失败），保证不会有"两个 vault 元数据
	// 共存"的诡异状态。
	_, err := db.handle.Exec(`
		CREATE TABLE IF NOT EXISTS vault_meta (
			id              INTEGER PRIMARY KEY CHECK (id = 1),
			version         INTEGER NOT NULL,
			kdf             TEXT    NOT NULL,
			kdf_salt        BLOB    NOT NULL,
			kdf_memory_kib  INTEGER NOT NULL,
			kdf_iterations  INTEGER NOT NULL,
			kdf_parallelism INTEGER NOT NULL,
			wrapped_dek     BLOB    NOT NULL,
			verifier        BLOB    NOT NULL,
			created_at      INTEGER NOT NULL,
			updated_at      INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS vault_items (
			id         TEXT    PRIMARY KEY,
			payload    BLOB    NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			deleted_at INTEGER          -- 软删除 tombstone：NULL = 未删除
		);

		CREATE INDEX IF NOT EXISTS idx_vault_items_updated_at
			ON vault_items (updated_at DESC);
		-- 注意：idx_vault_items_live_updated 在 ensureVaultItemsV4Schema()
		-- 里建，因为对老表（v1-v3，没有 deleted_at 列）必须先 ALTER ADD
		-- COLUMN 再 CREATE INDEX，不能放在 CREATE TABLE 段里直接执行。

		CREATE TABLE IF NOT EXISTS vault_trusted_device (
			id         INTEGER PRIMARY KEY CHECK (id = 1),
			method     TEXT    NOT NULL,
			blob       BLOB    NOT NULL,
			created_at INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS vault_audit (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			payload    BLOB    NOT NULL,
			created_at INTEGER NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_vault_audit_created_at
			ON vault_audit (created_at DESC);
	`)
	if err != nil {
		return fmt.Errorf("create tables: %w", err)
	}

	// 老表（v1-v3）走过 CREATE TABLE IF NOT EXISTS 时不会被改写 schema —— 必须
	// 显式补齐 deleted_at 列与对应索引，再继续后面的 version 检查；新表则
	// 直接含 deleted_at，下面的 ALTER 会被 hasColumn 短路。
	if err := db.ensureVaultItemsV4Schema(); err != nil {
		return fmt.Errorf("ensure vault_items v4 schema: %w", err)
	}

	// 若 vault_meta 已有行，检查 version；落后就跑 migrate
	// 没有行（首次启动 / 未 Initialize）则跳过迁移，由 Initialize 直接
	// 写入当前版本号
	var version int
	err = db.handle.QueryRow(`SELECT version FROM vault_meta WHERE id = ?`, metaSingletonID).Scan(&version)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read meta version: %w", err)
	}
	if version > vaultSchemaVersion {
		// 用户用新版应用创建过 vault，又用老版打开 —— 拒绝降级，避免
		// 因不识别新字段把 vault 写坏。
		return fmt.Errorf("vault schema version %d is newer than supported %d (downgrade not allowed)",
			version, vaultSchemaVersion)
	}
	if version < vaultSchemaVersion {
		if err := db.migrate(version, vaultSchemaVersion); err != nil {
			return fmt.Errorf("migrate %d -> %d: %w", version, vaultSchemaVersion, err)
		}
	}
	return nil
}

// ensureVaultItemsV4Schema 幂等地把 vault_items 升级到 v4 schema
//
// 调用时机：每次 initSchema 启动都跑一次，无论 vault 是否已 Initialize。
//
// 工作流：
//  1. PRAGMA table_info(vault_items) 看是否已有 deleted_at 列
//  2. 没有 → ALTER TABLE vault_items ADD COLUMN deleted_at INTEGER
//  3. CREATE INDEX IF NOT EXISTS idx_vault_items_live_updated（partial index
//     需要 deleted_at 列存在才能编译，因此放在 step 2 之后）
//
// 不会对已有 v4 schema 重复添加列（PRAGMA 检查 + ALTER 只有缺列时才执行）。
// 索引创建用 IF NOT EXISTS，反复跑没副作用。
func (db *VaultDB) ensureVaultItemsV4Schema() error {
	rows, err := db.handle.Query(`PRAGMA table_info(vault_items)`)
	if err != nil {
		return fmt.Errorf("pragma table_info: %w", err)
	}
	hasDeletedAt := false
	for rows.Next() {
		var (
			cid       int
			name      string
			ctype     string
			notnull   int
			dfltValue sql.NullString
			pk        int
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dfltValue, &pk); err != nil {
			rows.Close()
			return fmt.Errorf("scan table_info: %w", err)
		}
		if name == "deleted_at" {
			hasDeletedAt = true
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate table_info: %w", err)
	}

	if !hasDeletedAt {
		if _, err := db.handle.Exec(
			`ALTER TABLE vault_items ADD COLUMN deleted_at INTEGER`,
		); err != nil {
			return fmt.Errorf("add deleted_at column: %w", err)
		}
	}
	// 部分索引（WHERE deleted_at IS NULL）—— 加速 ListItems 默认查询路径
	if _, err := db.handle.Exec(
		`CREATE INDEX IF NOT EXISTS idx_vault_items_live_updated
			ON vault_items (updated_at DESC) WHERE deleted_at IS NULL`,
	); err != nil {
		return fmt.Errorf("create idx_vault_items_live_updated: %w", err)
	}
	return nil
}

// migrate 顺序执行从 from+1 到 to 的迁移步骤
//
// v1 是首版，没有任何迁移分支。未来加列时按下例：
//
//	for v := from + 1; v <= to; v++ {
//	    switch v {
//	    case 2:
//	        _, err := db.handle.Exec(`ALTER TABLE vault_items ADD COLUMN folder_enc BLOB;`)
//	        if err != nil { return err }
//	    case 3: ...
//	    }
//	    _, err := db.handle.Exec(`UPDATE vault_meta SET version = ? WHERE id = ?`, v, metaSingletonID)
//	    if err != nil { return err }
//	}
//
// 每个分支应该是幂等的（IF NOT EXISTS / IF EXISTS），让中途崩溃后重启
// 还能继续走完。
func (db *VaultDB) migrate(from, to int) error {
	for v := from + 1; v <= to; v++ {
		switch v {
		case 2:
			// v1 → v2：新增 vault_trusted_device 表
			//
			// 用 IF NOT EXISTS 让分支幂等 —— 老用户首次升级、初次启动
			// 中途崩溃又重启都能继续走完。
			//
			// 不需要数据迁移：老 vault 默认未启用「信任设备」，表为空即可，
			// 用户在 Settings 里显式开启时才插入第一行。
			_, err := db.handle.Exec(`
				CREATE TABLE IF NOT EXISTS vault_trusted_device (
					id         INTEGER PRIMARY KEY CHECK (id = 1),
					method     TEXT    NOT NULL,
					blob       BLOB    NOT NULL,
					created_at INTEGER NOT NULL
				);
			`)
			if err != nil {
				return fmt.Errorf("v2: create vault_trusted_device: %w", err)
			}
		case 3:
			// v2 → v3：新增 vault_audit 表。
			//
			// payload 是加密后的 AuditEntry JSON，aad = "audit:<id>"。
			// 「没启用 SSH agent 」的老用户表会空，不需要数据迁移。
			_, err := db.handle.Exec(`
				CREATE TABLE IF NOT EXISTS vault_audit (
					id         INTEGER PRIMARY KEY AUTOINCREMENT,
					payload    BLOB    NOT NULL,
					created_at INTEGER NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_vault_audit_created_at
					ON vault_audit (created_at DESC);
			`)
			if err != nil {
				return fmt.Errorf("v3: create vault_audit: %w", err)
			}
		case 4:
			// v3 → v4：vault_items 新增 deleted_at 列与索引。
			//
			// 软删除 tombstone：NULL = 未删除；非 NULL = 该时刻被删（毫秒）。
			// 同步协议需要保留 id + updatedAt + deletedAt 以避免对端把已删
			// 条目「复活」回来。物理清除留给未来的 GC（90 天后清理）。
			//
			// 实际 schema 改动已在 initSchema 头部的 ensureVaultItemsV4Schema()
			// 幂等执行过；此处只需确认成功（重复 ALTER 会报"duplicate column"，
			// 因此走 ensureVaultItemsV4Schema 而非直接 ALTER）。
			if err := db.ensureVaultItemsV4Schema(); err != nil {
				return fmt.Errorf("v4: ensure deleted_at schema: %w", err)
			}
		}
		// 落版本号 —— 每个分支结束后单独 UPDATE，避免某个分支内部
		// 多步执行时中途崩溃导致版本号过早推进
		_, err := db.handle.Exec(
			`UPDATE vault_meta SET version = ? WHERE id = ?`,
			v, metaSingletonID,
		)
		if err != nil {
			return fmt.Errorf("v%d: bump version: %w", v, err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// vault_meta 读写
// ---------------------------------------------------------------------------

// HasMeta 检查 vault_meta 是否已存在初始化记录
//
// 用途：vaultservice.Status() / Initialize() 据此判断"vault 是否已经
// 初始化过"，决定走"创建主密码"还是"输入主密码解锁"流程。
//
// 实现：COUNT(*) 而不是 SELECT 1 + ErrNoRows 判断 —— 前者写起来更直观，
// vault_meta 单行表 COUNT 成本可忽略。
func (db *VaultDB) HasMeta() (bool, error) {
	var count int
	err := db.handle.QueryRow(`SELECT COUNT(*) FROM vault_meta WHERE id = ?`, metaSingletonID).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("count meta: %w", err)
	}
	return count > 0, nil
}

// ReadMeta 读取唯一一行 vault_meta
//
// 返回 (nil, nil) 表示尚未初始化（HasMeta=false 时）；调用方应该先用
// HasMeta 判断，避免依赖 nil 的语义模糊。
//
// 错误：DB I/O 错误 / KDF 标识不识别（防御未来用新算法创建的 vault 被
// 老应用打开）
func (db *VaultDB) ReadMeta() (*VaultMeta, error) {
	row := db.handle.QueryRow(`
		SELECT version, kdf, kdf_salt, kdf_memory_kib, kdf_iterations, kdf_parallelism,
		       wrapped_dek, verifier, created_at, updated_at
		FROM vault_meta WHERE id = ?
	`, metaSingletonID)

	var m VaultMeta
	var memKiB int64
	var iters int64
	var parallel int64
	err := row.Scan(
		&m.Version,
		&m.KDF,
		&m.KDFSalt,
		&memKiB,
		&iters,
		&parallel,
		&m.WrappedDEK,
		&m.Verifier,
		&m.CreatedAt,
		&m.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("scan meta: %w", err)
	}

	// SQLite 整数列扫到 int64；Argon2id 参数实际范围都在 uint32 / uint8 内，
	// 转换前做范围校验，防御被外部篡改写入越界值。
	if memKiB < 0 || memKiB > int64(^uint32(0)) {
		return nil, fmt.Errorf("kdf_memory_kib out of range: %d", memKiB)
	}
	if iters < 0 || iters > int64(^uint32(0)) {
		return nil, fmt.Errorf("kdf_iterations out of range: %d", iters)
	}
	if parallel < 0 || parallel > 255 {
		return nil, fmt.Errorf("kdf_parallelism out of range: %d", parallel)
	}
	m.KDFParams = Argon2idParams{
		MemoryKiB:   uint32(memKiB),
		Iterations:  uint32(iters),
		Parallelism: uint8(parallel),
		KeyLen:      KeySize,
	}

	if m.KDF != kdfNameArgon2id {
		return nil, fmt.Errorf("unsupported KDF: %q (only %q supported)", m.KDF, kdfNameArgon2id)
	}
	if err := m.KDFParams.Validate(); err != nil {
		return nil, fmt.Errorf("invalid kdf params in DB: %w", err)
	}
	return &m, nil
}

// WriteMeta 插入或覆盖 vault_meta 行
//
// 用 INSERT ... ON CONFLICT(id) DO UPDATE 实现 upsert：
//   - 第一次 Initialize：INSERT 新行
//   - ChangeMasterPassword：UPDATE 现有行（替换 kdf_salt / kdf_params /
//     wrapped_dek，verifier 也会被新 DEK 重新加密）
//
// updated_at 由调用方传入而不是 SQL strftime —— 让单测能注入固定时间。
func (db *VaultDB) WriteMeta(m *VaultMeta) error {
	if m == nil {
		return errors.New("nil meta")
	}
	if m.KDF != kdfNameArgon2id {
		return fmt.Errorf("unsupported KDF: %q", m.KDF)
	}
	if err := m.KDFParams.Validate(); err != nil {
		return err
	}
	if len(m.KDFSalt) != SaltSize {
		return fmt.Errorf("kdf_salt length must be %d, got %d", SaltSize, len(m.KDFSalt))
	}
	if len(m.WrappedDEK) == 0 || len(m.Verifier) == 0 {
		return errors.New("wrapped_dek / verifier cannot be empty")
	}

	// CreatedAt 留给首次 Initialize 显式设置；UPDATE 路径下保留原值靠
	// excluded.created_at 但我们用 COALESCE 技巧确保不被覆盖
	if m.CreatedAt == 0 {
		m.CreatedAt = time.Now().UnixMilli()
	}
	if m.UpdatedAt == 0 {
		m.UpdatedAt = time.Now().UnixMilli()
	}

	_, err := db.handle.Exec(`
		INSERT INTO vault_meta (
			id, version, kdf, kdf_salt, kdf_memory_kib, kdf_iterations, kdf_parallelism,
			wrapped_dek, verifier, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			version         = excluded.version,
			kdf             = excluded.kdf,
			kdf_salt        = excluded.kdf_salt,
			kdf_memory_kib  = excluded.kdf_memory_kib,
			kdf_iterations  = excluded.kdf_iterations,
			kdf_parallelism = excluded.kdf_parallelism,
			wrapped_dek     = excluded.wrapped_dek,
			verifier        = excluded.verifier,
			updated_at      = excluded.updated_at
			-- 注意：created_at 故意不在 UPDATE 列表里 —— upsert 时保留
			-- 原始创建时间，不被新值覆盖
	`,
		metaSingletonID,
		m.Version,
		m.KDF,
		m.KDFSalt,
		int64(m.KDFParams.MemoryKiB),
		int64(m.KDFParams.Iterations),
		int64(m.KDFParams.Parallelism),
		m.WrappedDEK,
		m.Verifier,
		m.CreatedAt,
		m.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("upsert meta: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// vault_items CRUD
// ---------------------------------------------------------------------------

// ListItems 返回所有「未删除」条目（按 updated_at 倒序）
//
// 默认过滤 deleted_at IS NULL —— tombstone 不返回给业务层（前端不可见）。
// 同步协议需要列举 tombstone 时改用 ListItemsWithTombstones。
//
// 整库扫描：vault 单库通常 < 10k 条，全量取出在 vaultservice 内解密
// 后做过滤 / 搜索；不在 SQL 层做（DB 看不到明文）。
//
// 排序选 updated_at DESC：列表"最近改的在最上面"是密码管理器惯例。
// 调用方如果需要其它顺序（创建时间 / 字母序）自己在内存里 sort。
func (db *VaultDB) ListItems() ([]VaultItemRow, error) {
	rows, err := db.handle.Query(`
		SELECT id, payload, created_at, updated_at, deleted_at
		FROM vault_items
		WHERE deleted_at IS NULL
		ORDER BY updated_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("query items: %w", err)
	}
	defer rows.Close()

	out := make([]VaultItemRow, 0, 16)
	for rows.Next() {
		var r VaultItemRow
		var deletedAt sql.NullInt64
		if err := rows.Scan(&r.ID, &r.Payload, &r.CreatedAt, &r.UpdatedAt, &deletedAt); err != nil {
			return nil, fmt.Errorf("scan item: %w", err)
		}
		if deletedAt.Valid {
			v := deletedAt.Int64
			r.DeletedAt = &v
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate items: %w", err)
	}
	return out, nil
}

// ListItemsWithTombstones 返回所有条目（含 tombstone），同步协议用
//
// 顺序与 ListItems 一致：updated_at DESC。前端绝不应调此接口（会看到墓碑）。
func (db *VaultDB) ListItemsWithTombstones() ([]VaultItemRow, error) {
	rows, err := db.handle.Query(`
		SELECT id, payload, created_at, updated_at, deleted_at
		FROM vault_items
		ORDER BY updated_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("query items with tombstones: %w", err)
	}
	defer rows.Close()

	out := make([]VaultItemRow, 0, 16)
	for rows.Next() {
		var r VaultItemRow
		var deletedAt sql.NullInt64
		if err := rows.Scan(&r.ID, &r.Payload, &r.CreatedAt, &r.UpdatedAt, &deletedAt); err != nil {
			return nil, fmt.Errorf("scan item: %w", err)
		}
		if deletedAt.Valid {
			v := deletedAt.Int64
			r.DeletedAt = &v
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// CountLiveItems 返回未删除条目数（SQL COUNT，不解密）
//
// Status() 用此接口暴露给前端的 ItemCount —— 不能简单用 len(ListItems)
// 因为那样 tombstone 也会计入。
func (db *VaultDB) CountLiveItems() (int, error) {
	var n int
	err := db.handle.QueryRow(
		`SELECT COUNT(*) FROM vault_items WHERE deleted_at IS NULL`,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count live items: %w", err)
	}
	return n, nil
}

// GetItem 按 id 读取单条（含 tombstone）
//
// 找不到返回 (nil, nil) —— 与"key not found"语义对齐，调用方据此返回
// HTTP 404 风格错误。区分"找不到"与"DB 错误"对前端体验很重要。
//
// 注意：本方法**不过滤** tombstone（DeletedAt 非 nil 也会返回），让调用方
// 自己根据语境决定行为：
//   - vaultservice.GetItem  解密 payload 后看到 tombstone → 返回 (nil, nil)
//   - vaultservice.DeleteItem / UpdateItem  需要拿到 tombstone 行做幂等判断
//   - 同步协议 fetch 必须看到 tombstone 才能告诉对端「这条被删了」
func (db *VaultDB) GetItem(id string) (*VaultItemRow, error) {
	if id == "" {
		return nil, errors.New("item id cannot be empty")
	}
	var r VaultItemRow
	var deletedAt sql.NullInt64
	err := db.handle.QueryRow(`
		SELECT id, payload, created_at, updated_at, deleted_at
		FROM vault_items WHERE id = ?
	`, id).Scan(&r.ID, &r.Payload, &r.CreatedAt, &r.UpdatedAt, &deletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get item %s: %w", id, err)
	}
	if deletedAt.Valid {
		v := deletedAt.Int64
		r.DeletedAt = &v
	}
	return &r, nil
}

// InsertItem 插入新条目
//
// id 由调用方生成（vaultservice 用 UUID v4）。created_at / updated_at
// 调用方传入（让单测可控时间）。
//
// 重复 id 会因为 PRIMARY KEY 约束失败 —— 调用方应保证 id 唯一。
func (db *VaultDB) InsertItem(r *VaultItemRow) error {
	if r == nil {
		return errors.New("nil item row")
	}
	if r.ID == "" {
		return errors.New("item id cannot be empty")
	}
	if len(r.Payload) == 0 {
		return errors.New("item payload cannot be empty")
	}
	now := time.Now().UnixMilli()
	if r.CreatedAt == 0 {
		r.CreatedAt = now
	}
	if r.UpdatedAt == 0 {
		r.UpdatedAt = now
	}
	var deletedAt sql.NullInt64
	if r.DeletedAt != nil {
		deletedAt = sql.NullInt64{Int64: *r.DeletedAt, Valid: true}
	}
	_, err := db.handle.Exec(`
		INSERT INTO vault_items (id, payload, created_at, updated_at, deleted_at)
		VALUES (?, ?, ?, ?, ?)
	`, r.ID, r.Payload, r.CreatedAt, r.UpdatedAt, deletedAt)
	if err != nil {
		return fmt.Errorf("insert item %s: %w", r.ID, err)
	}
	return nil
}

// InsertItemBatch 在单个事务内批量插入多条记录
//
// rows 为空切片时直接返回 nil（no-op）。
// 任意一行校验失败或插入出错，整批事务回滚并返回 error。
// 每行的 CreatedAt / UpdatedAt 若为 0，则统一填充为 Begin 前取得的同一 now 时间戳。
func (db *VaultDB) InsertItemBatch(rows []*VaultItemRow) error {
	if len(rows) == 0 {
		return nil
	}
	// 整批共用同一时间戳，在开启事务之前取一次
	now := time.Now().UnixMilli()

	// 逐行预校验，避免事务内途中才发现基础字段非法
	for _, r := range rows {
		if r == nil {
			return errors.New("nil item row in batch")
		}
		if r.ID == "" {
			return errors.New("item id cannot be empty")
		}
		if len(r.Payload) == 0 {
			return errors.New("item payload cannot be empty")
		}
	}

	tx, err := db.handle.Begin()
	if err != nil {
		return fmt.Errorf("begin batch insert transaction: %w", err)
	}

	for _, r := range rows {
		if r.CreatedAt == 0 {
			r.CreatedAt = now
		}
		if r.UpdatedAt == 0 {
			r.UpdatedAt = now
		}
		var deletedAt sql.NullInt64
		if r.DeletedAt != nil {
			deletedAt = sql.NullInt64{Int64: *r.DeletedAt, Valid: true}
		}
		_, err := tx.Exec(`
			INSERT INTO vault_items (id, payload, created_at, updated_at, deleted_at)
			VALUES (?, ?, ?, ?, ?)
		`, r.ID, r.Payload, r.CreatedAt, r.UpdatedAt, deletedAt)
		if err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("batch insert item %s: %w", r.ID, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit batch insert transaction: %w", err)
	}
	return nil
}

// UpdateItem 覆盖现有条目的 payload + updated_at（**不动** deleted_at 列）
//
// 找不到 id 返回 ErrItemNotFound（调用方据此 404）。
// created_at 不动 —— 创建时间是不可变事实。
//
// 接口契约：UpdateItem 永远不改变条目的「是否已删除」状态。
//   - 软删除请用 SoftDeleteItem
//   - 撤销 tombstone（从 deleted_at 非 NULL 改回 NULL）用 RestoreItem
//   - 这样让 vaultservice / passkeyservice 等业务方调用 UpdateItem 时不必
//     担心误复活墓碑或误删活动行。
func (db *VaultDB) UpdateItem(r *VaultItemRow) error {
	if r == nil {
		return errors.New("nil item row")
	}
	if r.ID == "" {
		return errors.New("item id cannot be empty")
	}
	if len(r.Payload) == 0 {
		return errors.New("item payload cannot be empty")
	}
	if r.UpdatedAt == 0 {
		r.UpdatedAt = time.Now().UnixMilli()
	}
	res, err := db.handle.Exec(`
		UPDATE vault_items SET payload = ?, updated_at = ? WHERE id = ?
	`, r.Payload, r.UpdatedAt, r.ID)
	if err != nil {
		return fmt.Errorf("update item %s: %w", r.ID, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("rows affected: %w", err)
	}
	if n == 0 {
		return ErrItemNotFound
	}
	return nil
}

// SoftDeleteItem 把活动行改为 tombstone
//
// 同时更新 payload（携带 plaintext deletedAt 字段，AEAD 保护）+ updated_at
// + deleted_at 列。调用方必须先把 plaintext payload 加密好。
//
// 找不到 id 返回 ErrItemNotFound。已 tombstone 的行也允许覆盖（幂等更新）。
func (db *VaultDB) SoftDeleteItem(id string, payload []byte, updatedAt, deletedAt int64) error {
	if id == "" {
		return errors.New("item id cannot be empty")
	}
	if len(payload) == 0 {
		return errors.New("payload cannot be empty")
	}
	if deletedAt <= 0 {
		return errors.New("deletedAt must be positive")
	}
	res, err := db.handle.Exec(`
		UPDATE vault_items SET payload = ?, updated_at = ?, deleted_at = ? WHERE id = ?
	`, payload, updatedAt, deletedAt, id)
	if err != nil {
		return fmt.Errorf("soft delete item %s: %w", id, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("rows affected: %w", err)
	}
	if n == 0 {
		return ErrItemNotFound
	}
	return nil
}

// RestoreItem 把 tombstone 改回活动行（deleted_at = NULL）
//
// 同步合并时若用户选「保留对端的活动版本，本地原本是 tombstone」，调用此方法。
// 找不到 id 返回 ErrItemNotFound。
func (db *VaultDB) RestoreItem(id string, payload []byte, updatedAt int64) error {
	if id == "" {
		return errors.New("item id cannot be empty")
	}
	if len(payload) == 0 {
		return errors.New("payload cannot be empty")
	}
	res, err := db.handle.Exec(`
		UPDATE vault_items SET payload = ?, updated_at = ?, deleted_at = NULL WHERE id = ?
	`, payload, updatedAt, id)
	if err != nil {
		return fmt.Errorf("restore item %s: %w", id, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("rows affected: %w", err)
	}
	if n == 0 {
		return ErrItemNotFound
	}
	return nil
}

// DeleteItem 删除条目；找不到 id 返回 ErrItemNotFound
//
// secure_delete pragma 已开启 —— 被删页填零，密文不会留在文件末尾的
// 未使用页里被取证软件恢复。
func (db *VaultDB) DeleteItem(id string) error {
	if id == "" {
		return errors.New("item id cannot be empty")
	}
	res, err := db.handle.Exec(`DELETE FROM vault_items WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete item %s: %w", id, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("rows affected: %w", err)
	}
	if n == 0 {
		return ErrItemNotFound
	}
	return nil
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

// ErrItemNotFound 表示按 id 查找 / 更新 / 删除时条目不存在
//
// 上层 vaultservice 用 errors.Is 判断后翻译成对前端的标准错误信息。
var ErrItemNotFound = errors.New("vault item not found")

// ---------------------------------------------------------------------------
// vault_trusted_device 读写
// ---------------------------------------------------------------------------

// HasTrustedDevice 检查是否启用了「在此设备上自动解锁」
//
// 在锁定状态下也能安全调用 —— 不需要 DEK，仅查询单例表是否有行。
// 用于：
//   - LockSync 启动时探测要不要尝试自动解锁
//   - SettingsPage 渲染开关初始状态
func (db *VaultDB) HasTrustedDevice() (bool, error) {
	var count int
	err := db.handle.QueryRow(
		`SELECT COUNT(*) FROM vault_trusted_device WHERE id = ?`,
		trustedDeviceSingletonID,
	).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("count trusted_device: %w", err)
	}
	return count > 0, nil
}

// ReadTrustedDevice 读取 trusted device 单例行
//
// 返回 (nil, nil) 表示未启用；调用方应该先用 HasTrustedDevice 判断，
// 避免依赖 nil 的语义模糊（与 ReadMeta 保持同样契约）。
func (db *VaultDB) ReadTrustedDevice() (*TrustedDeviceRow, error) {
	row := db.handle.QueryRow(`
		SELECT method, blob, created_at
		FROM vault_trusted_device WHERE id = ?
	`, trustedDeviceSingletonID)

	var r TrustedDeviceRow
	err := row.Scan(&r.Method, &r.Blob, &r.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("scan trusted_device: %w", err)
	}
	if r.Method == "" {
		return nil, fmt.Errorf("trusted_device.method is empty (corrupt row)")
	}
	if len(r.Blob) == 0 {
		return nil, fmt.Errorf("trusted_device.blob is empty (corrupt row)")
	}
	return &r, nil
}

// WriteTrustedDevice 插入或覆盖 trusted device 单例行
//
// 用 INSERT ... ON CONFLICT(id) DO UPDATE 实现 upsert：
//   - 第一次启用：INSERT 新行
//   - 重新封装（理论上当前不会触发，因为 DEK 不变就不需要重新封装；
//     保留语义以备未来扩展，比如轮换 entropy）：UPDATE 现有行
//
// CreatedAt 在 upsert 时保留原值（与 vault_meta.created_at 同样靠
// 排除在 UPDATE 列表之外实现），让「已信任 X 天」展示稳定。
func (db *VaultDB) WriteTrustedDevice(r *TrustedDeviceRow) error {
	if r == nil {
		return errors.New("nil trusted_device row")
	}
	if r.Method == "" {
		return errors.New("trusted_device.method cannot be empty")
	}
	if len(r.Blob) == 0 {
		return errors.New("trusted_device.blob cannot be empty")
	}
	if r.CreatedAt == 0 {
		r.CreatedAt = time.Now().UnixMilli()
	}

	_, err := db.handle.Exec(`
		INSERT INTO vault_trusted_device (id, method, blob, created_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			method = excluded.method,
			blob   = excluded.blob
			-- 注意：created_at 故意不在 UPDATE 列表里 —— upsert 时保留
			-- 原始启用时间，不被新值覆盖
	`,
		trustedDeviceSingletonID,
		r.Method,
		r.Blob,
		r.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("upsert trusted_device: %w", err)
	}
	return nil
}

// DeleteTrustedDevice 清空 trusted device 单例行
//
// 调用场景：
//   - 用户在 Settings 里关闭「在此设备上自动解锁」
//   - DPAPI/Keychain 解封失败（说明 OS 凭据已变化，blob 永远解不开了）
//   - 重置 vault / 删除 vault 流程
//
// 幂等：表为空时 DELETE 也不报错。
func (db *VaultDB) DeleteTrustedDevice() error {
	_, err := db.handle.Exec(
		`DELETE FROM vault_trusted_device WHERE id = ?`,
		trustedDeviceSingletonID,
	)
	if err != nil {
		return fmt.Errorf("delete trusted_device: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// vault_audit 读写
// ---------------------------------------------------------------------------

// AuditRow 是 vault_audit 一行的原始形式
//
// payload 是加密后的 AuditEntry JSON（aad = "audit:<id>"）。由 vault 服务层
// 负责加/解密 —— db 层只看密文。CreatedAt 是 unix 毫秒，由 vault 使用 nowMs()
// 单调递增生成（与 items 表同机制）。
type AuditRow struct {
	ID        int64
	Payload   []byte
	CreatedAt int64
}

// InsertAuditEntry 插入一条加密后的审计记录
//
// id 由 SQLite AUTOINCREMENT 生成，返回值给 vaultservice 拿去重新加密作 aad
// —— 如果不需要带 id 进 aad，这步也可以跳过。本实现里 aad = “audit:<id>”
// 是双安全「防同列搜    变位」的选择，调用方可以选是否二次调用 UpdateAuditPayload
// 重写为「id 参与加密」的形式。
func (db *VaultDB) InsertAuditEntry(r *AuditRow) (int64, error) {
	if r == nil {
		return 0, errors.New("nil audit row")
	}
	if len(r.Payload) == 0 {
		return 0, errors.New("audit payload cannot be empty")
	}
	now := r.CreatedAt
	if now == 0 {
		now = time.Now().UnixMilli()
	}
	res, err := db.handle.Exec(
		`INSERT INTO vault_audit (payload, created_at) VALUES (?, ?)`,
		r.Payload, now,
	)
	if err != nil {
		return 0, fmt.Errorf("insert audit: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("audit last insert id: %w", err)
	}
	return id, nil
}

// ListAuditEntries 查询最近 limit 条审计记录（按 id DESC）
//
// limit <= 0 返回空。返回顺序与内存 ring buffer snapshot 一致：最新的在前。
func (db *VaultDB) ListAuditEntries(limit int) ([]AuditRow, error) {
	if limit <= 0 {
		return nil, nil
	}
	rows, err := db.handle.Query(
		`SELECT id, payload, created_at FROM vault_audit ORDER BY id DESC LIMIT ?`,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query audit: %w", err)
	}
	defer rows.Close()

	out := make([]AuditRow, 0, limit)
	for rows.Next() {
		var r AuditRow
		if err := rows.Scan(&r.ID, &r.Payload, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan audit: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeleteAllAuditEntries 清空所有审计记录
//
// 用户点设置页「清空审计日志」时调。不重置 AUTOINCREMENT 计数       —— 「从现在起
// 最新 id 是 1000」会让源 SQLite 报“UNIQUE 冲突”的场景理论上一个“同一表      越过 9 万亿」
// 才出现，不值得动。
func (db *VaultDB) DeleteAllAuditEntries() error {
	_, err := db.handle.Exec(`DELETE FROM vault_audit`)
	if err != nil {
		return fmt.Errorf("delete all audit: %w", err)
	}
	return nil
}

// PruneAuditEntries 保留最新 keep 条，其余删除
//
// 调用场景：GUI 在解锁后 flush 内存 ring buffer 到 DB 后调一次，防止表
// 无限增长。keep < 0 是 noop。keep = 0 等价 DeleteAllAuditEntries。
func (db *VaultDB) PruneAuditEntries(keep int) error {
	if keep < 0 {
		return nil
	}
	_, err := db.handle.Exec(
		`DELETE FROM vault_audit
		 WHERE id NOT IN (
		   SELECT id FROM vault_audit ORDER BY id DESC LIMIT ?
		 )`,
		keep,
	)
	if err != nil {
		return fmt.Errorf("prune audit: %w", err)
	}
	return nil
}
