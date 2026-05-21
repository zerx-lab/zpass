//go:build windows

// Scheduled Task 安装 —— Windows 实现
//
// ---------------------------------------------------------------------------
// 实现要点
//
// 1. **使用 Scheduled Task 而非 Windows Service**：
//    - Service 跑在 SYSTEM/服务账户，跨 user session 复杂，无法弹 console
//    - Scheduled Task at logon 跑在当前用户上下文，与 GUI 同 session，
//      named pipe / 文件路径都自然可达
//
// 2. **schtasks.exe** 是 Windows 自带的命令行工具，从 Windows XP 起可用，
//    比调 ITaskScheduler COM 接口简单（COM 需要 cgo / 复杂错误处理）。
//
// 3. **任务命名**：`ZPass SSH Agent`（带空格的友好名字，与 GUI 设置页显示一致）
//
// 4. **触发器**：登录时（/sc onlogon），仅当前用户（/rl limited）
//
// 5. **进程隐藏**：Scheduled Task XML 设置 Hidden=true；如果任务启动失败
//    回落到 GUI supervisor，仍由 sshagentsupervisor_windows.go 的
//    SysProcAttr.HideWindow + CREATE_NO_WINDOW 避免弹 console。

package services

import (
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"
)

// scheduledTaskName 是注册到 Task Scheduler 的任务名
//
// 带空格的友好名字 —— 用户在控制面板 → 任务计划程序 看到「ZPass SSH
// Agent」比看到「zpass_agent_service」直观。
const scheduledTaskName = "ZPass SSH Agent"

const (
	scheduledTaskRestartInterval = "PT1M"
	scheduledTaskRestartCount    = 999
	scheduledTaskStartWait       = 3 * time.Second
)

// scheduledTaskInstaller 是 Windows 上的 systemServiceInstaller 实现
type scheduledTaskInstaller struct{}

// init 注入 Windows 实现
func init() {
	systemServiceInstallerImpl = &scheduledTaskInstaller{}
}

// Supported Windows 一律支持 —— schtasks.exe 是系统内置组件，从 XP 起可用
func (i *scheduledTaskInstaller) Supported() bool {
	return true
}

// PlatformLabel 给前端展示
func (i *scheduledTaskInstaller) PlatformLabel() string {
	return "Scheduled Task at login"
}

// Status 查询任务是否已注册且启用。
func (i *scheduledTaskInstaller) Status() (SystemServiceStatus, error) {
	taskXML, err := i.queryXML()
	installed := err == nil
	enabled := false
	if installed {
		info, parseErr := parseScheduledTaskXML(taskXML)
		if parseErr != nil {
			// 查询已成功但解析失败时保守显示为 enabled，避免 UI 误报未启用。
			enabled = true
		} else {
			enabled = info.Enabled
		}
	}

	return SystemServiceStatus{
		Supported:     true,
		Installed:     installed,
		Enabled:       enabled,
		PlatformLabel: i.PlatformLabel(),
	}, nil
}

// Install 注册并启动 Scheduled Task
//
// 流程：
//  1. 如果已存在且 binary 路径一致 → 保留任务，只确保当前 agent 在运行
//  2. 如果不存在 / 路径变化 / 被禁用 → 写 XML 并 schtasks /create
//  3. 当前没有 agent 时立即 schtasks /run，让 Task Scheduler 从本会话开始
//     接管进程。这样 agent 被杀后 RestartOnFailure 才会自动拉起。
//
// 失败：
//   - 权限不足（用户控制面板里禁用了 Task Scheduler）→ schtasks 报错
//   - binary 路径含空格 → XML Command 字段天然支持，不需要手动引号
func (i *scheduledTaskInstaller) Install(agentBinary string) error {
	if agentBinary == "" {
		return errors.New("empty agent binary path")
	}

	absBinary, err := filepath.Abs(agentBinary)
	if err == nil {
		agentBinary = absBinary
	}

	if taskXML, err := i.queryXML(); err == nil {
		if info, parseErr := parseScheduledTaskXML(taskXML); parseErr == nil &&
			scheduledTaskXMLMatchesPolicy(taskXML, info, agentBinary) {
			return i.runTaskIfAgentNotRunning()
		}
	}

	userID, err := currentScheduledTaskUserID()
	if err != nil {
		return err
	}

	// 删旧任务让 binary 路径变化、任务被禁用、旧命令行格式等情况都能修正。
	_ = i.deleteIfExists()

	taskXML := renderScheduledTaskXML(agentBinary, userID)
	tmp, err := os.CreateTemp("", "zpass-agent-task-*.xml")
	if err != nil {
		return fmt.Errorf("create task xml temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if _, err := tmp.Write(utf16LEWithBOM(taskXML)); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write task xml: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close task xml: %w", err)
	}

	cmd := exec.Command("schtasks", "/create", "/tn", scheduledTaskName, "/xml", tmpName, "/f")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("schtasks /create: %w (output: %s)", err, string(out))
	}

	return i.runTaskIfAgentNotRunning()
}

// Uninstall 删除任务
func (i *scheduledTaskInstaller) Uninstall() error {
	var errs []error
	if err := i.endIfRunning(); err != nil {
		errs = append(errs, err)
	}
	if err := i.deleteIfExists(); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

func (i *scheduledTaskInstaller) queryXML() (string, error) {
	cmd := exec.Command("schtasks", "/query", "/tn", scheduledTaskName, "/xml")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("schtasks /query /xml: %w (output: %s)", err, string(out))
	}
	return decodeTaskXMLOutput(out), nil
}

func (i *scheduledTaskInstaller) runTaskIfAgentNotRunning() error {
	if isAgentAlreadyRunning() {
		return nil
	}

	cmd := exec.Command("schtasks", "/run", "/tn", scheduledTaskName)
	out, err := cmd.CombinedOutput()
	if err != nil {
		outStr := string(out)
		if isBenignTaskAlreadyRunning(outStr) {
			return nil
		}
		return fmt.Errorf("schtasks /run: %w (output: %s)", err, outStr)
	}

	deadline := time.Now().Add(scheduledTaskStartWait)
	for time.Now().Before(deadline) {
		if isAgentAlreadyRunning() {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("scheduled task started but agent pipe was not ready after %s", scheduledTaskStartWait)
}

func (i *scheduledTaskInstaller) endIfRunning() error {
	cmd := exec.Command("schtasks", "/end", "/tn", scheduledTaskName)
	out, err := cmd.CombinedOutput()
	if err != nil {
		outStr := string(out)
		if isBenignTaskMissingOrStopped(outStr) {
			return nil
		}
		return fmt.Errorf("schtasks /end: %w (output: %s)", err, outStr)
	}
	return nil
}

// deleteIfExists 调 schtasks /delete /tn <名字> /f
//
// 任务不存在时 schtasks 返非零，我们当作 noop（幂等）。
func (i *scheduledTaskInstaller) deleteIfExists() error {
	cmd := exec.Command("schtasks", "/delete", "/tn", scheduledTaskName, "/f")
	out, err := cmd.CombinedOutput()
	if err != nil {
		// 区分「任务不存在」（exit code 1）和真错误
		outStr := string(out)
		if isBenignTaskMissing(outStr) {
			return nil // 幂等：不存在视为已卸载
		}
		return fmt.Errorf("schtasks /delete: %w (output: %s)", err, outStr)
	}
	return nil
}

type scheduledTaskXMLInfo struct {
	Enabled bool
	Command string
}

func parseScheduledTaskXML(taskXML string) (scheduledTaskXMLInfo, error) {
	taskXML = normalizeScheduledTaskXMLDeclaration(taskXML)
	var doc struct {
		Settings struct {
			Enabled string `xml:"Enabled"`
		} `xml:"Settings"`
		Actions struct {
			Exec struct {
				Command string `xml:"Command"`
			} `xml:"Exec"`
		} `xml:"Actions"`
	}
	if err := xml.Unmarshal([]byte(taskXML), &doc); err != nil {
		return scheduledTaskXMLInfo{}, err
	}

	enabledRaw := strings.TrimSpace(doc.Settings.Enabled)
	enabled := true
	if enabledRaw != "" {
		enabled = strings.EqualFold(enabledRaw, "true")
	}
	return scheduledTaskXMLInfo{
		Enabled: enabled,
		Command: strings.TrimSpace(doc.Actions.Exec.Command),
	}, nil
}

func normalizeScheduledTaskXMLDeclaration(taskXML string) string {
	replacer := strings.NewReplacer(
		`encoding="UTF-16"`, `encoding="UTF-8"`,
		`encoding='UTF-16'`, `encoding='UTF-8'`,
		`encoding="utf-16"`, `encoding="UTF-8"`,
		`encoding='utf-16'`, `encoding='UTF-8'`,
	)
	return replacer.Replace(taskXML)
}

func scheduledTaskCommandMatches(existing, expected string) bool {
	existing = strings.Trim(strings.TrimSpace(existing), `"`)
	expected = strings.Trim(strings.TrimSpace(expected), `"`)
	if existing == "" || expected == "" {
		return false
	}
	return strings.EqualFold(filepath.Clean(existing), filepath.Clean(expected))
}

func scheduledTaskXMLMatchesPolicy(taskXML string, info scheduledTaskXMLInfo, expectedCommand string) bool {
	if !info.Enabled || !scheduledTaskCommandMatches(info.Command, expectedCommand) {
		return false
	}

	normalized := strings.ToLower(normalizeScheduledTaskXMLDeclaration(taskXML))
	for _, required := range []string{
		"<logontrigger>",
		"<logontype>interactivetoken</logontype>",
		"<runlevel>leastprivilege</runlevel>",
		"<hidden>true</hidden>",
		"<allowstartondemand>true</allowstartondemand>",
		"<executiontimelimit>pt0s</executiontimelimit>",
		"<restartonfailure>",
		"<interval>" + strings.ToLower(scheduledTaskRestartInterval) + "</interval>",
		fmt.Sprintf("<count>%d</count>", scheduledTaskRestartCount),
	} {
		if !strings.Contains(normalized, required) {
			return false
		}
	}
	return true
}

func currentScheduledTaskUserID() (string, error) {
	u, err := user.Current()
	if err != nil {
		return "", fmt.Errorf("resolve current user for scheduled task: %w", err)
	}
	if u.Uid == "" {
		return "", errors.New("resolve current user for scheduled task: empty user SID")
	}
	return u.Uid, nil
}

func renderScheduledTaskXML(agentBinary, userID string) string {
	workingDir := filepath.Dir(agentBinary)
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>ZPass</Author>
    <Description>ZPass SSH agent for the current Windows user.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>%s</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>%s</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>%s</Interval>
      <Count>%d</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>%s</Command>
      <WorkingDirectory>%s</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`,
		xmlText(userID),
		xmlText(userID),
		scheduledTaskRestartInterval,
		scheduledTaskRestartCount,
		xmlText(agentBinary),
		xmlText(workingDir),
	)
}

func xmlText(s string) string {
	var buf bytes.Buffer
	_ = xml.EscapeText(&buf, []byte(s))
	return buf.String()
}

func utf16LEWithBOM(s string) []byte {
	encoded := utf16.Encode([]rune(s))
	out := make([]byte, 2+len(encoded)*2)
	out[0] = 0xff
	out[1] = 0xfe
	for i, v := range encoded {
		binary.LittleEndian.PutUint16(out[2+i*2:], v)
	}
	return out
}

func decodeTaskXMLOutput(out []byte) string {
	if len(out) >= 2 {
		switch {
		case out[0] == 0xff && out[1] == 0xfe:
			return decodeUTF16(out[2:], binary.LittleEndian)
		case out[0] == 0xfe && out[1] == 0xff:
			return decodeUTF16(out[2:], binary.BigEndian)
		}
	}

	probeLen := len(out)
	if probeLen > 200 {
		probeLen = 200
	}
	zeros := 0
	for _, b := range out[:probeLen] {
		if b == 0 {
			zeros++
		}
	}
	if probeLen > 0 && zeros > probeLen/4 {
		return decodeUTF16(out, binary.LittleEndian)
	}
	return string(out)
}

func decodeUTF16(out []byte, order binary.ByteOrder) string {
	if len(out)%2 == 1 {
		out = out[:len(out)-1]
	}
	u16 := make([]uint16, 0, len(out)/2)
	for i := 0; i < len(out); i += 2 {
		u16 = append(u16, order.Uint16(out[i:]))
	}
	return string(utf16.Decode(u16))
}

func isBenignTaskMissing(out string) bool {
	out = strings.ToLower(out)
	return strings.Contains(out, "cannot find") ||
		strings.Contains(out, "does not exist") ||
		strings.Contains(out, "找不到") ||
		strings.Contains(out, "不存在")
}

func isBenignTaskAlreadyRunning(out string) bool {
	out = strings.ToLower(out)
	return strings.Contains(out, "already running") ||
		strings.Contains(out, "正在运行") ||
		strings.Contains(out, "已在运行")
}

func isBenignTaskMissingOrStopped(out string) bool {
	out = strings.ToLower(out)
	return isBenignTaskMissing(out) ||
		strings.Contains(out, "not currently running") ||
		strings.Contains(out, "not running") ||
		strings.Contains(out, "当前未运行") ||
		strings.Contains(out, "未运行") ||
		strings.Contains(out, "没有运行")
}
