package services

// 配置文件读写服务 —— ZPass 桌面客户端
// ---------------------------------------------------------------------------
// 目标：把用户偏好 / 空间列表 / 账户登录态等前端状态持久化到
//
//       ~/.config/zpass/<namespace>.json
//
// 为什么走文件系统而不是浏览器 localStorage：
//   1. 安全直觉：密码管理器的配置（包含最后登录的账号、空间列表等元信息）
//      放在 WebView 的 localStorage 里，相当于把一份副本留在浏览器沙盒的
//      Indexed 数据库目录下（Windows 上是 `%APPDATA%\...\EBWebView\...`），
//      用户既无法直观感知、也无法手动备份 / 迁移 / 删除。落到 ~/.config
//      下是桌面端的惯例，用户"看得见、可删除、可版本控制"。
//   2. 跨 WebView 清理不敏感：Wails 3 在不同平台使用不同的 WebView 运行时
//      （WebView2 / WKWebView / WebKitGTK），localStorage 的存储位置各异，
//      更换运行时或重装应用可能导致用户配置丢失；走 ~/.config 与运行时解耦。
//   3. 产品规格：用户明确要求"配置信息严禁使用浏览器的 store 存储"。
//
// 为什么跨平台统一用 ~/.config/zpass（而不是 OS 默认应用配置目录）：
//   - Windows 上的惯例是 `%APPDATA%\com.zero.zpass`、macOS 上是
//     `~/Library/Application Support/...`；这符合各平台 OS 约定，但割裂了
//     "配置在一个固定目录"的用户心智模型。
//   - 本项目的产品规格明确：所有配置落到 ~/.config/zpass/，以 XDG Base
//     Directory 精神的延伸，三个平台保持同一路径约定（Windows 上即
//     %USERPROFILE%\.config\zpass\）。
//   - 这个决策带来的代价：不走系统默认的"应用配置目录"，意味着无法享受
//     Windows 的自动漫游（Roaming）或 macOS 的 Time Machine 自动备份策略，
//     但换来了跨平台路径一致的可预测性，对这个项目是合算的。
//
// ---------------------------------------------------------------------------
// 对外暴露 4 个 Wails 服务方法：
//
//   Dir()                    → 返回 ~/.config/zpass 的绝对路径字符串
//   Read(namespace)          → 读取 <namespace>.json，返回 JSON 字符串或 ""（不存在）
//   Write(namespace, value)  → 写入 <namespace>.json（原子写：tmp + rename）
//   Remove(namespace)        → 删除 <namespace>.json（幂等）
//
// 前端侧在 src/lib/config-storage.ts 里把这四条方法包装成 zustand 的
// PersistStorage 实现（getItem / setItem / removeItem）。
//
// 命名规范：方法首字母大写以满足 Wails 3 的导出可见性要求；前端通过
// `Call.ByName("main.ConfigService.<Method>", ...)` 路由调用。
//
// ---------------------------------------------------------------------------
// 原子写策略：
//   1. 序列化后写入 `<namespace>.json.tmp`
//   2. flush + Sync（把内核缓冲刷到磁盘）
//   3. rename(tmp → 正式文件) —— 在同一目录下，POSIX & NTFS 均为原子操作
//
//   这样即使写入过程中断电 / 崩溃，也不会出现"半截 JSON 损坏"的情况，
//   最多丢失本次写入，下次启动仍能用上一次完整快照恢复。
//
// ---------------------------------------------------------------------------
// namespace 校验：
//   - 仅允许 [a-zA-Z0-9_.-]，防止前端传入 "../../etc/passwd" 之类的路径穿越。
//   - 长度 1-64 字符。
//   - 显式禁止 "." 与 ".."。
//   - 非法 namespace 直接返回 error 而非 silently-fallback，暴露调用方 bug。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// 配置根目录名称 —— 所有文件都落在 `<home>/.config/zpass/` 下
//
// 注意：即便在 Windows 上我们也刻意使用 `.config` 而不是 `AppData`，
// 保持三端路径一致。Windows 对前缀 `.` 的目录不视为隐藏（需配合 attrib +H），
// 但这不影响程序行为。
const (
	configRootDirname = ".config"
	appConfigDirname  = "zpass"
	maxNamespaceLen   = 64
)

// ConfigService 是 Wails 3 注入到前端的服务对象。
//
// 设计成"零字段"结构体的理由：
//   - 配置目录路径每次按需从 os.UserHomeDir() 计算，避免缓存引用过期 home
//     （macOS 上某些登录会话切换会变更 HOME），也减少初始化顺序耦合。
//   - 真正需要昂贵初始化的依赖（如打开 SQLite 句柄）才放字段；本服务都是
//     一次性 IO，没有共享状态。
type ConfigService struct{}

// NewConfigService 构造一个新的 ConfigService。当前没有依赖注入需求，
// 但保留构造函数有两点价值：
//  1. 与 main.go 里 `application.NewService(NewConfigService())` 的写法一致，
//     未来引入依赖（如日志器、加密密钥）时可以无侵入扩展。
//  2. 便于测试时通过 mock 替换。
func NewConfigService() *ConfigService {
	return &ConfigService{}
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

// resolveConfigDir 解析 `~/.config/zpass/` 的绝对路径
//
// 副作用：调用此函数**不会**创建目录，只做路径拼接。目录创建延迟到
// 第一次写文件时（见 ensureConfigDir），避免纯读路径场景下不必要的 mkdir。
func resolveConfigDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot resolve user home directory: %w", err)
	}
	return filepath.Join(home, configRootDirname, appConfigDirname), nil
}

// ensureConfigDir 确保配置目录存在（不存在则递归创建），并返回它的路径
//
// os.MkdirAll 在目录已存在时是幂等的，不会返回错误，无需先 stat 检查。
//
// 权限 0o755：用户可读写执行，组和其它只可读和进入。这是 Linux/macOS 上
// 用户私人配置目录的常见权限；Windows 不使用 unix mode bits，由 NTFS ACL
// 控制访问，os.MkdirAll 会忽略 mode 参数。
func ensureConfigDir() (string, error) {
	dir, err := resolveConfigDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("cannot create config dir %q: %w", dir, err)
	}
	return dir, nil
}

// validateNamespace 校验 namespace 合法性
//
// 规则：
//   - 长度 1..=64
//   - 仅允许 ASCII 字母、数字、下划线、点号、连字符
//
// 显式禁止：
//   - 空串（会导致文件名为 `.json`，隐藏文件、易混淆）
//   - `/` `\` `..`（路径穿越）
//   - 空白字符（跨平台行为差异大）
//   - `.` 与 `..` 整体作为 namespace（即使字符全是 ASCII 也禁止）
func validateNamespace(namespace string) error {
	n := len(namespace)
	if n == 0 || n > maxNamespaceLen {
		return fmt.Errorf("invalid config namespace: %q (allowed: 1-%d chars of [A-Za-z0-9_.-])", namespace, maxNamespaceLen)
	}
	if namespace == "." || namespace == ".." {
		return fmt.Errorf("invalid config namespace: %q (reserved)", namespace)
	}
	for i := 0; i < n; i++ {
		b := namespace[i]
		ok := (b >= 'a' && b <= 'z') ||
			(b >= 'A' && b <= 'Z') ||
			(b >= '0' && b <= '9') ||
			b == '_' || b == '.' || b == '-'
		if !ok {
			return fmt.Errorf("invalid config namespace: %q (contains disallowed character at offset %d)", namespace, i)
		}
	}
	return nil
}

// resolveFilePath 由 namespace 推导出具体 JSON 文件路径
func resolveFilePath(dir, namespace string) string {
	return filepath.Join(dir, namespace+".json")
}

// ---------------------------------------------------------------------------
// Wails 暴露的服务方法 —— 前端通过 Call.ByName("main.ConfigService.<X>", ...) 调用
// ---------------------------------------------------------------------------

// Dir 返回 ~/.config/zpass/ 的绝对路径字符串
//
// 调用场景：
//   - 前端在 Settings "关于"区展示"配置目录"给用户看
//   - 开发 / 诊断时直接打开目录排查
//
// 不做 mkdir —— 仅用于展示。真正写入文件时 ensureConfigDir 会兜底创建。
func (c *ConfigService) Dir() (string, error) {
	dir, err := resolveConfigDir()
	if err != nil {
		return "", err
	}
	return dir, nil
}

// Read 读取指定 namespace 的 JSON 文件
//
// - 文件存在 → 返回 (<文件内容>, nil)（不做 JSON 解析，交给前端）
// - 文件不存在 → 返回 ("", nil)（首次启动、用户从未写入过）
// - 文件存在但读失败（权限 / 磁盘错误）→ 返回 ("", err)
//
// 返回原始字符串而非 map[string]any 是刻意的：
//   - zustand 的 PersistStorage 接口就是 `string | null`，前端拿到后直接
//     JSON.parse 即可，多一次 Go 侧解析 + 再序列化没有意义。
//   - 如果文件内容已损坏（不是合法 JSON），错误应该在前端 parse 时暴露
//     并触发"回落到默认值"的逻辑，而不是在 Go 侧把它当成 I/O 错误吞掉。
//
// 文件不存在返回空串而不是错误：与 zustand persist 协议契合，前端把
// 空串视为"无数据"使用默认值。这避免每次首启都打印一条"文件未找到"
// 的错误日志，干扰真实问题排查。
func (c *ConfigService) Read(namespace string) (string, error) {
	if err := validateNamespace(namespace); err != nil {
		return "", err
	}
	dir, err := resolveConfigDir()
	if err != nil {
		return "", err
	}
	path := resolveFilePath(dir, namespace)

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	return string(data), nil
}

// Write 原子写入指定 namespace 的 JSON 文件
//
// 流程：
//  1. 校验 namespace
//  2. 校验 value 是合法 JSON（防止前端传入半截字符串污染磁盘）
//  3. 确保配置目录存在
//  4. 写 `<namespace>.json.tmp`
//  5. flush + Sync（把内核缓冲刷到磁盘）
//  6. rename(tmp → 正式文件)
//
// 为什么第 2 步要校验 JSON：
//   - 前端的 zustand persist 理论上总会传入合法 JSON，但我们把它作为
//     "一切来自前端的输入都不信任"的防御编程实践。一旦写入非法 JSON，
//     下次 Read 返回给前端后会抛解析错误，用户体验更差。
//
// 为什么不写日期 suffix 的 snapshot：
//   - 这不是 vault 加密数据，只是 UI 偏好 + 空间列表等元数据，损坏后
//     回落到默认值即可；多一份快照反而增加磁盘占用与"哪份最新"的混淆。
//
// 文件权限 0o600：仅当前用户可读写。配置内容包含登录邮箱等可识别信息，
// 即使非密钥也不应该让同机其它用户读到。Windows 同样忽略此 mode，由
// NTFS ACL 默认的"用户目录仅自身可访问"承担保护。
func (c *ConfigService) Write(namespace, value string) error {
	if err := validateNamespace(namespace); err != nil {
		return err
	}

	// 校验 value 是合法 JSON —— Unmarshal 仅为结构验证，
	// 解析结果不使用（原样写入磁盘保留前端的 key 顺序与数字精度）
	var probe any
	if err := json.Unmarshal([]byte(value), &probe); err != nil {
		return fmt.Errorf("config value is not valid JSON: %w", err)
	}

	dir, err := ensureConfigDir()
	if err != nil {
		return err
	}
	finalPath := resolveFilePath(dir, namespace)
	// tmp 文件放同一目录下，rename 才能保证跨文件系统一致性与原子性。
	//
	// ⚠️ 必须用「唯一」tmp 文件名（os.CreateTemp 的 * 通配），不能用固定的
	// `<namespace>.json.tmp`：同一 namespace 的并发写（如 store 启动时连续多次
	// setState 触发的多次 setItem）若共用同一 tmp 路径会相互踩踏 —— 写 A 与写 B
	// 都写同一个 tmp，A 先 rename 走，B 再 rename 时 tmp 已不存在 →
	// "rename …tmp -> …json: no such file or directory"，且 B 的内容丢失。
	// 唯一 tmp 名让每个写各自独立，最后 rename 者胜（last-writer-wins，与
	// zustand 每次 setState 全量覆盖的语义一致）。
	tmp, err := os.CreateTemp(dir, namespace+".json.*.tmp")
	if err != nil {
		return fmt.Errorf("create temp for %s: %w", namespace, err)
	}
	tmpPath := tmp.Name()
	// writeAndSync 会以 O_TRUNC 重新打开该路径；这里先关掉空句柄。唯一文件名
	// 已经规避了并发 writer 竞态，重开写入的微小开销可忽略。
	_ = tmp.Close()

	if err := writeAndSync(tmpPath, value); err != nil {
		// 写失败时主动清理 tmp，避免磁盘积累半成品
		_ = os.Remove(tmpPath)
		return err
	}

	// rename 在同目录下跨平台均为原子操作（POSIX rename(2) + NTFS MoveFileEx）。
	// 如果目标文件已存在，rename 会覆盖它（Go 的 os.Rename 在 Windows 上
	// 使用 MoveFileEx 带 MOVEFILE_REPLACE_EXISTING，行为与 POSIX 一致）。
	if err := os.Rename(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("rename %s -> %s: %w", tmpPath, finalPath, err)
	}

	return nil
}

// writeAndSync 把 content 写入 path，并在关闭前同步到磁盘。
//
// 拆分成独立函数的理由：把 Sync 必须先于 Close 的约束封装在一处，
// 避免调用方误用 defer Close + Sync 的错误顺序导致 Sync 作用于已关闭句柄。
func writeAndSync(path, content string) error {
	// O_TRUNC 保证 tmp 文件即使因为前一次失败仍然残留也会被覆写。
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}

	if _, err := f.WriteString(content); err != nil {
		_ = f.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}

	// Sync 把数据 + 元数据落盘；在 Windows 上映射为 FlushFileBuffers，
	// 在 POSIX 上为 fsync，确保 rename 生效后文件不是"空壳"。
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return fmt.Errorf("sync %s: %w", path, err)
	}

	if err := f.Close(); err != nil {
		return fmt.Errorf("close %s: %w", path, err)
	}

	return nil
}

// Remove 删除指定 namespace 的 JSON 文件
//
// - 文件存在 → 删除并返回 nil
// - 文件不存在 → 返回 nil（幂等，符合"清空该 key"的语义）
// - 权限 / 其它 I/O 错误 → 返回 error
//
// 对应 zustand PersistStorage 的 removeItem。虽然 zustand 在 persist 正常
// 流程中不会调用 removeItem（它通过 setItem 覆盖），但实现完整是为了给
// 前端预留"恢复默认设置"按钮之类的未来能力。
func (c *ConfigService) Remove(namespace string) error {
	if err := validateNamespace(namespace); err != nil {
		return err
	}
	dir, err := resolveConfigDir()
	if err != nil {
		return err
	}
	path := resolveFilePath(dir, namespace)

	if err := os.Remove(path); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("remove %s: %w", path, err)
	}
	return nil
}
