package cloud

import (
	"errors"
	"sync/atomic"
)

// atomicString is a lock-free string cell for the bearer token, swapped by
// SetToken and read on every request. atomic.Value would panic on concurrent
// stores of different concrete types; a Pointer[string] is simpler and safe.
type atomicString struct {
	v atomic.Pointer[string]
}

func (a *atomicString) Store(s string) { a.v.Store(&s) }

func (a *atomicString) Load() string {
	if p := a.v.Load(); p != nil {
		return *p
	}
	return ""
}

// as is errors.As specialised to our pointer-to-error-pointer call sites.
func as(err error, target any) bool { return errors.As(err, target) }
