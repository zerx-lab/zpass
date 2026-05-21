package services

// browsersaveignore.go —— 浏览器扩展 "永不保存这个站点" 的持久化清单。
//
// 行为对齐 Bitwarden NeverSaveDomains：用户在保存提示里点 "Never" 后，
// 该 origin 写入清单；后续在该 origin 上 captureLogin 时跳过 prompt。
//
// 存储格式：`~/.config/zpass/zpass.browser-save-ignored.json`
//
//	{ "origins": ["https://example.com", "https://app.example.com"] }
//
// 关键约束：
//   - 走 ConfigService 同一目录，落盘格式与前端 zustand persist 兼容；
//   - origin 在写入前 lower-case + 去末尾 `/`，避免大小写 / 尾斜杠重复；
//   - 读取出错（文件不存在 / 损坏）一律视为空清单，不阻断 save prompt
//     —— 比 "弹错误" 更符合"安静的密码管理器"产品直觉；
//   - 并发：所有方法在调用前先取一把进程级 mutex。配置文件 read-modify-write
//     之间如果有别的进程实例（不应发生但保险），最后一个写入者覆盖前面的。

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const browserSaveIgnoreNamespace = "zpass.browser-save-ignored"

// browserSaveIgnoreFile 是写入 ConfigService 目录里的实际文件名。
// 与 ConfigService.Write 走的格式一致：`<namespace>.json`。
func browserSaveIgnoreFile() (string, error) {
	dir, err := resolveConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, browserSaveIgnoreNamespace+".json"), nil
}

type browserSaveIgnoreDoc struct {
	Origins []string `json:"origins"`
}

// browserSaveIgnoreMu 序列化清单的 read-modify-write，避免两个并发请求
// 同时 Add 时丢一个。进程级互斥就够 —— 配置只有一个 desktop 实例写。
var browserSaveIgnoreMu sync.Mutex

// LoadBrowserSaveIgnoreList 读出当前清单。文件不存在或损坏一律返空切片。
func LoadBrowserSaveIgnoreList() ([]string, error) {
	browserSaveIgnoreMu.Lock()
	defer browserSaveIgnoreMu.Unlock()
	return loadBrowserSaveIgnoreLocked()
}

// AddBrowserSaveIgnoreOrigin 把 origin 写入清单（幂等，重复添加不报错）。
func AddBrowserSaveIgnoreOrigin(origin string) error {
	normalized := normalizeIgnoreOrigin(origin)
	if normalized == "" {
		return errors.New("Invalid origin to ignore.")
	}
	browserSaveIgnoreMu.Lock()
	defer browserSaveIgnoreMu.Unlock()
	list, err := loadBrowserSaveIgnoreLocked()
	if err != nil {
		return err
	}
	for _, existing := range list {
		if existing == normalized {
			return nil
		}
	}
	list = append(list, normalized)
	return saveBrowserSaveIgnoreLocked(list)
}

// IsBrowserSaveIgnored 判断 origin 是否在 ignore 清单中。
//
// 读失败一律返 false —— "ignore 文件读不到" 不应让用户失去保存提示。
func IsBrowserSaveIgnored(origin string) bool {
	normalized := normalizeIgnoreOrigin(origin)
	if normalized == "" {
		return false
	}
	browserSaveIgnoreMu.Lock()
	defer browserSaveIgnoreMu.Unlock()
	list, err := loadBrowserSaveIgnoreLocked()
	if err != nil {
		return false
	}
	for _, existing := range list {
		if existing == normalized {
			return true
		}
	}
	return false
}

func loadBrowserSaveIgnoreLocked() ([]string, error) {
	path, err := browserSaveIgnoreFile()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var doc browserSaveIgnoreDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		// 文件损坏 —— 安静返空清单，不让损坏的配置导致 prompt 永久关闭。
		return nil, nil
	}
	out := make([]string, 0, len(doc.Origins))
	for _, raw := range doc.Origins {
		if normalized := normalizeIgnoreOrigin(raw); normalized != "" {
			out = append(out, normalized)
		}
	}
	return out, nil
}

func saveBrowserSaveIgnoreLocked(list []string) error {
	dir, err := ensureConfigDir()
	if err != nil {
		return err
	}
	path := filepath.Join(dir, browserSaveIgnoreNamespace+".json")
	doc := browserSaveIgnoreDoc{Origins: list}
	data, err := json.MarshalIndent(&doc, "", "  ")
	if err != nil {
		return err
	}
	// 原子写：tmp + rename，对齐 ConfigService.Write 的策略。
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// normalizeIgnoreOrigin 把 origin 规范化为 lower-case scheme+host(+port)，
// 没有路径 / 查询串 / 尾斜杠。空串视为无效（返 ""）。
//
// 我们故意 **不** 拼上 PSL eTLD+1 —— 用户点 "Never" 的是 *这个具体 origin*，
// 比如同一公司不同子域的不同登录页应该独立判断。需要更宽匹配时用户可以
// 在桌面端手动管理（未来 UI）。
func normalizeIgnoreOrigin(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	trimmed = strings.TrimRight(trimmed, "/")
	// 不 url.Parse —— 我们存的就是 `scheme://host[:port]` 形态，避免
	// "http://" → host="" 的解析坑。直接 lower-case 即可。
	return strings.ToLower(trimmed)
}
