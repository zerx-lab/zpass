package services

// 导出服务（明文备份）
// ---------------------------------------------------------------------------
// ExportService 提供「把整个 vault 以明文 JSON 形式导出到本地文件」的能力。
//
// 设计原则：
//   1. 明文是用户的明确意图 —— 类似 Bitwarden 的「Export vault」，用户主动
//      触发，前端会有显著警告 + 主密码二次确认。本服务不主动加密导出
//      内容（用户可以用 GPG / age / 7z 自行包一层加密层），但调用入口前
//      必须先调 VaultService.VerifyMasterPassword 通过。
//
//   2. 明文数据不跨 IPC：所有解密 + JSON 组装 + 文件写入都在 Go 进程内
//      完成。前端只拿到「写入路径 + 条目数 + 字节数」这类元信息，整库
//      明文不会出现在 webview 进程内存。
//
//   3. 写入路径由系统 SaveFile dialog 选定：避免代码硬编码导致用户找不
//      到、或者写到不该写的位置。用户取消 dialog 视为正常流程（不抛错）。
//
//   4. 文件原子写入：先写到 <path>.zpass-export.tmp，再 rename 成最终
//      文件名，避免半途崩溃留下残缺文件让用户误用。
//
// 与 ImportService（前端 import-bitwarden.ts）的对偶关系：
//   - 导入：用户选 Bitwarden JSON → 前端解析 → 逐条 CreateItem（加密入库）
//   - 导出：用户点导出 → 后端列出所有 item → 解密 → 写 JSON 到磁盘
//
// 兼容性：
//   - 当前 schema 版本 = "zpass-export-v1"
//   - 字段命名保持与 ItemPayload 一致，方便未来「ZPass 互导」无损迁移
//   - items[].fields 是原始 map[string]any，所有类型相关字段（password /
//     totp / privateKeyPkcs8 / private_key 等）原样保留。

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// exportSchemaVersion 写入导出 JSON 顶层 schemaVersion 字段。
//
// 升版策略：仅当格式发生 不兼容 变更时才 bump；新增可选字段不需要升版。
// 如果未来格式有破坏性变更，用 v2 / v3 等，导入方按版本号分支解析。
const exportSchemaVersion = "zpass-export-v1"

// exportAppVersion 写入导出 JSON 顶层 appVersion 字段。
//
// 与前端 AboutSection 的 version 常量保持同步；当前没有统一 build-stamp，
// 暂用硬编码。后续接入 ldflags -X 注入时把这里改成 var。
const exportAppVersion = "0.1.0"

// ExportService 是注入给 Wails 的导出服务实例。
//
// 字段：
//   - vault：复用 VaultService 的解锁状态 + 解密能力；不存第二份 DEK。
//
// 服务方法（首字母大写，会被 Wails 反射注册到前端）：
//   - ExportAllToFile() (*ExportResult, error)
//   - GenerateDefaultFilename() string
type ExportService struct {
	vault *VaultService
}

// NewExportService 构造 ExportService。
//
// main.go 在 vaultService 创建后立刻构造本服务，并通过 application.NewService
// 注册到 Wails。两个 service 同 main 包，没有 import 循环风险。
func NewExportService(v *VaultService) *ExportService {
	return &ExportService{vault: v}
}

// ExportResult 是导出操作返回给前端的结果摘要。
//
// 字段刻意 不包含 任何 vault 明文 —— 前端只展示「导出到 X，共 N 条，大小 K」
// 这类操作回执。整库明文已经写入用户选定的磁盘文件，不再经 IPC 回传。
//
// Cancelled 表示用户在 SaveFile dialog 上点了取消；前端据此区分「成功导出」
// 和「主动放弃」，避免把取消当作错误弹红色 toast。
type ExportResult struct {
	Path      string `json:"path"`
	Cancelled bool   `json:"cancelled"`
	ItemCount int    `json:"itemCount"`
	SizeBytes int    `json:"sizeBytes"`
}

// exportEnvelope 是写入磁盘的顶层 JSON 结构。
//
// 字段含义：
//   - SchemaVersion：见 exportSchemaVersion 注释
//   - ExportedAt   ：导出时刻 unix ms（写文件前取一次）
//   - AppVersion   ：导出端 ZPass 版本，便于日后排障定位
//   - ItemCount    ：items 数组长度的冗余字段，导入端可快速校验
//   - Items        ：完整 ItemPayload 切片（含 fields）
//
// 不内嵌任何「设备指纹 / 用户 ID」—— 导出文件应该是「自包含、不泄漏其它身份信息」。
type exportEnvelope struct {
	SchemaVersion string        `json:"schemaVersion"`
	ExportedAt    int64         `json:"exportedAt"`
	AppVersion    string        `json:"appVersion"`
	ItemCount     int           `json:"itemCount"`
	Items         []ItemPayload `json:"items"`
}

// GenerateDefaultFilename 返回建议的导出文件名（不含路径）。
//
// 格式：zpass-export-YYYYMMDD-HHMMSS.json
//
// 仅给 SaveFile dialog 当默认文件名用；用户可在 dialog 里改名。
// 暴露给前端是因为前端弹「即将导出」确认框时可以预览文件名。
func (e *ExportService) GenerateDefaultFilename() string {
	return defaultExportFilename(time.Now())
}

// defaultExportFilename 是 GenerateDefaultFilename 的纯函数版，便于测试。
func defaultExportFilename(now time.Time) string {
	return fmt.Sprintf("zpass-export-%s.json", now.Format("20060102-150405"))
}

// ExportAllToFile is the entry point for vault export.
//
// Flow:
//  1. Call VaultService.exportAllPayloads() to decrypt every item in one go;
//     the vault must be unlocked or ErrVaultLocked is returned.
//  2. Marshal the envelope as pretty-printed JSON (so a user can cat the
//     backup) and atomically write it to path (tmp + fsync + rename).
//
// The save-file dialog is no longer the backend's responsibility: under the
// new Electron architecture, the renderer/main process picks the path via
// the platform-native dialog and passes it here. An empty path is treated
// as cancellation and returns {Cancelled: true} without writing anything,
// matching the previous Wails contract observed by the frontend.
//
// Security: callers should still gate this on a fresh master-password
// confirmation (VaultService.VerifyMasterPassword); this method itself
// trusts that the vault is already unlocked for the right reasons.
func (e *ExportService) ExportAllToFile(path string) (*ExportResult, error) {
	if e.vault == nil {
		return nil, errors.New("export service: vault not configured")
	}

	if strings.TrimSpace(path) == "" {
		// User cancelled the save dialog upstream. Frontends rely on
		// {cancelled: true} (not an error) to avoid flashing a red toast.
		return &ExportResult{Cancelled: true}, nil
	}

	payloads, err := e.vault.exportAllPayloads()
	if err != nil {
		return nil, err
	}

	now := time.Now()
	envelope := exportEnvelope{
		SchemaVersion: exportSchemaVersion,
		ExportedAt:    now.UnixMilli(),
		AppVersion:    exportAppVersion,
		ItemCount:     len(payloads),
		Items:         payloads,
	}

	data, err := json.MarshalIndent(&envelope, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshal export envelope: %w", err)
	}

	// Force a .json extension when the user typed one without it. Prevents
	// the OS from showing a "no associated program" file.
	finalPath := ensureJSONExtension(path)

	if err := writeFileAtomic(finalPath, data); err != nil {
		return nil, fmt.Errorf("write export file: %w", err)
	}

	return &ExportResult{
		Path:      finalPath,
		Cancelled: false,
		ItemCount: len(payloads),
		SizeBytes: len(data),
	}, nil
}

// ensureJSONExtension 如果路径没有 .json 扩展名，则补上。
//
// 大小写不敏感（用户写成 .JSON 仍视为合法），仅当结尾不是 .json 时
// 才追加。空路径直接原样返回（调用方应在外层判空）。
func ensureJSONExtension(p string) string {
	if p == "" {
		return p
	}
	ext := strings.ToLower(filepath.Ext(p))
	if ext == ".json" {
		return p
	}
	return p + ".json"
}

// writeFileAtomic 把 data 原子写入 finalPath。
//
// 实现策略（与 vault.db 写策略相似）：
//  1. 在同目录写 <basename>.<random>.tmp
//  2. Sync() 刷盘
//  3. Rename 到 finalPath
//  4. 失败时尝试删除 .tmp 残骸（best-effort）
//
// 同目录是为了让 rename 是同一文件系统的原子操作 —— 跨盘 rename
// 在 Windows 上不保证原子，且会退化为 copy+delete 失去意义。
//
// 不使用 os.WriteFile：那是非原子的（write 一半崩溃留半截文件），
// 用户重启后可能误以为是有效备份。
func writeFileAtomic(finalPath string, data []byte) error {
	dir := filepath.Dir(finalPath)
	base := filepath.Base(finalPath)

	tmp, err := os.CreateTemp(dir, base+".*.tmp")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpName := tmp.Name()

	// best-effort 清理：成功 rename 后 tmp 已经不存在，这里 Remove 必报
	// not exist，可安全忽略；失败路径上 tmp 仍在，删一下避免污染目录。
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temp: %w", err)
	}
	// fsync 确保数据真正落盘后再 rename，避免「rename 成功但内容是 0 字节」
	// 的电源故障窗口。Windows 上 Sync 也会触发 FlushFileBuffers，同样可靠。
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp: %w", err)
	}

	// Windows 上 rename 到已存在文件需要先删，os.Rename 自身会处理大多
	// 数情况；如果失败就显式 remove + 重试一次，覆盖既有备份是常见操作。
	if err := os.Rename(tmpName, finalPath); err != nil {
		if runtime.GOOS == "windows" {
			if rmErr := os.Remove(finalPath); rmErr == nil {
				if err2 := os.Rename(tmpName, finalPath); err2 == nil {
					cleanup = false
					return nil
				}
			}
		}
		return fmt.Errorf("rename temp to final: %w", err)
	}
	cleanup = false
	return nil
}
