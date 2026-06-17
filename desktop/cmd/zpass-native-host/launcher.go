// nativehost 拉起 Desktop GUI 的逻辑（公共部分）
//
// ---------------------------------------------------------------------------
// 与 cmd/zpass-agent/launcher.go 同模式：定位 binary + 冷却 + 平台 spawn。
//
// 不直接复用 zpass-agent 包，因为：
//   - zpass-agent 是独立 module 入口（main package），nativehost 也是独立
//     build tag 下的 main package，两边不能互相 import
//   - 抽取成共享包会牵涉到 GUI binary 命名（产品策略）跨包共识，目前阶段
//     保持「两边各一份相同代码」更稳定

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// 两次 spawn 之间的冷却窗口
//
// 防御：GUI binary 损坏 / 启动后立刻崩溃时，扩展高频请求会触发循环 spawn，
// 消耗资源 + 日志泛滥。冷却期内的 spawn 请求直接返回错误。
const guiLaunchCooldown = 30 * time.Second

var (
	guiLauncherMu      sync.Mutex
	guiLauncherLastTry time.Time
	guiLauncherBin     string
	guiLauncherFlight  atomic.Bool
)

// ensureGUIRunning 尝试拉起 Desktop GUI（不阻塞、幂等）
//
// 返回 nil 表示「已触发 spawn / 上次刚 spawn 过」，调用方应当随后用
// waitForBridge 轮询 bridge 上线。
//
// 返回 error 表示「这次明确无法 spawn」（找不到 binary / 冷却期 / exec
// 失败）。
func ensureGUIRunning() error {
	// 已经有 spawn 在进行中 —— 让调用方继续等
	if guiLauncherFlight.Load() {
		return nil
	}

	guiLauncherMu.Lock()
	now := time.Now()
	if !guiLauncherLastTry.IsZero() && now.Sub(guiLauncherLastTry) < guiLaunchCooldown {
		guiLauncherMu.Unlock()
		return fmt.Errorf("GUI launch cooldown active")
	}

	bin := guiLauncherBin
	if bin == "" {
		located, err := locateGUIBinaryForNativeHost()
		if err != nil {
			guiLauncherMu.Unlock()
			return fmt.Errorf("locate GUI binary: %w", err)
		}
		bin = located
		guiLauncherBin = bin
	}
	guiLauncherLastTry = now
	guiLauncherMu.Unlock()

	if !guiLauncherFlight.CompareAndSwap(false, true) {
		return nil
	}

	go func() {
		defer guiLauncherFlight.Store(false)
		if err := spawnGUIForNativeHost(bin); err != nil {
			log.Printf("nativehost: GUI spawn failed (binary=%s): %v", bin, err)
		} else {
			log.Printf("nativehost: GUI spawn initiated (binary=%s)", bin)
		}
	}()
	return nil
}

// locateGUIBinaryForNativeHost 寻找 Desktop GUI 可执行文件
//
// 优先级：
//  1. 环境变量 ZPASS_GUI_BIN（开发 / 自定义安装）
//  2. 应用根下的 GUI 主程序（helper 在 resources/bin/<plat>/，GUI 在其上三层）
//
// 不查 $PATH —— GUI 通常装在 /Applications 或 Program Files，不入 PATH。
func locateGUIBinaryForNativeHost() (string, error) {
	if env := os.Getenv("ZPASS_GUI_BIN"); env != "" {
		if fileExistsNH(env) {
			return env, nil
		}
		return "", fmt.Errorf("ZPASS_GUI_BIN=%s not found", env)
	}

	selfBin, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("os.Executable: %w", err)
	}
	dir := filepath.Dir(selfBin)

	candidates := guiBinaryCandidatesForNativeHost(dir)
	for _, c := range candidates {
		if fileExistsNH(c) {
			return c, nil
		}
	}

	return "", fmt.Errorf("ZPass GUI binary not found in %s (tried %v)", dir, candidates)
}

// guiBinaryCandidatesForNativeHost 各平台 GUI binary 候选路径
//
// 与 zpass-agent/launcher.go::guiBinaryCandidates 保持一致。
func guiBinaryCandidatesForNativeHost(dir string) []string {
	return guiBinaryCandidatesForOS(runtime.GOOS, dir)
}

// guiBinaryCandidatesForOS 列出指定 GOOS 下要探测的 GUI 可执行文件路径，
// 相对 helper 二进制自身所在目录 dir 解析。
//
// 打包布局（Electron Forge / electron-builder）：每个 Go helper —— 本
// nativehost、zpass-agent、Go sidecar —— 都随包落在
//
//	<root>/resources/bin/<platform>-<arch>/
//	(macOS: <App>.app/Contents/Resources/bin/<platform>-<arch>/)
//
// 即 GUI 主程序所在的「应用根」下三层。Forge 把 executableName 钉死为
// "zpass"（见 forge.config.ts），所以主程序是 zpass / zpass.exe，而**不是**
// 历史 Wails 产物名 "ZPassDesktop"。旧代码在 helper 同目录找 ZPassDesktop，
// 在 Electron 布局下三平台全部命中不到 → 扩展永远「无法启动 Desktop」。
func guiBinaryCandidatesForOS(goos, dir string) []string {
	// 应用根：从 <root>/resources/bin/<platform>-<arch>/ 向上三层。
	// macOS 下解析到 <App>.app/Contents。
	root := filepath.Join(dir, "..", "..", "..")
	switch goos {
	case "linux":
		return []string{
			filepath.Join(root, "zpass"),
			// 容错：万一某 maker 用了大写产品名。
			filepath.Join(root, "ZPass"),
		}
	case "darwin":
		return []string{
			// 内层 Mach-O（<App>.app/Contents/MacOS/zpass）。探测文件而非
			// bundle 目录，命中精确；spawn 再反推外层 .app 用 open -a。
			filepath.Join(root, "MacOS", "zpass"),
			// 系统安装位置兜底。
			"/Applications/ZPass.app",
			"/Applications/zpass.app",
		}
	case "windows":
		return []string{
			filepath.Join(root, "zpass.exe"),
			// 容错：历史/大写命名。
			filepath.Join(root, "ZPass.exe"),
		}
	}
	return nil
}

// fileExistsNH 与 supervisor / launcher 同语义
//
// macOS .app 是目录；其它平台都是常规文件。
func fileExistsNH(path string) bool {
	st, err := os.Stat(path)
	if err != nil {
		return false
	}
	return st.Mode().IsRegular() || st.IsDir()
}

// spawnGUIForNativeHost 平台分文件实现 —— 见 nativehost_launcher_{linux,darwin,windows}.go
//
// 实现要求：
//   - 不阻塞，启动即返回
//   - detach，nativehost 退出不影响 GUI
//   - 失败返 error，由调用方走冷却 + 重试
var _ = spawnGUIForNativeHost
