# ZPass Browser Extension

WXT-based browser extension for ZPass Desktop autofill.

## What It Does

- Detects login forms on `http` and `https` pages.
- Detects TOTP / one-time-code inputs and fills the current OTP from the
  matching ZPass login (see [TOTP autofill](#totp-autofill)).
- Shows an **inline autofill menu** below the focused login input listing
  matching credentials for the current site (see [Inline autofill menu](#inline-autofill-menu)).
- **Prompts to save / update credentials after a successful sign-in**
  (see [Save-login prompt](#save-login-prompt)).
- Queries ZPass Desktop through the browser native messaging protocol.
- Lists only credentials whose saved URL host matches the current page host.
- Reveals the password only after the user selects a matching login.
- Bridges WebAuthn `navigator.credentials.create/get` calls to ZPass Desktop
  passkeys, using vault-backed ES256 credentials without exporting private keys.

### Inline autofill menu

When the user focuses (or clicks into) a recognised login `<input>`, ZPass
mounts an inline floating menu just below the field, listing every saved
login whose URL host matches the current page. Selecting an entry fills the
username and password, using the same DOM-write path as the toolbar popup
(`simulateUserFill`, including the React `_valueTracker` reset).

Architecture (mirrors Bitwarden's `apps/browser/src/autofill/overlay/inline-menu/`
in shape; **clean-room reimplementation in ZPass code — no Bitwarden source
is reused, since `bitwarden/clients` is GPL-3.0**):

```
[user focuses input]
        |
        v
InlineMenuController (per-frame, src/content/inline-menu-controller.ts)
  - measures bounding rect
  - top-frame: InlineMenuInjector.openList(rect)
  - notifies background "zpass.inlineMenu.open"
        |
        v
InlineMenuInjector (src/content/inline-menu-injector.ts)
  - random-named Custom Element + popover="manual" + showPopover()
  - closed ShadowRoot wraps InlineMenuIframeShell
  - MutationObserver hardening (style / body last-child / page opacity)
  - top-layer hijack backoff: > 10 refreshes in 5s -> permanently disabled
        |
        v
InlineMenuIframeShell (src/content/inline-menu-iframe.ts)
  - <iframe credentialless src="inline-menu-list.html">
  - !important inline styles, MutationObserver-protected
  - fade-in 80ms after load
        |
        v
Inline menu list page (entrypoints/inline-menu-list/)
  - runs in extension origin
  - chrome.runtime.connect({ name: "zpass-inline-menu-list-port" })
  - renders cipher list, emits FillSelected upstream
        |
        v
InlineMenuBridge (background, src/background/inline-menu-bridge.ts)
  - pairs port with sender.tab.id
  - queries NativeBridge.queryLogins for the page origin
  - pushes init + ciphers to the iframe
  - on FillSelected: revealLogin -> tabs.sendMessage zpass.fillLogin -> content fills form
```

Design tokens follow the ZPass design system: 5/7/10 px corner radii, Geist /
Geist Mono fonts, stroke-first iconography, no emoji or Unicode decoration.
Theme follows `prefers-color-scheme` inside the iframe.

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
task build:nativehost
```

### macOS — automatic

ZPass Desktop writes the manifest for Chrome / Edge / Firefox the first time it
starts (and on every later launch, comparing bytes — so version upgrades that
change the bundled `zpass-native-host` path roll out silently). See
`desktop/electron/src/main/nmh-install.ts`.

The probe rule is "only write manifests for browsers the user actually has":

| Browser | Probed | Manifest written to |
|---|---|---|
| Chrome  | `~/Library/Application Support/Google/Chrome`   | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.zerx_lab.zpass.json` |
| Edge    | `~/Library/Application Support/Microsoft Edge`  | `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.zerx_lab.zpass.json` |
| Firefox | `~/Library/Application Support/Firefox`         | `~/Library/Application Support/Mozilla/NativeMessagingHosts/com.zerx_lab.zpass.json` |

The Chrome extension id is computed from `wxt.config.ts`'s `manifest.key`
(deterministic), so `allowed_origins` does not need a manual id update across
unpacked / Chrome Web Store builds.

### Windows — Chrome / Edge

```powershell
.\native-host\install-chrome.ps1 -ExtensionId <your-32-letter-extension-id>
.\native-host\install-chrome.ps1 -Browser edge -ExtensionId <your-32-letter-extension-id>
```

### Manual fallback

If you need to hand-author a manifest (Linux, custom Chromium fork, system-wide
install under `/Library`, debugging the auto-installer), use these templates as
starting points:

- `native-host/chrome.example.json` — Chrome / Edge / other Chromiums
- `native-host/firefox.example.json` — Firefox / Thunderbird

Update `path` to the built host binary location and replace
`REPLACE_WITH_EXTENSION_ID` with the extension id from
`chrome://extensions` (Developer mode). Firefox uses the fixed gecko id from
`wxt.config.ts` and does not need that substitution.

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
