//go:build darwin

package secretstore

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"strings"
)

// macOS backend: shell out to the Keychain CLI (/usr/bin/security). This is the
// standard cgo-free approach (the same one zalando/go-keyring uses). The secret
// is passed via -w on the command line, which is briefly visible in the process
// argument list to ANY user on the machine via `ps` (process args are
// world-readable on macOS), not just the calling user — an accepted trade-off
// for avoiding a cgo link against the Security framework, but a real local
// exposure window. UNVERIFIED on the Linux dev box; needs a real-macOS
// regression run, and a future hardening pass should prefer a Security-framework
// path (e.g. SecItemAdd) if a cgo-free binding becomes available.
//
// security exit code 44 (errSecItemNotFound) is the "absent" signal used by
// find/delete.
const securityBin = "/usr/bin/security"

const secErrItemNotFound = 44

type darwinStore struct{ service string }

func newStore(service string) Store {
	if _, err := os.Stat(securityBin); err != nil {
		return unavailableStore{reason: "no /usr/bin/security"}
	}
	return darwinStore{service: service}
}

func (s darwinStore) Name() string { return "macos-keychain" }
func (s darwinStore) Available() bool {
	_, err := os.Stat(securityBin)
	return err == nil
}

func (s darwinStore) Set(key, value string) error {
	// -U updates an existing generic-password item in place instead of failing.
	cmd := exec.Command(securityBin, "add-generic-password",
		"-a", key, "-s", s.service, "-w", value, "-U")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return errors.New("secretstore(macos): add failed: " + strings.TrimSpace(stderr.String()))
	}
	return nil
}

func (s darwinStore) Get(key string) (string, bool, error) {
	cmd := exec.Command(securityBin, "find-generic-password",
		"-a", key, "-s", s.service, "-w")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if exitCode(err) == secErrItemNotFound {
			return "", false, nil
		}
		return "", false, errors.New("secretstore(macos): find failed: " + strings.TrimSpace(stderr.String()))
	}
	// -w prints the password followed by a newline.
	return strings.TrimRight(stdout.String(), "\n"), true, nil
}

func (s darwinStore) Delete(key string) error {
	cmd := exec.Command(securityBin, "delete-generic-password",
		"-a", key, "-s", s.service)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if exitCode(err) == secErrItemNotFound {
			return nil // already gone
		}
		return errors.New("secretstore(macos): delete failed: " + strings.TrimSpace(stderr.String()))
	}
	return nil
}

func exitCode(err error) int {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}
