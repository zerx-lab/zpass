package services

// Disable the post-sign-in auto-sync kick in tests so the background goroutine
// does not race the explicit SyncNow assertions in the live sync tests.
func init() { autoSyncOnSignIn = false }
