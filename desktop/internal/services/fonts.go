package services

// fonts.go — FontService
//
// 提供 GetSystemFonts() 方法，返回当前系统上可用的字体名称列表。
//
// 跨平台策略：
//   - Windows：读取注册表 HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts
//              使用 golang.org/x/sys/windows/registry（已在 go.mod 中）
//   - macOS：  扫描 /System/Library/Fonts、/Library/Fonts、~/Library/Fonts
//              目录中的 .ttf / .otf / .ttc 文件，去扩展名作字体名
//   - Linux：  exec `fc-list : family` 并解析输出
//
// 内置字体（App 自带，始终置顶）：
//   Geist、Geist Mono
//
// 返回值：去重 + 排序（内置字体置顶，其余字母序）。
//
// 前端通过 wails3 generate bindings 产生的 fontservice.js binding 调用，
// 路径为 Call.ByName("main.FontService.GetSystemFonts")。

import (
	"os/user"
	"path/filepath"
	"sort"
	"strings"
)

// builtinFonts 是 App 自带的字体，无论系统是否安装都始终出现在列表最前。
var builtinFonts = []string{"Geist", "Geist Mono"}

// FontService 提供字体相关的系统服务。
type FontService struct{}

// NewFontService 创建 FontService 实例。
func NewFontService() *FontService {
	return &FontService{}
}

// GetSystemFonts 返回系统可用的字体名称列表。
//
// 内置字体（Geist、Geist Mono）始终排在最前，其余字体按字母序排列。
// 所有字体名称已去重。
func (f *FontService) GetSystemFonts() []string {
	systemFonts := getSystemFontsForPlatform()

	// 用 map 去重（先把内置字体放入，系统字体中重名的会被跳过）
	seen := make(map[string]bool, len(builtinFonts)+len(systemFonts))
	for _, name := range builtinFonts {
		seen[name] = true
	}

	var extra []string
	for _, name := range systemFonts {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		extra = append(extra, name)
	}

	sort.Strings(extra)

	// 内置字体置顶，其余字体字母序追加
	result := make([]string, 0, len(builtinFonts)+len(extra))
	result = append(result, builtinFonts...)
	result = append(result, extra...)
	return result
}

// ---------------------------------------------------------------------------
// 平台无关辅助：扫描目录中的字体文件，提取字体名（文件名去扩展名）
// ---------------------------------------------------------------------------

// scanFontDirs 遍历给定目录，收集 .ttf / .otf / .ttc 文件的"去扩展名"名称。
func scanFontDirs(dirs []string) []string {
	fontExts := map[string]bool{
		".ttf": true,
		".otf": true,
		".ttc": true,
	}

	var names []string
	for _, dir := range dirs {
		// 只扫一层，避免深递归
		matches, err := filepath.Glob(filepath.Join(dir, "*"))
		if err != nil {
			continue
		}
		for _, p := range matches {
			ext := strings.ToLower(filepath.Ext(p))
			if !fontExts[ext] {
				continue
			}
			base := filepath.Base(p)
			name := strings.TrimSuffix(base, filepath.Ext(base))
			if name != "" {
				names = append(names, name)
			}
		}
	}
	return names
}

// homeFontDir 返回用户级字体目录（跨平台），失败时返回空字符串。
func homeFontDir(subPath string) string {
	u, err := user.Current()
	if err != nil {
		return ""
	}
	return filepath.Join(u.HomeDir, subPath)
}
