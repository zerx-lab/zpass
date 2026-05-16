//go:build linux

// Peer 解析 —— Linux 实现（SO_PEERCRED）
//
// ---------------------------------------------------------------------------
// 在 Linux 上从 unix socket conn 拿到对端进程信息
//
// 主要 syscall：
//   - getsockopt(SOL_SOCKET, SO_PEERCRED) → struct ucred {pid, uid, gid}
//   - 读 /proc/<pid>/exe symlink 拿可执行文件绝对路径
//   - 读 exe 文件内容计算 SHA256（仅在必要时；exe 可能几十 MB）
//
// 注意 PID race：
//   - 拿到 PID 后，对端进程可能已经退出，PID 已被复用给别的进程
//   - 检测方法：读 /proc/<pid>/exe 后再读一次 stat，如果 inode 变了就
//     说明被复用。但实际上 race window 极小（拿 PID → 读 exe 不到 1ms），
//     在 GUI 端用 exe SHA256 cache 防御复用更彻底，本端按 best-effort 处理
//
// SHA256 计算策略：
//   - exe 文件大小 < 50 MiB 时计算
//   - >= 50 MiB 时返回空字符串（GUI 端 fallback 用 exe 路径作为 cache key）
//   - 单次签名比较少见 >50MB 的客户端（ssh / git 远小于此），阈值实际很少触发

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"

	"golang.org/x/sys/unix"
)

// peerExeHashMaxBytes 计算 SHA256 的 exe 文件大小上限
//
// 超过此大小返回空 hash，避免每次签名读几十 MB 拖慢响应。
// 50 MiB 涵盖了绝大多数 ssh / git / IDE 客户端 binary。
const peerExeHashMaxBytes = 50 * 1024 * 1024

// resolvePeerFromConn 从 *net.UnixConn 提取对端进程信息
//
// 调用方传入的 conn 应当是 *net.UnixConn（unix socket accept 出来的）。
// 类型断言失败时返回零值 peerInfo —— 不视为致命错误，agent 仍能签名，
// 只是 GUI 弹窗显示「未知进程」。
func resolvePeerFromConn(conn net.Conn) (peerInfo, error) {
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		return peerInfo{}, fmt.Errorf("conn is not *net.UnixConn (got %T)", conn)
	}

	// 拿到底层 raw fd，调 getsockopt
	raw, err := unixConn.SyscallConn()
	if err != nil {
		return peerInfo{}, fmt.Errorf("get syscall conn: %w", err)
	}

	var ucred *unix.Ucred
	var getsockErr error
	if err := raw.Control(func(fd uintptr) {
		ucred, getsockErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return peerInfo{}, fmt.Errorf("raw control: %w", err)
	}
	if getsockErr != nil {
		return peerInfo{}, fmt.Errorf("SO_PEERCRED: %w", getsockErr)
	}
	if ucred == nil {
		return peerInfo{}, fmt.Errorf("SO_PEERCRED returned nil ucred")
	}

	pid := ucred.Pid
	exe, _ := readExePath(int(pid)) // 失败不致命，留空字符串
	exeHash := ""
	if exe != "" {
		exeHash, _ = computeExeSHA256(exe)
	}

	return peerInfo{
		PID:     pid,
		Exe:     exe,
		ExeHash: exeHash,
	}, nil
}

// readExePath 读取 /proc/<pid>/exe symlink 的目标
//
// /proc/<pid>/exe 是 Linux 内核维护的 symlink，指向进程当前正在运行的
// binary 路径。即使进程通过 fexecve / unlinked binary 启动，readlink 也能
// 拿到一个合理表示（如 "/path/to/foo (deleted)"）。
//
// 失败原因：
//   - 进程已退出（/proc/<pid> 不存在）
//   - 权限不足（极少见，需要同 uid 或 CAP_SYS_PTRACE；同 uid 下不会失败）
func readExePath(pid int) (string, error) {
	if pid <= 0 {
		return "", fmt.Errorf("invalid pid %d", pid)
	}
	exePath, err := os.Readlink("/proc/" + strconv.Itoa(pid) + "/exe")
	if err != nil {
		return "", fmt.Errorf("readlink /proc/%d/exe: %w", pid, err)
	}
	return exePath, nil
}

// computeExeSHA256 读 exe 文件并计算 SHA256
//
// 限制：
//   - 文件 stat 失败 → 返回错误
//   - 文件大小 > peerExeHashMaxBytes → 返回空 + nil error（不视为失败，
//     GUI 端会自行 fallback 到用 exe 路径作为 cache key）
//
// 性能：io.Copy 用默认 32KB 缓冲，对 10MB binary 约 50ms。
func computeExeSHA256(exePath string) (string, error) {
	st, err := os.Stat(exePath)
	if err != nil {
		return "", fmt.Errorf("stat exe %s: %w", exePath, err)
	}
	if st.Size() > peerExeHashMaxBytes {
		return "", nil // 超过阈值，跳过哈希
	}

	f, err := os.Open(exePath)
	if err != nil {
		return "", fmt.Errorf("open exe %s: %w", exePath, err)
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("read exe %s: %w", exePath, err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
