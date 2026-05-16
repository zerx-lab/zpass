//go:build nativehost

package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"time"
)

func main() {
	db, err := OpenVaultDB()
	if err != nil {
		writeNative(nativeResponse{OK: false, Error: "ZPass vault database is not available."})
		return
	}
	defer db.Close()

	vault := NewVaultService(db)
	_, _ = vault.TryUnlockWithTrustedDevice()

	for {
		msg, err := readNative(os.Stdin)
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil {
			writeNative(nativeResponse{OK: false, Error: "Invalid native message."})
			return
		}
		if resp, err := forwardToDesktopClient(msg); err == nil {
			writeNative(resp)
			continue
		}
		writeNative(handleNativeVault(vault, msg))
	}
}

func forwardToDesktopClient(msg nativeEnvelope) (nativeResponse, error) {
	cfg, err := readBrowserBridgeConfig()
	if err != nil {
		return nativeResponse{}, err
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		return nativeResponse{}, err
	}
	req, err := http.NewRequest(
		http.MethodPost,
		"http://127.0.0.1:"+cfg.Port+"/native",
		bytes.NewReader(payload),
	)
	if err != nil {
		return nativeResponse{}, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+cfg.Token)

	client := &http.Client{Timeout: 1500 * time.Millisecond}
	httpResp, err := client.Do(req)
	if err != nil {
		return nativeResponse{}, err
	}
	defer httpResp.Body.Close()
	if httpResp.StatusCode != http.StatusOK {
		return nativeResponse{}, errors.New("desktop bridge rejected request")
	}
	var resp nativeResponse
	if err := json.NewDecoder(httpResp.Body).Decode(&resp); err != nil {
		return nativeResponse{}, err
	}
	return resp, nil
}

func readNative(r io.Reader) (nativeEnvelope, error) {
	var size uint32
	if err := binary.Read(r, binary.LittleEndian, &size); err != nil {
		return nativeEnvelope{}, err
	}
	if size == 0 || size > nativeMaxMessageBytes {
		return nativeEnvelope{}, errors.New("native message size rejected")
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nativeEnvelope{}, err
	}
	var msg nativeEnvelope
	if err := json.Unmarshal(buf, &msg); err != nil {
		return nativeEnvelope{}, err
	}
	return msg, nil
}

func writeNative(resp nativeResponse) {
	payload, err := json.Marshal(resp)
	if err != nil {
		payload = []byte(`{"ok":false,"error":"Native response encoding failed."}`)
	}
	_ = binary.Write(os.Stdout, binary.LittleEndian, uint32(len(payload)))
	_, _ = os.Stdout.Write(payload)
}
