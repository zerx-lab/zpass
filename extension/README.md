# ZPass Browser Extension

WXT-based browser extension for ZPass Desktop autofill.

## What It Does

- Detects login forms on `http` and `https` pages.
- Detects TOTP / one-time-code inputs and fills the current OTP from the
  matching ZPass login (see [TOTP autofill](#totp-autofill)).
- Shows an inline ZPass fill button beside password / username / TOTP fields.
- **Prompts to save / update credentials after a successful sign-in**
  (see [Save-login prompt](#save-login-prompt)).
- Queries ZPass Desktop through the browser native messaging protocol.
- Lists only credentials whose saved URL host matches the current page host.
- Reveals the password only after the user selects a matching login.
- Bridges WebAuthn `navigator.credentials.create/get` calls to ZPass Desktop
  passkeys, using vault-backed ES256 credentials without exporting private keys.

### TOTP autofill

The extension recognises one-time-code inputs using heuristics inspired by
Bitwarden's open-source browser extension
([bitwarden/clients](https://github.com/bitwarden/clients), GPL-3.0,
`apps/browser/src/autofill/services/`). The implementation in
`src/content/totp-fields.ts` is independent ZPass code; only the algorithm
shape and the public field-name keyword set are reused, both of which are
factual enumerations widely adopted across password managers.

Detection rules (in priority order, matching Bitwarden's `isTotpField`):

1. Inputs whose name / id / placeholder contain `backup` or `recovery` are
   never treated as TOTP (backup-code inputs).
2. `autocomplete="one-time-code"` (WHATWG standard) is an immediate match.
3. Inputs with excluded types (`password`, `hidden`, `submit`, ...) are
   rejected.
4. A field-name keyword match against the OTP keyword set
   (`totp`, `2facode`, `mfacode`, `onetimecode`, `verificationcode`, ...).

The TOTP code itself is computed by `desktop/totpservice.go` and returned
through a dedicated `generateLoginTotp` native bridge message; the OTP secret
never leaves the desktop process.

Manual test matrix:

| Page                                              | Expected                                                         |
|---------------------------------------------------|------------------------------------------------------------------|
| GitHub 2FA prompt (`/sessions/two-factor/app`)    | Z button appears on the 6-digit input; dropdown filtered to matching items with `hasTotp = true`; selecting fills the code. |
| Generic login form                                | Existing behaviour: username + password autofill, unchanged.     |
| Sign-up form with `confirm password` field        | Not detected as TOTP, no spurious dropdown.                      |
| Input named `recovery_code`                       | Not detected as TOTP (backup-code rule wins).                    |

### Save-login prompt

After the user submits a login form, the extension opens a **standalone
OS-level popup window** (`browser.windows.create({ type: "popup" })`,
420×220, anchored to the top-right of the active browser window) asking
whether to save the new credentials to ZPass (or update the password on
an existing match). Because the popup lives outside the host page DOM,
it survives the post-submit navigation that immediately destroys an
in-page toast — the user has unlimited time to click 保存.

| Page state                                                    | Popup shown                                                                                                                |
|---------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------|
| Submit form, vault has no matching username for the origin    | 「保存登录到 ZPass？」 with `[保存] [永不] [×]`                                                                                    |
| Submit form, same username exists with a different password   | 「更新 ZPass 中的密码？」 with `[更新密码] [永不] [×]`                                                                             |
| Account + password match an existing entry                    | (silent)                                                                                                                   |
| Desktop offline                                               | (silent — the extension is inert without a connected desktop)                                                               |
| Desktop online but vault locked                               | 「ZPass 已锁定」 with `[打开 ZPass] [稍后] [×]`; capture is queued in background and the popup is upgraded to a save bar after unlock |
| Origin previously dismissed with 「永不」                            | (silent)                                                                                                                   |

Detection signals (any of):

- `form.submit`
- Click on a submit button or any button whose text matches one of
  `login` / `sign in` / `登录` / `登入` / ... (multi-language keyword list)
- `Enter` pressed inside a password input
- URL change (history navigation, SPA route change, `beforeunload` / `pagehide`)

Forms with two or more `password` inputs are treated as sign-up / confirm-
password pages and skipped (Bitwarden heuristic).

New entries are stored as `Login` items with `name = page title`, `url = origin`,
`username`, `password`. Updates preserve every other field and only replace
`password`. The 「永不」 ignore list is persisted at
`~/.config/zpass/zpass.browser-save-ignored.json`.

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

### Brand icon

The toolbar / management-page icon is the ZPass 7x7 dot-matrix `Z`
("OTP FEEL"), kept in sync with `desktop/build/appicon.icon/Assets/wails_icon_vector.svg`
and `website/src/components/Brandmark.astro`.

Source of truth: `public/icon/icon.svg`. PNG variants (16 / 32 / 48 / 96 / 128)
are regenerated by:

```sh
npm run icons
```

The script uses `sharp` (devDependency) to rasterise the SVG at high density
and resize per Chrome / Firefox manifest requirements. Re-run it whenever the
SVG changes.

Security boundary: the extension never sends a master password to the native
host. The native host first forwards requests to the running ZPass Desktop
client over a per-session localhost bridge protected by a random token stored
in the user config directory with `0600` permissions. If the desktop client is
not running, the host falls back to trusted-device unlock only. Origin matching
is checked again in the desktop/native layer before any password is returned.
Passkey requests use the same bridge, and the native layer rejects RP IDs that
do not match the calling page origin before creating or signing credentials.
