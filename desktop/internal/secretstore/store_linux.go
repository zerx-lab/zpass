//go:build linux

package secretstore

import (
	"fmt"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
)

// D-Bus Secret Service constants (org.freedesktop.secrets), the standard
// freedesktop credential API implemented by gnome-keyring and KWallet's
// secrets bridge. We use the "plain" session algorithm: the secret travels in
// the clear over the *local* D-Bus socket, which is the accepted posture for a
// cgo-free client (the alternative, DH-encrypted sessions, needs no extra
// confidentiality on a per-user local socket).
const (
	secretsDest     = "org.freedesktop.secrets"
	secretsPath     = "/org/freedesktop/secrets"
	ifaceService    = "org.freedesktop.Secret.Service"
	ifaceCollection = "org.freedesktop.Secret.Collection"
	ifaceItem       = "org.freedesktop.Secret.Item"
	ifacePrompt     = "org.freedesktop.Secret.Prompt"
	propItemLabel   = "org.freedesktop.Secret.Item.Label"
	propItemAttrs   = "org.freedesktop.Secret.Item.Attributes"
	loginCollection = "/org/freedesktop/secrets/collection/login"
	promptTimeout   = 30 * time.Second
)

// dbusSecret is the org.freedesktop.Secret.Service "Secret" struct, in field
// order. For a plain session Parameters is empty and Value holds the raw bytes.
type dbusSecret struct {
	Session     dbus.ObjectPath
	Parameters  []byte
	Value       []byte
	ContentType string
}

// linuxStore talks to the Secret Service over the session bus. The connection
// and session are established lazily and reused under mu.
type linuxStore struct {
	service string

	mu      sync.Mutex
	conn    *dbus.Conn
	session dbus.ObjectPath
}

func newStore(service string) Store {
	s := &linuxStore{service: service}
	// Probe once so callers can branch on Available() immediately; a failure
	// here means no usable keyring daemon on this machine/session.
	if err := s.ensure(); err != nil {
		return unavailableStore{reason: "linux-secret-service"}
	}
	return s
}

func (s *linuxStore) Name() string { return "linux-secret-service" }

func (s *linuxStore) Available() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ensureLocked() == nil
}

// ensure (locked wrapper) establishes the bus connection + plain session.
func (s *linuxStore) ensure() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ensureLocked()
}

func (s *linuxStore) ensureLocked() error {
	if s.conn != nil && s.conn.Connected() {
		return nil
	}
	conn, err := dbus.SessionBusPrivate()
	if err != nil {
		return err
	}
	if err := conn.Auth(nil); err != nil {
		_ = conn.Close()
		return err
	}
	if err := conn.Hello(); err != nil {
		_ = conn.Close()
		return err
	}
	svc := conn.Object(secretsDest, secretsPath)
	var disregard dbus.Variant
	var session dbus.ObjectPath
	if err := svc.Call(ifaceService+".OpenSession", 0, "plain", dbus.MakeVariant("")).
		Store(&disregard, &session); err != nil {
		_ = conn.Close()
		return fmt.Errorf("open session: %w", err)
	}
	s.conn = conn
	s.session = session
	return nil
}

// attrs is the lookup key for this service+key pair. "service" namespaces our
// items; "key" identifies the specific secret.
func (s *linuxStore) attrs(key string) map[string]string {
	return map[string]string{"service": s.service, "key": key}
}

func (s *linuxStore) collection() (dbus.ObjectPath, error) {
	svc := s.conn.Object(secretsDest, secretsPath)
	var coll dbus.ObjectPath
	if err := svc.Call(ifaceService+".ReadAlias", 0, "default").Store(&coll); err == nil && coll != "/" && coll != "" {
		return coll, nil
	}
	// Fall back to the conventional login keyring when no default alias is set.
	return dbus.ObjectPath(loginCollection), nil
}

func (s *linuxStore) Set(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLocked(); err != nil {
		return err
	}
	coll, err := s.collection()
	if err != nil {
		return err
	}
	if err := s.unlock(coll); err != nil {
		return err
	}

	secret := dbusSecret{
		Session:     s.session,
		Parameters:  []byte{},
		Value:       []byte(value),
		ContentType: "text/plain; charset=utf8",
	}
	props := map[string]dbus.Variant{
		propItemLabel: dbus.MakeVariant(s.service + ":" + key),
		propItemAttrs: dbus.MakeVariant(s.attrs(key)),
	}
	collObj := s.conn.Object(secretsDest, coll)
	var item, prompt dbus.ObjectPath
	if err := collObj.Call(ifaceCollection+".CreateItem", 0, props, secret, true).
		Store(&item, &prompt); err != nil {
		return fmt.Errorf("create item: %w", err)
	}
	return s.awaitPrompt(prompt)
}

func (s *linuxStore) Get(key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLocked(); err != nil {
		return "", false, err
	}
	svc := s.conn.Object(secretsDest, secretsPath)
	var unlocked, locked []dbus.ObjectPath
	if err := svc.Call(ifaceService+".SearchItems", 0, s.attrs(key)).
		Store(&unlocked, &locked); err != nil {
		return "", false, fmt.Errorf("search items: %w", err)
	}
	if len(unlocked) == 0 && len(locked) > 0 {
		if err := s.unlockItems(locked); err != nil {
			return "", false, err
		}
		unlocked = locked
	}
	if len(unlocked) == 0 {
		return "", false, nil
	}
	itemObj := s.conn.Object(secretsDest, unlocked[0])
	var sec dbusSecret
	if err := itemObj.Call(ifaceItem+".GetSecret", 0, s.session).Store(&sec); err != nil {
		return "", false, fmt.Errorf("get secret: %w", err)
	}
	return string(sec.Value), true, nil
}

func (s *linuxStore) Delete(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLocked(); err != nil {
		return err
	}
	svc := s.conn.Object(secretsDest, secretsPath)
	var unlocked, locked []dbus.ObjectPath
	if err := svc.Call(ifaceService+".SearchItems", 0, s.attrs(key)).
		Store(&unlocked, &locked); err != nil {
		return fmt.Errorf("search items: %w", err)
	}
	for _, p := range append(unlocked, locked...) {
		itemObj := s.conn.Object(secretsDest, p)
		var prompt dbus.ObjectPath
		if err := itemObj.Call(ifaceItem+".Delete", 0).Store(&prompt); err != nil {
			return fmt.Errorf("delete item: %w", err)
		}
		if err := s.awaitPrompt(prompt); err != nil {
			return err
		}
	}
	return nil
}

// unlock unlocks a collection if it is locked, blocking on a prompt if needed.
func (s *linuxStore) unlock(coll dbus.ObjectPath) error {
	return s.unlockItems([]dbus.ObjectPath{coll})
}

func (s *linuxStore) unlockItems(paths []dbus.ObjectPath) error {
	svc := s.conn.Object(secretsDest, secretsPath)
	var unlockedPaths []dbus.ObjectPath
	var prompt dbus.ObjectPath
	if err := svc.Call(ifaceService+".Unlock", 0, paths).
		Store(&unlockedPaths, &prompt); err != nil {
		return fmt.Errorf("unlock: %w", err)
	}
	return s.awaitPrompt(prompt)
}

// awaitPrompt blocks on a Prompt object until it completes. A "/" path means no
// prompt was needed (the common case for an already-unlocked login keyring). A
// user-dismissed prompt is surfaced as ErrPromptDismissed rather than silently
// treated as success, so the caller can report that the operation was cancelled.
func (s *linuxStore) awaitPrompt(prompt dbus.ObjectPath) error {
	if prompt == "/" || prompt == "" {
		return nil
	}
	matchOpts := []dbus.MatchOption{
		dbus.WithMatchObjectPath(prompt),
		dbus.WithMatchInterface(ifacePrompt),
		dbus.WithMatchMember("Completed"),
	}
	sigCh := make(chan *dbus.Signal, 1)
	s.conn.Signal(sigCh)
	defer s.conn.RemoveSignal(sigCh)

	if err := s.conn.AddMatchSignal(matchOpts...); err != nil {
		return err
	}
	// Remove the bus-side match rule too — RemoveSignal only detaches the local
	// channel and would otherwise leak a rule per prompt.
	defer func() { _ = s.conn.RemoveMatchSignal(matchOpts...) }()

	promptObj := s.conn.Object(secretsDest, prompt)
	if err := promptObj.Call(ifacePrompt+".Prompt", 0, "").Err; err != nil {
		return fmt.Errorf("prompt: %w", err)
	}

	timer := time.NewTimer(promptTimeout)
	defer timer.Stop()
	for {
		select {
		case sig := <-sigCh:
			if sig.Path != prompt || sig.Name != ifacePrompt+".Completed" {
				continue
			}
			if len(sig.Body) >= 1 {
				if dismissed, ok := sig.Body[0].(bool); ok && dismissed {
					return ErrPromptDismissed
				}
			}
			return nil
		case <-timer.C:
			return fmt.Errorf("prompt timed out")
		}
	}
}
