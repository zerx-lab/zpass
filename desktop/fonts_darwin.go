package main

// fonts_darwin.go — macOS 平台字体列表实现
//
// 扫描以下标准字体目录中的 .ttf / .otf / .ttc 文件，
// 以文件名（去扩展名）作为字体名称：
//
//	/System/Library/Fonts        — macOS 系统内置字体
//	/Library/Fonts               — 全局安装字体
//	~/Library/Fonts              — 当前用户字体
//
// 注意：文件名不等于字体族名（PostScript name），但无需解析字体文件
// 本身即可获得，且对 UI 展示已经足够准确。

import (
	"strings"
)

// getSystemFontsForPlatform 扫描 macOS 标准字体目录，返回字体名称列表。
func getSystemFontsForPlatform() []string {
	dirs := []string{
		"/System/Library/Fonts",
		"/Library/Fonts",
	}

	// 追加用户字体目录 ~/Library/Fonts
	if userDir := homeFontDir("Library/Fonts"); userDir != "" {
		dirs = append(dirs, userDir)
	}

	raw := scanFontDirs(dirs)

	// 去掉常见的平台前缀风格（macOS 部分字体文件名含 . 分隔的 PostScript 片段，
	// 如 "Helvetica.dfont" → "Helvetica"），已由 scanFontDirs 处理扩展名，
	// 这里再做一次美化：将下划线替换为空格，方便展示。
	names := make([]string, 0, len(raw))
	for _, n := range raw {
		n = strings.ReplaceAll(n, "_", " ")
		if n != "" {
			names = append(names, n)
		}
	}
	return names
}
