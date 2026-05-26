# ZPass — Chrome Web Store listing (English)

## Package title (≤ 45 chars)

```
ZPass
```

## Package summary (≤ 132 chars)

```
Secure autofill for ZPass — a zero-knowledge, local-first password manager. Logins, passkeys & TOTP, end-to-end encrypted.
```

## Category

```
Productivity
```

## Language

```
English (en)
```

## Description (≤ 16,000 chars)

```
ZPass — Secure autofill for the ZPass desktop vault.

ZPass is a zero-knowledge, local-first password manager. This extension is the
browser companion to the ZPass desktop app — it autofills logins, generates and
fills TOTP codes, saves new credentials after sign-in, and bridges WebAuthn
passkey requests to your vault. Nothing in this extension talks to any cloud
service. It speaks only to the ZPass desktop app running on your own machine,
over Chrome native messaging.


What it does

• Inline autofill menu under the focused login input, listing only credentials
  whose URL host matches the current page.

• TOTP / one-time-code detection (autocomplete="one-time-code" + heuristic
  keyword match against well-known field names). The OTP secret never leaves
  your desktop — the extension only ever receives the current 6-digit code.

• Save-login prompt after a successful sign-in, with offer-to-update when the
  password for a known username has changed. The prompt is a standalone
  OS-level popup, so the post-submit page navigation never dismisses it.

• Passkey (WebAuthn) bridge — navigator.credentials.create / get is routed to
  vault-backed ES256 credentials. The RP-ID is verified against the calling
  origin before any credential is created or signed. Private keys never leave
  the desktop.

• Lock-aware: when the desktop vault is locked, the extension stays inert and
  prompts the user to unlock; no plaintext credential ever crosses the bridge.


Security model

The extension is a thin, untrusted client. The master password is never sent
to it. The native host forwards every request to ZPass Desktop over a localhost
bridge protected by a per-session random token, stored 0600 in the user config
directory. Origin matching is re-verified inside the desktop process before
any credential is returned. Cryptography is XChaCha20-Poly1305 + Argon2id,
identical to the desktop and mobile clients (see cryptocore/).


Open source — AGPL-3.0

Every line of code lives at https://github.com/zerx-lab/zpass — protocol spec
and threat model will be published before the public release.


Requires the ZPass desktop app

Available today on Windows and Linux; macOS in preview. Install instructions
and downloads: https://zpass.app
```

## Single-purpose justification (Chrome Web Store)

```
ZPass autofills login forms, TOTP codes, and WebAuthn passkeys for the user's
saved credentials. Every code path on every page serves that single purpose:
detect a credential field, decide whether the current origin matches a saved
entry in the user's local desktop vault, and fill it on user confirmation.
```

## Permission justifications

- `nativeMessaging` — the only transport the extension uses. It connects to a
  local-only ZPass Desktop process; no remote/web endpoint is contacted.
- `activeTab` / `tabs` — required to read the focused input's bounding rect
  (to position the inline autofill menu) and to dispatch fill events into the
  page on user selection.
- `storage` — local-only storage for the per-origin "never save" ignore list
  and the inline-menu hardening backoff counter. No remote sync.
- `host_permissions: http://*/*, https://*/*` — needed because login forms can
  appear on any site; the extension does not know in advance which origins the
  user will visit. Origin-scoped filtering and origin re-verification happen
  inside the desktop process, not in the extension.
- `web_accessible_resources: inline-menu-list.html` — the inline menu iframe
  is loaded by a content script into a closed shadow root; Chrome requires the
  iframe HTML to be web-accessible.

## Privacy

Data collected: **none**.
Network endpoints contacted: **none** (the extension talks only to the local
ZPass Desktop process via Chrome native messaging).
The master password never enters the extension context.
