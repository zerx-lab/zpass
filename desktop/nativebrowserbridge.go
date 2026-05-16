//go:build !nativehost

package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

type BrowserBridgeServer struct {
	vault      *VaultService
	server     *http.Server
	listener   net.Listener
	configPath string
	token      string
}

func NewBrowserBridgeServer(vault *VaultService) *BrowserBridgeServer {
	return &BrowserBridgeServer{vault: vault}
}

func (s *BrowserBridgeServer) Start() error {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen browser bridge: %w", err)
	}
	token, err := randomHex(32)
	if err != nil {
		_ = listener.Close()
		return fmt.Errorf("generate browser bridge token: %w", err)
	}
	dir, err := ensureConfigDir()
	if err != nil {
		_ = listener.Close()
		return err
	}
	cfg := browserBridgeConfig{
		Port:  strconv.Itoa(listener.Addr().(*net.TCPAddr).Port),
		Token: token,
	}
	configPath := filepath.Join(dir, browserBridgeConfigFile)
	if err := writeBrowserBridgeConfig(configPath, cfg); err != nil {
		_ = listener.Close()
		return err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/native", s.handleNative)
	s.server = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 2 * time.Second,
	}
	s.listener = listener
	s.configPath = configPath
	s.token = token
	go func() {
		if err := s.server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("browser bridge stopped: %v", err)
		}
	}()
	return nil
}

func (s *BrowserBridgeServer) Shutdown() error {
	if s == nil || s.server == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	err := s.server.Shutdown(ctx)
	if s.configPath != "" {
		_ = os.Remove(s.configPath)
	}
	return err
}

func (s *BrowserBridgeServer) handleNative(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authorized(r.Header.Get("authorization")) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	defer r.Body.Close()
	var msg nativeEnvelope
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, nativeMaxMessageBytes)).Decode(&msg); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(handleNativeVault(s.vault, msg))
}

func (s *BrowserBridgeServer) authorized(header string) bool {
	const prefix = "Bearer "
	if len(header) != len(prefix)+len(s.token) || header[:len(prefix)] != prefix {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(header[len(prefix):]), []byte(s.token)) == 1
}

func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
