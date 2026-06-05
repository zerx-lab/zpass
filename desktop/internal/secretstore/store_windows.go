//go:build windows

package secretstore

import (
	"errors"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows backend: the Credential Manager (advapi32 CredWrite/CredRead/
// CredDelete) storing one CRED_TYPE_GENERIC blob per key. Cgo-free via the
// lazy-DLL syscall bridge. UNVERIFIED on the Linux dev box; needs a real-Windows
// regression run. The credential is encrypted at rest by the OS for the current
// user, matching the project's existing Windows DPAPI posture.

var (
	advapi32       = windows.NewLazySystemDLL("advapi32.dll")
	procCredWriteW = advapi32.NewProc("CredWriteW")
	procCredReadW  = advapi32.NewProc("CredReadW")
	procCredDelete = advapi32.NewProc("CredDeleteW")
	procCredFree   = advapi32.NewProc("CredFree")
)

const (
	credTypeGeneric         = 1
	credPersistLocalMachine = 2
	errNotFound             = syscall.Errno(1168) // ERROR_NOT_FOUND
)

// winCredential mirrors the Win32 CREDENTIALW struct (fixed field order).
type winCredential struct {
	Flags              uint32
	Type               uint32
	TargetName         *uint16
	Comment            *uint16
	LastWritten        windows.Filetime
	CredentialBlobSize uint32
	CredentialBlob     *byte
	Persist            uint32
	AttributeCount     uint32
	Attributes         uintptr
	TargetAlias        *uint16
	UserName           *uint16
}

type windowsStore struct{ service string }

func newStore(service string) Store { return windowsStore{service: service} }

func (s windowsStore) Name() string    { return "windows-credential-manager" }
func (s windowsStore) Available() bool { return procCredWriteW.Find() == nil }

// target namespaces our credentials: "<service>:<key>".
func (s windowsStore) target(key string) string { return s.service + ":" + key }

func (s windowsStore) Set(key, value string) error {
	target, err := windows.UTF16PtrFromString(s.target(key))
	if err != nil {
		return err
	}
	blob := []byte(value)
	cred := winCredential{
		Type:               credTypeGeneric,
		TargetName:         target,
		CredentialBlobSize: uint32(len(blob)),
		Persist:            credPersistLocalMachine,
	}
	if len(blob) > 0 {
		cred.CredentialBlob = &blob[0]
	}
	r, _, callErr := procCredWriteW.Call(uintptr(unsafe.Pointer(&cred)), 0)
	if r == 0 {
		return errors.New("secretstore(windows): CredWrite failed: " + callErr.Error())
	}
	return nil
}

func (s windowsStore) Get(key string) (string, bool, error) {
	target, err := windows.UTF16PtrFromString(s.target(key))
	if err != nil {
		return "", false, err
	}
	var pcred *winCredential
	r, _, callErr := procCredReadW.Call(
		uintptr(unsafe.Pointer(target)),
		credTypeGeneric,
		0,
		uintptr(unsafe.Pointer(&pcred)),
	)
	if r == 0 {
		if errno, ok := callErr.(syscall.Errno); ok && errno == errNotFound {
			return "", false, nil
		}
		return "", false, errors.New("secretstore(windows): CredRead failed: " + callErr.Error())
	}
	defer procCredFree.Call(uintptr(unsafe.Pointer(pcred)))

	if pcred.CredentialBlobSize == 0 || pcred.CredentialBlob == nil {
		return "", true, nil
	}
	blob := unsafe.Slice(pcred.CredentialBlob, pcred.CredentialBlobSize)
	return string(blob), true, nil
}

func (s windowsStore) Delete(key string) error {
	target, err := windows.UTF16PtrFromString(s.target(key))
	if err != nil {
		return err
	}
	r, _, callErr := procCredDelete.Call(uintptr(unsafe.Pointer(target)), credTypeGeneric, 0)
	if r == 0 {
		if errno, ok := callErr.(syscall.Errno); ok && errno == errNotFound {
			return nil
		}
		return errors.New("secretstore(windows): CredDelete failed: " + callErr.Error())
	}
	return nil
}
