//go:build windows

package services

import (
	"strings"
	"testing"
)

func TestRenderScheduledTaskXMLIncludesRestartPolicy(t *testing.T) {
	const (
		binary = `C:\Program Files\ZPass\zpass-agent.exe`
		userID = `S-1-5-21-111-222-333-1001`
	)

	taskXML := renderScheduledTaskXML(binary, userID)
	for _, want := range []string{
		"<LogonTrigger>",
		"<LogonType>InteractiveToken</LogonType>",
		"<RunLevel>LeastPrivilege</RunLevel>",
		"<Hidden>true</Hidden>",
		"<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
		"<RestartOnFailure>",
		"<Interval>PT1M</Interval>",
		"<Count>999</Count>",
		"<Command>C:\\Program Files\\ZPass\\zpass-agent.exe</Command>",
	} {
		if !strings.Contains(taskXML, want) {
			t.Fatalf("rendered task XML missing %q:\n%s", want, taskXML)
		}
	}

	info, err := parseScheduledTaskXML(taskXML)
	if err != nil {
		t.Fatalf("parse rendered task XML: %v", err)
	}
	if !info.Enabled {
		t.Fatalf("expected rendered task to be enabled")
	}
	if !scheduledTaskCommandMatches(info.Command, binary) {
		t.Fatalf("expected command %q to match %q", info.Command, binary)
	}
	if !scheduledTaskXMLMatchesPolicy(taskXML, info, binary) {
		t.Fatalf("expected rendered task XML to match required policy")
	}
}

func TestDecodeTaskXMLOutputUTF16LE(t *testing.T) {
	taskXML := renderScheduledTaskXML(
		`C:\Program Files\ZPass\zpass-agent.exe`,
		`S-1-5-21-111-222-333-1001`,
	)

	decoded := decodeTaskXMLOutput(utf16LEWithBOM(taskXML))
	if decoded != taskXML {
		t.Fatalf("UTF-16LE round trip mismatch")
	}
}

func TestScheduledTaskXMLMatchesPolicyRejectsLegacyTask(t *testing.T) {
	const binary = `C:\Program Files\ZPass\zpass-agent.exe`
	legacyXML := `<?xml version="1.0" encoding="UTF-16"?>
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Settings><Enabled>true</Enabled></Settings>
  <Actions><Exec><Command>C:\Program Files\ZPass\zpass-agent.exe</Command></Exec></Actions>
</Task>`

	info, err := parseScheduledTaskXML(legacyXML)
	if err != nil {
		t.Fatalf("parse legacy task XML: %v", err)
	}
	if scheduledTaskXMLMatchesPolicy(legacyXML, info, binary) {
		t.Fatalf("expected legacy task without hidden/restart policy to be rejected")
	}
}
