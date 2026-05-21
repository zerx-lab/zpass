package services

// fonts_linux.go — Linux 平台字体列表实现
//
// 通过执行 `fc-list : family` 命令获取系统字体族名称列表。
//
// fc-list 输出格式示例（每行一个或多个逗号分隔的字体族名）：
//
//	DejaVu Sans
//	Liberation Mono,Liberation Mono Narrow
//	Noto Sans CJK SC,Noto Sans CJK,Noto Sans CJK SC,Noto Sans CJK TC
//
// 本实现对每行按逗号拆分，取第一个字体族名，去首尾空格后收入列表。
// 若 fc-list 命令不存在或执行失败，返回空列表（内置字体仍会兜底）。

import (
	"os/exec"
	"strings"
)

// getSystemFontsForPlatform 执行 fc-list 获取 Linux 系统字体族名称列表。
func getSystemFontsForPlatform() []string {
	// fc-list : family 只输出字体族名，不输出文件路径，每行格式为：
	//   "FamilyName1,FamilyName2,..."
	out, err := exec.Command("fc-list", ":", "family").Output()
	if err != nil {
		// fc-list 不可用（如精简镜像未安装 fontconfig），返回空列表
		return nil
	}

	lines := strings.Split(string(out), "\n")
	names := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// 每行可能包含多个以逗号分隔的别名，取第一个作为主字体族名
		parts := strings.SplitN(line, ",", 2)
		name := strings.TrimSpace(parts[0])
		if name != "" {
			names = append(names, name)
		}
	}
	return names
}
