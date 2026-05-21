package services

// fonts_windows.go — Windows 平台字体列表实现
//
// 通过读取注册表键：
//   HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts
// 获取所有已注册字体的名称。
//
// 注册表 value 名格式示例：
//   "Segoe UI (TrueType)"      → "Segoe UI"
//   "Arial Bold (TrueType)"    → "Arial Bold"
//   "Consolas (TrueType)"      → "Consolas"
//   "Noto Sans CJK SC Regular (OpenType)" → "Noto Sans CJK SC Regular"
//
// 使用 golang.org/x/sys/windows/registry（已在 go.mod require 中），
// 避免 CGO 依赖。

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

// getSystemFontsForPlatform 读取 Windows 注册表字体键，返回字体族名称列表。
func getSystemFontsForPlatform() []string {
	const fontsKey = `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts`

	k, err := registry.OpenKey(registry.LOCAL_MACHINE, fontsKey, registry.READ)
	if err != nil {
		// 注册表无法访问时返回空列表，调用方会用内置字体兜底
		return nil
	}
	defer k.Close()

	// 读取该键下所有 value 的名称列表
	valueNames, err := k.ReadValueNames(-1)
	if err != nil {
		return nil
	}

	names := make([]string, 0, len(valueNames))
	for _, raw := range valueNames {
		name := extractFontFamily(raw)
		if name != "" {
			names = append(names, name)
		}
	}
	return names
}

// extractFontFamily 从注册表 value 名中提取字体族名称。
//
// Windows 注册表字体名格式为 "<FontName> (<Type>)"，其中 <Type> 通常为：
//
//	TrueType、OpenType、Type 1、Raster、Vector
//
// 本函数去掉尾部括号及其内容，返回纯字体名。
// 示例：
//
//	"Segoe UI (TrueType)"  → "Segoe UI"
//	"Arial"                → "Arial"（无括号时原样返回）
func extractFontFamily(raw string) string {
	// 找最后一个 " (" 的位置，截断括注部分
	if idx := strings.LastIndex(raw, " ("); idx > 0 {
		// 确认末尾确实是闭括号，避免误截名字中含 "(" 的字体
		if strings.HasSuffix(strings.TrimSpace(raw[idx:]), ")") {
			return strings.TrimSpace(raw[:idx])
		}
	}
	return strings.TrimSpace(raw)
}
