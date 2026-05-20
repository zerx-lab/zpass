// setup-wails —— 给 Wails 3 alpha 78 打 KDE 标题栏补丁的一次性工具。
//
// ---------------------------------------------------------------------------
// 为什么要打这个补丁？
//
// 主窗口在 main.go 里以 `Frameless: true` 创建，目的是让前端的自定义
// <Titlebar /> 接管整条窗口顶栏。Wails 3 alpha 78 对 Linux 的实现是单纯调
// `gtk_window_set_decorated(FALSE)`：
//
//	pkg/application/linux_cgo.go:1587
//	    func (w *linuxWebviewWindow) setFrameless(frameless bool) {
//	        C.gtk_window_set_decorated(w.gtkWindow(), gtkBool(!frameless))
//	    }
//
// 这个调用在 Mutter / Xfwm / Cinnamon / KWin-on-X11 上都会让 WM 不画任何
// 装饰。但 **KWin Wayland 例外** —— 由于 GTK 没有显式通过 xdg-decoration
// 协议告诉合成器 "我自己画标题栏 (client_side)"，KWin 默认仍然给窗口贴一
// 条 server-side decoration (SSD)。结果就是用户在 KDE Wayland 下同时看到
// 自定义 <Titlebar /> 和系统标题栏，重影。
//
// 解决方案是在 `setFrameless(true)` 里追加一步 `gtk_window_set_titlebar`
// 装一个空的 GtkBox 作为标题栏控件。这一步会翻转 GTK 内部的
// `client_decorated` 标志，让 GTK 主动通过 xdg-decoration 请求 CSD，KWin
// 收到请求后就会让出标题栏。重要前置条件：必须在 widget realize 之前调，
// 上游 setFrameless 是在 run() 的窗口配置阶段被调用、晚于 windowShow 里
// 的 realize，所以时序是安全的。
//
// ---------------------------------------------------------------------------
// 为什么不直接 fork Wails / 提 upstream PR？
//
//   - 上游 alpha 78 已经发布，社区另开了 alpha 92+，等修复合并 + 我们升级
//     的窗口太长，KDE 用户现在就受影响。
//   - patch 体量很小（约 20 行注释 + 2 行代码），未来升级 Wails 版本时只
//     需把版本号在 wailsVersion 常量里改一下，重跑本工具即可。
//   - 用 go.work 而不是 go.mod 的 replace 指令，**不污染主模块**，
//     macOS / Windows 开发者甚至不必跑这个 setup 步骤。
//
// ---------------------------------------------------------------------------
// 行为
//
//  1. 校验 desktop/go.mod 里依赖的 Wails 版本与本工具常量一致（防止有人
//     升级了 go.mod 但忘记重跑 setup）。
//  2. `go mod download` 把 Wails 源码拉到 module cache。
//  3. 把 cache 副本拷贝到 desktop/third_party/wails-v3/，递归设为可写。
//  4. 对 pkg/application/linux_cgo.go 做精确字符串替换 —— 找到原始
//     setFrameless 函数体，整体替换为 KDE-friendly 版本。找不到原始
//     片段就报错退出（说明上游变了，需要重新写 patch）。
//  5. 生成 desktop/go.work，里面只有一条 replace 指令指向本地副本。
//  6. 写入 .zpass-patched 标记文件，下次再跑就 idempotent 跳过。
//
// 跑法：
//
//	cd desktop
//	go run ./scripts/setup-wails           # 增量
//	go run ./scripts/setup-wails -force    # 强制重做
//
// 通常通过 Taskfile 间接调用：
//
//	task setup:wails
package main

import (
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const (
	// wailsModule / wailsVersion —— 必须与 desktop/go.mod 中实际依赖的
	// Wails 版本完全一致。升级 Wails 时同步改这里 + 重跑 setup。
	wailsModule  = "github.com/wailsapp/wails/v3"
	wailsVersion = "v3.0.0-alpha.78"

	// patchTargetRel —— 我们要打补丁的文件相对于 Wails 模块根的路径。
	patchTargetRel = "pkg/application/linux_cgo.go"

	// patchMarker —— 写入到 third_party/wails-v3/ 内表示已成功打补丁。
	// 删掉这个文件即可强制重新 setup。
	patchMarker = ".zpass-patched"
)

func main() {
	var force bool
	flag.BoolVar(&force, "force", false, "强制重做：先清空 third_party/wails-v3/ 再重新拉源+打补丁")
	flag.Parse()

	// 本工具调的所有 `go ...` 子进程都不能读 desktop/go.work —— 原因：
	//   1. 首次 setup 时 go.work 还不存在，不受影响；
	//   2. 但重跑 setup（比如升级并加 -force）时可能遇到一个旧 go.work，
	//      里面 go 版本 < desktop/go.mod 要求；Go 工具链会拒绝调起 setup
	//      本身。强制 GOWORK=off 让本进程及子进程统一去 workspace化，
	//      避免这个 bootstrap 陧阱。本工具本身不依赖 workspace。
	if err := os.Setenv("GOWORK", "off"); err != nil {
		log.Fatalf("[setup-wails] 关闭 GOWORK 失败: %v", err)
	}

	desktopDir, err := findDesktopRoot()
	if err != nil {
		log.Fatalf("[setup-wails] %v", err)
	}

	thirdPartyDir := filepath.Join(desktopDir, "third_party")
	target := filepath.Join(thirdPartyDir, "wails-v3")
	marker := filepath.Join(target, patchMarker)
	goWork := filepath.Join(desktopDir, "go.work")

	// idempotent 短路：marker + go.work 都在就跳过。-force 跳过这步。
	if !force {
		if _, err := os.Stat(marker); err == nil {
			if _, err := os.Stat(goWork); err == nil {
				fmt.Printf("[setup-wails] 已就绪，跳过（rm %s 或 -force 可重做）\n", marker)
				return
			}
		}
	}

	// 1) 读主模块 go.mod：校验 Wails 版本一致 + 拿出 Go 版本（入 go.work 用）
	goModPath := filepath.Join(desktopDir, "go.mod")
	if err := verifyGoModVersion(goModPath); err != nil {
		log.Fatalf("[setup-wails] %v", err)
	}
	goVersion, err := readGoDirectiveVersion(goModPath)
	if err != nil {
		log.Fatalf("[setup-wails] %v", err)
	}

	// 2) 拉源
	fmt.Printf("[setup-wails] go mod download %s@%s\n", wailsModule, wailsVersion)
	if err := runIn(desktopDir, "go", "mod", "download", wailsModule+"@"+wailsVersion); err != nil {
		log.Fatalf("[setup-wails] go mod download 失败: %v", err)
	}

	// 3) 拷贝 module cache → third_party/wails-v3/
	gomodcache, err := goEnv("GOMODCACHE")
	if err != nil {
		log.Fatalf("[setup-wails] %v", err)
	}
	src := filepath.Join(gomodcache, "github.com", "wailsapp", "wails", "v3@"+wailsVersion)
	if _, err := os.Stat(src); err != nil {
		log.Fatalf("[setup-wails] 找不到 module cache: %s (%v)", src, err)
	}

	fmt.Printf("[setup-wails] 拷贝 %s → %s\n", src, target)
	if err := os.RemoveAll(target); err != nil {
		log.Fatalf("[setup-wails] 清空 %s: %v", target, err)
	}
	if err := copyTree(src, target); err != nil {
		log.Fatalf("[setup-wails] 拷贝失败: %v", err)
	}
	// module cache 默认 0o444 / 0o555，必须递归改成可写否则 patch 写不进去。
	if err := chmodWritable(target); err != nil {
		log.Fatalf("[setup-wails] chmod: %v", err)
	}

	// 4) 打补丁
	patchFile := filepath.Join(target, patchTargetRel)
	if err := applyKDEFramelessPatch(patchFile); err != nil {
		log.Fatalf("[setup-wails] 打补丁失败: %v", err)
	}
	fmt.Printf("[setup-wails] 补丁已应用: %s\n", patchTargetRel)

	// 5) 生成 go.work，里面的 go 指令重用从 go.mod 读出的版本，避免
	// Go 工具链以 "workspace 版本 < 模块要求版本" 为由拒绝构建。
	if err := writeGoWork(goWork, goVersion); err != nil {
		log.Fatalf("[setup-wails] 写 go.work: %v", err)
	}
	fmt.Printf("[setup-wails] 已生成 %s（go %s）\n", goWork, goVersion)

	// 6) 标记
	stamp := fmt.Sprintf(
		"Wails %s + KDE-frameless patch\nplatform=%s/%s\nat=%s\n",
		wailsVersion, runtime.GOOS, runtime.GOARCH, time.Now().Format(time.RFC3339),
	)
	if err := os.WriteFile(marker, []byte(stamp), 0o644); err != nil {
		log.Fatalf("[setup-wails] 写 marker: %v", err)
	}

	fmt.Println("[setup-wails] 完成 ✔")
}

// findDesktopRoot —— 从当前目录往上找，直到发现一个含 go.mod 的目录，并且
// 这个 go.mod 不是本工具自己的（即不在 scripts/setup-wails/ 里）。这样无论
// 用户在 desktop/ 还是 desktop/scripts/setup-wails/ 下跑 go run 都能定位。
func findDesktopRoot() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	dir := wd
	for {
		gomod := filepath.Join(dir, "go.mod")
		if data, err := os.ReadFile(gomod); err == nil {
			// 跳过工具自身的 go.mod
			if !strings.Contains(string(data), "scripts/setup-wails") {
				return dir, nil
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("从 %s 起向上找不到 desktop 的 go.mod", wd)
		}
		dir = parent
	}
}

// verifyGoModVersion —— 读 desktop/go.mod，确认它依赖的 Wails 版本与本工具
// 的 wailsVersion 完全一致。不一致就 fail-fast，避免静默打到错的版本上。
func verifyGoModVersion(goModPath string) error {
	data, err := os.ReadFile(goModPath)
	if err != nil {
		return fmt.Errorf("读 %s: %w", goModPath, err)
	}
	// 形如:  github.com/wailsapp/wails/v3 v3.0.0-alpha.78
	re := regexp.MustCompile(`(?m)^\s*github\.com/wailsapp/wails/v3\s+(v\S+)`)
	m := re.FindStringSubmatch(string(data))
	if len(m) < 2 {
		return fmt.Errorf("%s 里找不到 github.com/wailsapp/wails/v3 依赖行", goModPath)
	}
	if m[1] != wailsVersion {
		return fmt.Errorf(
			"go.mod 里 Wails 版本是 %s 但 setup-wails 期望 %s —— "+
				"升级 Wails 时请同步改 scripts/setup-wails/main.go 的 wailsVersion 常量",
			m[1], wailsVersion,
		)
	}
	return nil
}

// runIn —— 在指定目录执行命令，stdout/stderr 直通父进程，失败返回非 nil。
func runIn(dir string, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// goEnv —— 调 `go env <KEY>` 并返回 trim 后的值。
func goEnv(key string) (string, error) {
	out, err := exec.Command("go", "env", key).Output()
	if err != nil {
		return "", fmt.Errorf("go env %s: %w", key, err)
	}
	return strings.TrimSpace(string(out)), nil
}

// copyTree —— 把 src 整棵目录树递归拷贝到 dst。保留相对路径结构，但不
// 保留权限（module cache 全部是只读，我们要的就是把它复活成可写副本）。
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		out := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(out, 0o755)
		}
		return copyFile(path, out)
	})
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return nil
}

// chmodWritable —— 递归把目录设为 0o755、文件设为 0o644，保证 patch 能写。
func chmodWritable(root string) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		if d.IsDir() {
			mode = 0o755
		}
		return os.Chmod(path, mode)
	})
}

// applyKDEFramelessPatch —— 把 linux_cgo.go 里原始的 setFrameless 实现整段
// 替换为 KDE-friendly 版本（追加一段 gtk_window_set_titlebar 强制 CSD）。
//
// 用精确字符串替换而非 patch(1) / diff hunk 的原因：
//
//   - patch(1) 在 Windows 默认 shell 里不一定有，本工具又是跨平台 Go；
//   - setFrameless 是个独立完整的函数，前后没有歧义，整段替换比按行
//     diff 更稳健；
//   - 上游一旦改动这块（比如下次 Wails 升级把签名换了），我们的 want
//     字符串就匹配不上，直接报错，让维护者意识到需要更新本工具，而不是
//     悄悄打到错位置上。
//
// 重要：want / replacement 必须 100% 用制表符（\t）与上游文件保持一致，
// 否则字符串比较会失败。
func applyKDEFramelessPatch(file string) error {
	const want = "func (w *linuxWebviewWindow) setFrameless(frameless bool) {\n" +
		"\tC.gtk_window_set_decorated(w.gtkWindow(), gtkBool(!frameless))\n" +
		"\t// TODO: Deal with transparency for the titlebar if possible when !frameless\n" +
		"\t//       Perhaps we just make it undecorated and add a menu bar inside?\n" +
		"}"

	const replacement = "func (w *linuxWebviewWindow) setFrameless(frameless bool) {\n" +
		"\tC.gtk_window_set_decorated(w.gtkWindow(), gtkBool(!frameless))\n" +
		"\tif frameless {\n" +
		"\t\t// ZPass downstream patch (KDE Plasma compatibility):\n" +
		"\t\t//\n" +
		"\t\t// gtk_window_set_decorated(FALSE) alone is honoured by Mutter,\n" +
		"\t\t// Xfwm, Cinnamon and KWin-on-X11, but KWin under Wayland still\n" +
		"\t\t// draws a server-side decoration titlebar because GTK never\n" +
		"\t\t// explicitly requests client_side mode via the xdg-decoration\n" +
		"\t\t// protocol.\n" +
		"\t\t//\n" +
		"\t\t// Setting a custom titlebar widget -- even an empty one --\n" +
		"\t\t// flips GTK's internal client_decorated flag and makes it\n" +
		"\t\t// actively negotiate CSD with the compositor. KWin then\n" +
		"\t\t// refuses to attach its SSD bar.\n" +
		"\t\t//\n" +
		"\t\t// Must run before gtk_widget_realize(). setFrameless is\n" +
		"\t\t// invoked from the window setup path (run()) before the\n" +
		"\t\t// eventual windowShow(), so ordering is safe.\n" +
		"\t\tempty := C.gtk_box_new(C.GTK_ORIENTATION_HORIZONTAL, 0)\n" +
		"\t\tC.gtk_window_set_titlebar(w.gtkWindow(), empty)\n" +
		"\t}\n" +
		"\t// TODO: Deal with transparency for the titlebar if possible when !frameless\n" +
		"\t//       Perhaps we just make it undecorated and add a menu bar inside?\n" +
		"}"

	data, err := os.ReadFile(file)
	if err != nil {
		return fmt.Errorf("读 %s: %w", file, err)
	}
	src := string(data)

	// 已经打过补丁就视为幂等成功
	if strings.Contains(src, "ZPass downstream patch") {
		return nil
	}

	if !strings.Contains(src, want) {
		return fmt.Errorf(
			"%s 里找不到原始的 setFrameless 函数体 —— Wails 上游可能改了实现，"+
				"需要更新 scripts/setup-wails/main.go 里的 want 常量",
			file,
		)
	}

	out := strings.Replace(src, want, replacement, 1)
	return os.WriteFile(file, []byte(out), 0o644)
}

// readGoDirectiveVersion —— 从 desktop/go.mod 里拿出顶层 `go X.Y[.Z]` 指令的
// 版本字符串（如 "1.25.0"）。返回给 writeGoWork 用，避免硬编码。
//
// 如果 go.mod 不包含 go 指令（不可能，模块创建时必填）则报错。
func readGoDirectiveVersion(goModPath string) (string, error) {
	data, err := os.ReadFile(goModPath)
	if err != nil {
		return "", fmt.Errorf("读 %s: %w", goModPath, err)
	}
	// 匹配诸如 "go 1.25" / "go 1.25.0" / "go 1.25rc1"
	re := regexp.MustCompile(`(?m)^\s*go\s+(\S+)\s*$`)
	m := re.FindStringSubmatch(string(data))
	if len(m) < 2 {
		return "", fmt.Errorf("%s 里找不到 'go' 指令", goModPath)
	}
	return m[1], nil
}

// writeGoWork —— 生成 desktop/go.work，里面只有一条 replace 指令。
//
// goVersion 参数从 desktop/go.mod 的 `go` 指令复制过来：Go 工具链要求
// workspace 的 `go X.Y[.Z]` 不得低于任何被纳入的模块。动态读出避免
// "改了 desktop/go.mod 但忘了同步 go.work" 的下一代问题。
//
// 为什么用 go.work 而不是 go.mod 的 replace？
//   - go.work 默认不进 git（已加到 desktop/.gitignore），这样改动只影响
//     真正跑过 setup 的开发机（典型 = Linux 用户）。
//   - macOS/Windows 开发者拿到代码不必跑 setup（他们的平台与 KDE 问题无
//     关），go.mod 仍然是 pristine 的官方 Wails。
//   - 升级 Wails 版本时，旧的 go.work 还能继续用本地副本，直到主动重跑
//     setup，避免 wails3 升级与代码改动耦合。
func writeGoWork(path, goVersion string) error {
	content := fmt.Sprintf(`// ============================================================
// 自动生成 —— 由 desktop/scripts/setup-wails/main.go 产出。
// 不要手工编辑；删除本文件并重跑 task setup:wails 即可重新生成。
//
// 这个 workspace 的存在意义只有一个：把 wails/v3 的导入重定向到
// desktop/third_party/wails-v3/ 里我们打过 KDE 标题栏补丁的本地副本。
// 详情见 third_party/README.md。
// ============================================================
//
// 下面的 go 版本是 setup-wails 从 desktop/go.mod 复制过来的 ——
// Go 要求 workspace 声明的 go 版本 >= 任何 use 进来的模块。
go %s

use .

replace github.com/wailsapp/wails/v3 => ./third_party/wails-v3
`, goVersion)
	return os.WriteFile(path, []byte(content), 0o644)
}
