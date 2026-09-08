# ADR-DESKTOP-003: Desktop distribution — tagged GitHub Release, prompt-free terminal install (unsigned)

**Status:** Accepted · 2026-08-02 · **Updated 2026-09-07** (macOS now Developer-ID signed + notarized)
**Applies to:** `.github/workflows/desktop-release.yml`, `install.sh`, `install.ps1`, `webui/src-tauri/tauri.conf.json` (`bundle.macOS`), `README.md`

> **Update 2026-09-07:** an Apple Developer Program membership now exists, so the
> macOS app is **Developer-ID signed + notarized + stapled** (not ad-hoc). Gatekeeper
> no longer prompts on **any** macOS download path — the terminal one-liner and a
> browser `.dmg` alike. The terminal install and quarantine strip stay as convenience
> / belt-and-suspenders, no longer the mechanism that makes it prompt-free. **Windows
> is unchanged** (still unsigned → SmartScreen until an Authenticode cert exists). The
> original ad-hoc reasoning below is retained as history.

## Decision
Desktop installers are published as a **GitHub Release** on a version tag; users
install via a **terminal one-liner** (`install.sh` / `install.ps1`).

- The committed config KEEPS `bundle.macOS.signingIdentity: "-"` (ad-hoc) so the
  repo builds for **anyone** — forks and contributors with no Apple cert. The real
  **Developer ID is injected at release time only**, by `desktop-release.yml`, via
  `tauri build --config` when the `APPLE_SIGNING_IDENTITY` repo **variable** is set
  (the identity string is public, not a secret). Unset ⇒ ad-hoc build. This keeps
  signing a *release-CI* concern, never a repo-wide one.
- CI signs + notarizes from that variable plus five secrets: `APPLE_CERTIFICATE`
  (base64 `.p12`) + `APPLE_CERTIFICATE_PASSWORD`, and the App Store Connect API key
  `APPLE_API_ISSUER` + `APPLE_API_KEY` + `APPLE_API_KEY_P8` (written to
  `APPLE_API_KEY_PATH` in a macOS-only step). `hardenedRuntime` is on by default
  (notarization requires it). Local `tauri build` stays ad-hoc (config `"-"`) — no
  Developer ID, no notarization; the notarized artifact comes only from release CI.
- `install.sh` MUST `curl` the **`.app` zip** (NOT the `.dmg`) and `xattr -dr
  com.apple.quarantine` it; `install.ps1` MUST `Invoke-WebRequest` the NSIS `.exe`.
  Terminal downloads carry no Gatekeeper quarantine / Windows mark-of-the-web — the
  exact triggers for the first-run prompt (still the clean path on Windows).
- `desktop-release.yml` MUST bake the server URL from the **`API_ORIGIN` repo
  variable** (→ `VITE_API_URL`, see [ADR-DESKTOP-002](./ADR-DESKTOP-002-byok-relay-and-remote-path.md));
  unset ⇒ a local-only build.

## Why
Real code-signing (Apple notarization + Windows Authenticode) needs paid certs and
CI secrets we don't have yet. But those prompts are triggered by the *download's*
quarantine attribute / mark-of-the-web, which **browsers add and `curl` /
`Invoke-WebRequest` do not** — so a terminal install is prompt-free without signing.
Ad-hoc signing is a *separate* requirement: an unsigned binary is killed on Apple
Silicon regardless of quarantine (quarantine controls the *prompt*; the signature
controls whether it can *run at all*). The `.app` zip exists because the `.dmg` is
the browser path (which does prompt) — `install.sh` needs a curl-friendly archive.

## Consequences
- macOS: **no first-run prompt on any path** now that the app is notarized — browser
  `.dmg` included. On Windows the **browser** download still shows SmartScreen (no
  Authenticode cert); the terminal script stays the clean path there.
- Auto-update (Tauri updater) is a remaining follow-up (needs a separate minisign
  updater key, unrelated to the Apple cert).
- macOS is **arm64-only** for now; the Windows installer still shows a **UAC**
  elevation prompt (separate from SmartScreen).
- Two workflows: `desktop-build.yml` (`workflow_dispatch`, uploads artifacts) is the
  per-OS "does it compile" check; `desktop-release.yml` (tags) is the publish. The
  Rust storage tests run via `make test-tauri` in CI (see [ADR-DESKTOP-001](./ADR-DESKTOP-001-rusqlite-local-storage.md)).

## Rejected alternatives
- **Ship only the `.dmg` / a browser download** — every user hits the Gatekeeper
  prompt; the terminal path avoids it for free.
- **Block releases on notarization** — needs paid certs we don't have; the ad-hoc +
  terminal-install path ships now and can be signed later without changing the model.

## Verify
`grep -n "signingIdentity" webui/src-tauri/tauri.conf.json` — committed as `"-"` (ad-hoc); forks/local build unsigned-friendly.
`grep -n "APPLE_SIGNING_IDENTITY\|APPLE_API_ISSUER" .github/workflows/desktop-release.yml` — CI injects the Developer ID + notarizes.
`grep -n "Invoke-WebRequest" install.ps1` — the Windows install fetches via the terminal (no mark-of-the-web).
