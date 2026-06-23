// Command desktop-backend is the Go sidecar for the ZPass Electron app.
//
// Subcommands:
//
//	(no args)         start the HTTP server on 127.0.0.1, print a JSON
//	                  handshake line to stdout, then block. The server
//	                  exposes the typed Huma API (currently just /health)
//	                  and the generic Wails compatibility surface
//	                  (POST /wails/call + GET /wails/events) used by the
//	                  ported renderer.
//	openapi [path]    dump the OpenAPI 3.1 schema as YAML and exit. The
//	                  default path is "openapi.yaml" relative to the cwd.
//	                  This intentionally builds a minimal server WITHOUT
//	                  opening the vault DB or wiring services so the dump
//	                  is fast and side-effect free.
//
// Handshake line printed on startup:
//
//	{"port":54321,"token":"<hex>","baseUrl":"http://127.0.0.1:54321"}
//
// The Electron main process reads the first stdout line, parses it, and
// exposes baseUrl + token to the renderer through preload.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/zerx-lab/zpass/internal/server"
	"github.com/zerx-lab/zpass/internal/services"
	"github.com/zerx-lab/zpass/internal/wailscompat"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "openapi" {
		path := "openapi.yaml"
		if len(os.Args) > 2 {
			path = os.Args[2]
		}
		if err := dumpOpenAPI(path); err != nil {
			fmt.Fprintln(os.Stderr, "openapi dump failed:", err)
			os.Exit(1)
		}
		_, _ = fmt.Fprintln(os.Stdout, "wrote", path)
		return
	}

	if err := runServer(); err != nil {
		fmt.Fprintln(os.Stderr, "server failed:", err)
		os.Exit(1)
	}
}

func runServer() error {
	// Build the full service graph before opening the HTTP socket so a
	// failure to open the vault DB never leaves Electron talking to a
	// half-initialised backend.
	deps, err := buildServices()
	if err != nil {
		return err
	}
	defer deps.shutdown()

	built, err := server.Build(server.Config{
		Registry: deps.registry,
		Hub:      deps.hub,
	})
	if err != nil {
		return err
	}

	addr := built.Listener.Addr().(*net.TCPAddr)
	handshake := map[string]any{
		"port":    addr.Port,
		"token":   built.Token,
		"baseUrl": fmt.Sprintf("http://%s:%d", server.LoopbackHost, addr.Port),
	}
	if err := json.NewEncoder(os.Stdout).Encode(handshake); err != nil {
		return err
	}

	// Graceful shutdown on Electron parent kill.
	//
	// Electron's `child.kill()` defaults to SIGTERM. Without a handler, Go's
	// runtime exits immediately and `defer deps.shutdown()` never runs —
	// which leaves `~/.config/zpass/browser-bridge.json` behind pointing at
	// a dead port. The native-host then thinks the GUI is alive, tries to
	// forward to a closed loopback socket, then enters the spawn+waitBridge
	// path (~5s) on every browser popup. Catching SIGTERM/SIGINT here lets
	// `BrowserBridgeServer.Shutdown` remove the file on the way out.
	//
	// SIGKILL cannot be caught — if Electron escalates we still leak the
	// file, but the native-host has its own staleness check as a backstop.
	srv := &http.Server{Handler: built.Handler}
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	// http.Server.Serve returns http.ErrServerClosed on graceful shutdown;
	// treat that as success so the deferred deps.shutdown() runs cleanly.
	if err := srv.Serve(built.Listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func dumpOpenAPI(path string) error {
	// No services, no DB, no event hub — just enough to render the typed
	// schema. The compat surface (/wails/*) is not part of OpenAPI.
	built, err := server.Build(server.Config{Token: "dump"})
	if err != nil {
		return err
	}
	_ = built.Listener.Close()

	yaml, err := built.API.OpenAPI().YAML()
	if err != nil {
		return err
	}
	return os.WriteFile(path, yaml, 0o644)
}

// deps groups every service the sidecar owns plus the wails-compat plumbing.
// Tracking them on a struct (instead of plain locals) keeps the shutdown
// order deterministic and the wiring readable when more services land.
type deps struct {
	vaultDB       *services.VaultDB
	vault         *services.VaultService
	sshAgent      *services.SshAgentService
	browserBridge *services.BrowserBridgeServer
	sync          *services.SyncService
	cloud         *services.CloudService
	registry      *wailscompat.Registry
	hub           *wailscompat.Hub
}

// buildServices opens the vault DB, constructs the service graph, registers
// each service with the wails-compat dispatcher, and wires the event hub.
//
// Order matters:
//   - VaultService is created first because SshAgentService and ExportService
//     hold a back-reference to it.
//   - SshAgentService and VaultService bi-directionally talk through a
//     notifier/emitter pair; we set the notifier after both exist.
//   - The browser bridge is best-effort: failure to bind its loopback port
//     should not block the GUI from starting (the user just loses
//     auto-fill until next launch).
func buildServices() (*deps, error) {
	vaultDB, err := services.OpenVaultDB()
	if err != nil {
		return nil, fmt.Errorf("open vault db: %w", err)
	}

	vault := services.NewVaultService(vaultDB)
	sshAgent := services.NewSshAgentService(vault)
	vault.SetSshAgentNotifier(sshAgent)

	browserBridge := services.NewBrowserBridgeServer(vault)
	if err := browserBridge.Start(); err != nil {
		log.Printf("browser bridge disabled: %v", err)
		browserBridge = nil
	}

	hub := wailscompat.NewHub()
	hubEmit := hub.EmitterFunc()

	// CloudService owns the zero-knowledge cloud account session and per-vault
	// sync. It emits cloud:* progress/auth events over the same hub.
	cloudSvc := services.NewCloudService(vault)

	// emit wraps the hub emitter so a local vault change also nudges an
	// automatic cloud sync (debounced) — the push half of auto-sync; the
	// periodic loop + sign-in kick cover remote pulls.
	emit := func(event string, payload any) {
		hubEmit(event, payload)
		// Only USER edits nudge a push. A vault:changed emitted by the sync
		// engine itself (applying pulled remote items, kind="cloud-sync") must
		// NOT re-nudge — that would livelock: pull → notify → nudge → pull …
		// (observed as an endless "vault keys pushed" / "pushing 0/1" loop).
		if event == "vault:changed" && !services.IsCloudSyncChange(payload) {
			cloudSvc.NudgeSync()
		}
	}
	sshAgent.SetEventEmitter(emit)
	vault.SetEventEmitter(emit)
	cloudSvc.SetEventEmitter(emit)
	cloudSvc.StartBackgroundSync()

	syncSvc := services.NewSyncService(vault)

	registry := wailscompat.NewRegistry()
	registry.Register("ConfigService", services.NewConfigService())
	registry.Register("VaultService", vault)
	registry.Register("FontService", services.NewFontService())
	registry.Register("QRService", services.NewQRService())
	registry.Register("SshAgentService", sshAgent)
	registry.Register("ExportService", services.NewExportService(vault))
	registry.Register("SyncService", syncSvc)
	registry.Register("CloudService", cloudSvc)

	// Re-adopt a background agent that the previous GUI run left alive.
	// Same logic as the old Wails main.go — see SshAgentService.Shutdown
	// for the cross-restart contract.
	desired, prefExists, prefErr := services.ReadSshAgentDesiredEnabled()
	if prefErr != nil {
		log.Printf("read ssh agent preference failed: %v", prefErr)
	}
	if desired || (!prefExists && services.IsAgentAlreadyRunning()) {
		if err := sshAgent.Enable(); err != nil {
			log.Printf("auto re-adopt ssh agent failed: %v", err)
		}
	}

	return &deps{
		vaultDB:       vaultDB,
		vault:         vault,
		sshAgent:      sshAgent,
		browserBridge: browserBridge,
		sync:          syncSvc,
		cloud:         cloudSvc,
		registry:      registry,
		hub:           hub,
	}, nil
}

// shutdown reverses buildServices in the order most likely to leave a clean
// disk state: stop accepting bridge traffic → detach SSH agent → close
// vault DB so WAL pages merge back into the main file.
func (d *deps) shutdown() {
	if d == nil {
		return
	}
	if d.browserBridge != nil {
		_ = d.browserBridge.Shutdown()
	}
	if d.sync != nil {
		_ = d.sync.StopServer()
		_ = d.sync.Disconnect()
	}
	if d.cloud != nil {
		_ = d.cloud.Stop()
	}
	if d.sshAgent != nil {
		_ = d.sshAgent.Shutdown()
	}
	if d.vaultDB != nil {
		_ = d.vaultDB.Close()
	}
}
