# ZPass Browser Extension

WXT-based browser extension for ZPass Desktop autofill.

## What It Does

- Detects login forms on `http` and `https` pages.
- Shows an inline ZPass fill button beside password fields.
- Queries ZPass Desktop through the browser native messaging protocol.
- Lists only credentials whose saved URL host matches the current page host.
- Reveals the password only after the user selects a matching login.
- Bridges WebAuthn `navigator.credentials.create/get` calls to ZPass Desktop
  passkeys, using vault-backed ES256 credentials without exporting private keys.

## Native Messaging Host

The host name is `com.zerx_lab.zpass`. Build it from the desktop project:

```sh
cd ../desktop
task nativehost:build
```

Install a browser host manifest based on:

- `native-host/chrome.example.json`
- `native-host/firefox.example.json`

Update `path` to the built `zpass-native-host.exe` location. For Chrome/Edge,
replace `REPLACE_WITH_EXTENSION_ID` after loading or publishing the extension.
Firefox uses the fixed extension id declared in `wxt.config.ts`.

On Windows for Chrome:

```powershell
.\native-host\install-chrome.ps1 -ExtensionId <your-32-letter-extension-id>
```

For Edge:

```powershell
.\native-host\install-chrome.ps1 -Browser edge -ExtensionId <your-32-letter-extension-id>
```

## Development

```sh
npm install
npm run dev
npm run build
npm run typecheck
```

Security boundary: the extension never sends a master password to the native
host. The native host first forwards requests to the running ZPass Desktop
client over a per-session localhost bridge protected by a random token stored
in the user config directory with `0600` permissions. If the desktop client is
not running, the host falls back to trusted-device unlock only. Origin matching
is checked again in the desktop/native layer before any password is returned.
Passkey requests use the same bridge, and the native layer rejects RP IDs that
do not match the calling page origin before creating or signing credentials.
