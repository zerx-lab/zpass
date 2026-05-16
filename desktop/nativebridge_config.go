package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const (
	nativeMaxMessageBytes  = 1 << 20
	browserBridgeConfigFile = "browser-bridge.json"
)

type browserBridgeConfig struct {
	Port  string `json:"port"`
	Token string `json:"token"`
}

func writeBrowserBridgeConfig(path string, cfg browserBridgeConfig) error {
	data, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func readBrowserBridgeConfig() (browserBridgeConfig, error) {
	dir, err := ensureConfigDir()
	if err != nil {
		return browserBridgeConfig{}, err
	}
	data, err := os.ReadFile(filepath.Join(dir, browserBridgeConfigFile))
	if err != nil {
		return browserBridgeConfig{}, err
	}
	var cfg browserBridgeConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return browserBridgeConfig{}, err
	}
	if cfg.Port == "" || cfg.Token == "" {
		return browserBridgeConfig{}, fmt.Errorf("browser bridge config incomplete")
	}
	return cfg, nil
}
