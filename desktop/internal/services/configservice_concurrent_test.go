package services

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
)

// TestConfigWriteConcurrentSameNamespace is the regression for the observed
// "rename <ns>.json.tmp -> <ns>.json: no such file or directory" error: many
// rapid writes to ONE namespace (as a zustand store fires on startup) used to
// race on a shared tmp filename, losing writes and erroring. With a unique tmp
// name per write, every write must succeed and the final file must be valid JSON.
func TestConfigWriteConcurrentSameNamespace(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir())

	svc := NewConfigService()
	const ns = "zpass.cloud"
	const writers = 24

	var wg sync.WaitGroup
	errs := make([]error, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			payload := fmt.Sprintf(`{"state":{"baseUrl":"http://localhost:8080","deviceId":"d_%d"},"version":1}`, n)
			errs[n] = svc.Write(ns, payload)
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent Write[%d] failed: %v", i, err)
		}
	}

	// The surviving file must be valid JSON written by exactly one of the writers.
	raw, err := svc.Read(ns)
	if err != nil {
		t.Fatalf("read after concurrent writes: %v", err)
	}
	var probe map[string]any
	if err := json.Unmarshal([]byte(raw), &probe); err != nil {
		t.Fatalf("final config file is not valid JSON: %v\ncontent=%s", err, raw)
	}
}
