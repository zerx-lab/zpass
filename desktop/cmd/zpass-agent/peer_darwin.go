//go:build darwin

// Peer 解析 —— macOS 实现（LOCAL_PEERPID + proc_pidpath）
//
// ---------------------------------------------------------------------------
// macOS 没有 Linux 的 SO_PEERCRED，而是用：
//   - getsockopt(SOL_LOCAL, LOCAL_PEERPID) 拿对端 PID
//   - libproc 的 proc_pidpath(pid, ...) 拿可执行文件路径
//
// LOCAL_PEERPID 是 BSD 风格的 sockopt，值 = 2 (即 LOCAL_PEERPID 常量)
// 在 sys/un.h 中定义。Go 标准库的 unix.SOL_LOCAL / unix.LOCAL_PEERPID
// 已经导出这两个常量。
//
// proc_pidpath 需要通过 cgo 调用（libproc 是系统库），但 golang.org/x/sys/unix
// 没直接封装。这里有两条路：
//   1. cgo 调 libproc.proc_pidpath
//   2. exec ps 命令解析
//
// 选 1：cgo 已经是 Wails 项目依赖，多用一处不增加负担；exec ps 在沙盒环境
// 可能被禁用，不可靠。
//
// 但 cgo 的代价是「单元测试 cross-compile 复杂」—— 我们让 cgo 调用包在
// build tag = darwin 文件里，Linux/Windows 编译不会触碰。

package main

/*
#include <stdlib.h>
#include <libproc.h>
*/
import "C"

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"unsafe"

	"golang.org/x/sys/unix"
)

// peerExeHashMaxBytes 计算 SHA256 的 exe 文件大小上限（同 linux 实现）
const peerExeHashMaxBytes = 50 * 1024 * 1024

// resolvePeerFromConn 从 *net.UnixConn 提取对端进程信息
//
// macOS 实现：getsockopt LOCAL_PEERPID + proc_pidpath
func resolvePeerFromConn(conn net.Conn) (peerInfo, error) {
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		return peerInfo{}, fmt.Errorf("conn is not *net.UnixConn (got %T)", conn)
	}

	raw, err := unixConn.SyscallConn()
	if err != nil {
		return peerInfo{}, fmt.Errorf("get syscall conn: %w", err)
	}

	var pid int
	var sockErr error
	if err := raw.Control(func(fd uintptr) {
		pid, sockErr = unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERPID)
	}); err != nil {
		return peerInfo{}, fmt.Errorf("raw control: %w", err)
	}
	if sockErr != nil {
		return peerInfo{}, fmt.Errorf("LOCAL_PEERPID: %w", sockErr)
	}
	if pid <= 0 {
		return peerInfo{}, fmt.Errorf("LOCAL_PEERPID returned invalid pid %d", pid)
	}

	exe, _ := procPidPath(pid)
	exeHash := ""
	if exe != "" {
		exeHash, _ = computeExeSHA256(exe)
	}

	return peerInfo{
		PID:     int32(pid),
		Exe:     exe,
		ExeHash: exeHash,
	}, nil
}

// procPidPath 调用 libproc 的 proc_pidpath 拿 pid 对应的 binary 路径
//
// libproc 在 macOS 上是 SDK 默认链接的库（属于 libsystem.dylib 的一部分），
// 不需要 -lproc 链接参数 —— cgo 自动处理。
//
// PROC_PIDPATHINFO_MAXSIZE = 4 * PATH_MAX = 4096，足够任何合法路径。
//
// 返回值约定：
//   - 成功：path 字符串
//   - 进程已退出 / 不可访问：error
func procPidPath(pid int) (string, error) {
	// PROC_PIDPATHINFO_MAXSIZE = 4096 (Apple 头文件定义)
	const bufSize = 4096
	buf := make([]byte, bufSize)
	bufPtr := unsafe.Pointer(&buf[0])

	// proc_pidpath 返回写入的字节数，失败返回 0 并设 errno
	n := C.proc_pidpath(
		C.int(pid),
		bufPtr,
		C.uint(bufSize),
	)
	if n <= 0 {
		return "", fmt.Errorf("proc_pidpath(%d) failed", pid)
	}
	return string(buf[:n]), nil
}

// computeExeSHA256 同 linux 实现 —— 这里独立一份避免跨 build tag 共享
//
// 不抽公共文件的理由：linux / darwin / windows 三平台的 io 行为差异
// 微妙（symlink follow / fadvise / 文件锁），各自一份让平台特化能力可
// 独立演进。当前实现完全一致，但耦合不值得。
func computeExeSHA256(exePath string) (string, error) {
	st, err := os.Stat(exePath)
	if err != nil {
		return "", fmt.Errorf("stat exe %s: %w", exePath, err)
	}
	if st.Size() > peerExeHashMaxBytes {
		return "", nil
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
