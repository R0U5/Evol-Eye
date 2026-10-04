# Security Review — EVOL Eye EXE Installer (Go + WebView2 wrapper)

- **Date:** 2026-09-11
- **Reviewer:** Hackerman (security / pentest pass)
- **Repo:** `Devils-Eye` @ `feat/exe-installer` (`HEAD` = a1951a9 "fix(ci): run sha256sum -c from inside dist-installer…")
- **Scope (read-only):**
  - `installer/main.go` — Go + WebView2 wrapper (loopback HTTP + CSP, IPC bridge)
  - `installer/go.mod`, `installer/go.sum`, `installer/vendor/` — dependency pins
  - `installer/build.mjs` — build orchestrator
  - `installer/selftest/main.go`, `installer/selftest/go.mod` — headless verifier
  - `.github/workflows/installer-exe.yml` — CI/CD pipeline
  - `installer/launcher-app.mjs`, `installer/manifest.json`, `dist-installer/` (built artifacts)
- **No source files were modified.**

---

## Verdict: **CONDITIONAL** (no blockers)

The wrapper is defensively sound: loopback-only server, OS-assigned random port, static embedded-only content, strict CSP, read-only IPC bridge, no eval/plugin/update code, no auto-update mechanism, checksum-verified build toolchains, and SHA-pinned CI actions. I found **no RCE, no privilege escalation, and no direct data-exfiltration vector** in the wrapper itself.

The **conditional** items are release-readiness gates, not code defects:

1. **Code signing (required before public distribution)** — the exe is unsigned; SmartScreen will flag it. See §6.
2. **Broad HTTPS egress in CSP** (`connect-src 'self' https:`) — by design for live data feeds, but means any XSS inside the embedded page can phone home to any HTTPS host. Acceptable for v1 if app-level input handling stays tight; tightening options in §3.
3. **No runtime integrity check of the embedded bundle** — an attacker who patches the exe swaps the embedded HTML/JS and the wrapper runs it. Signing mitigates; runtime self-check is not possible without a public key. See §6.

---

## 1. Binary hardening

| Control | Status | Notes |
|---|---|---|
| ASLR (PIE) | ✅ | Go targets amd64 with PIE by default (`-pie`); no flag disables it; Go 1.27.1 toolchain. |
| DEP / NX | ✅ | Enforced by Windows for 64-bit executables (W^X); not applicable to disable. |
| CFG (Control Flow Guard) | ⚠️ | **Not enabled.** Zig/clang can pass `-fcf-protection=return` on the CGo side; the Go runtime itself doesn't use MSVC CFG. Low severity here (no untrusted native input parsing), but hardening is cheap if desired. |
| SafeSEH | N/A | 32-bit x86 MSVC-only mitigation; target is amd64. Not applicable. |
| Stripped symbols | ✅ | `-ldflags=-s -w` (build.mjs `buildExe`). Confirmed `-s -w` applied. |
| Build path leakage | ✅ | `-trimpath` applied; `-buildvcs=false` suppresses VCS metadata. |
| GUI subsystem / console window | ✅ | `-Wl,--subsystem,windows` — no console flash. Single `-ldflags` value (last-wins hazard documented in code, handled correctly). |
| Packing/UPX | ✅ | None — avoids AV false positives and unpacking risk. |
| PE sanity check | ✅ | `verifyPE()` in build.mjs checks MZ + PE magic/size before shipping. |
| Relocations | ✅ | Standard; no odd mappings. |

**Finding 1.1 (minor):** CFG not enabled. Also there is no `.rdata`/stack hardening beyond compiler defaults. Not a blocker — the wrapper executes no untrusted native input (no plugin/update/codegen).

**Finding 1.2 (info):** Comment in `build.mjs` header says "pins webview_go 0.10.0" while `go.mod` pins `v0.0.0-20240217094020-f8e8d34d29dd`. Cosmetic doc drift, non-security, but fix the comment.

---

## 2. WebView2 attack surface

- **Navigation confinement:** single `w.Navigate(url)` to the loopback origin (`http://127.0.0.1:<random>/`). **No** `SetNavigationHandler` interception is registered — if the embedded page navigates (e.g., an `<a target=_top>` or JS redirect wins at `src` level) the WebView2 window could load an external page inside the app context. Content is first-party static + CSP-constrained, so risk is low, but intercepting navigation and blocking non-loopback/https destinations is a cheap hardening step.
- **IPC bridge:** exactly one binding — `evolEyeInfo` — a **read-only** static info struct (App/Version/Platform). No arguments accepted, no filesystem/exec/network capability exposed. No hostile-surface input reaches Go from JS beyond the binding name. ✅
- **No eval / plugin / update code:** `Eval`/`Init`/`SetHtml` exist in the vendored webview binding API but are **never called** from `main.go`. No plugin loading, no extension, no WebView2 update URL override. ✅ (grep over `main.go`, vendored `webview.go`/`glue.c`/`webview.cc` confirms.)
- **Vendored binding hygiene:** `webview.go` CGo flags are limited to `-static -ladvapi32 …` (Windows SDK libs). `glue.c` is a thin dispatch/bind shim. No `--no-sandbox`, `--disable-web-security`, or `remote-debugging-port` flags anywhere. ✅
- **DevTools:** gated behind `EVOL_EYE_DEBUG` env var (opt-in). ✅ Minor note: if the env var is ever set on a production machine, devtools give console access to page JS — same blast radius as an XSS; keep env var out of production launchers.
- **WebView2 data folder:** not overridden — WebView2 uses the default per-app profile under `%LOCALAPPDATA%`. Persistent cookies from connected services (radio-browser, open-meteo) are possible. No wrapper involvement; informational.
- **No HTTPS for loopback:** loopback HTTP is standard for WebView2 wrappers (cert-pinning pain, no network exposure) — acceptable. Content is served with CSP + anti-sniff headers.

**Finding 2.1 (minor):** add a navigation interceptor to confine to the loopback origin (and deny `file:`, non-loopback hosts). Also consider `w.Init` guard code that hard-kills `window.open` new windows — optional.

**Finding 2.2 (minor):** lack of `base-uri` and `frame-ancestors` in CSP (see §3).

---

## 3. HTTP server surface (embedded)

- **Loopback-only:** `net.Listen("tcp", "127.0.0.1:0")` — IPv4 loopback, **OS-assigned random port**. ✅ DNS-rebinding attacks and remote exploitation are not possible.
- **Static only:** serves `embed.FS` virtual FS (staged `installer/app/` from `dist/`) via `http.FileServer`. No dynamic routes, no POST handlers, no uploads, no user-supplied paths. Server-side path traversal is not applicable (virtual embed FS, `fs.Sub(app,"app")` boundary). ✅
- **Timeouts:** Read 30 s / Write 30 s / Idle 5 min set on the `http.Server`. ✅ (No timeout at all would have been a finding — it's set.)
- **HEAD/GET only?** FileServer serves GET/HEAD; no CORS headers emitted → cross-origin reads from a hostile browser tab are blocked by CORS defaults. ✅
- **CSP (set on every response):**
  `default-src 'self'; connect-src 'self' https:; img-src 'self' https: data:; script-src 'self'; style-src 'self' 'unsafe-inline';`
  - ✅ `script-src 'self'` — no remote or inline scripts; the primary XSS mitigation.
  - ✅ `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
  - ⚠️ `connect-src … https:` = **any HTTPS host** may be connected to from page JS. Required for the live feeds (open-meteo, radio-browser, Google Fonts) but doubles as an exfil channel if page content is ever attacker-influenced. **Recommendation:** allowlist the specific feed hosts (e.g. `https://open-meteo.com https://www.radio-browser.info https://fonts.googleapis.com https://fonts.gstatic.com`) instead of blanket `https:`.
  - ⚠️ `img-src … data:` and `style-src 'unsafe-inline'` are small enlargements — acceptable for the bundled app; note for future tightening.
  - Minor gaps: no `base-uri 'none'`, no `object-src 'none'`, no `frame-ancestors` (partially covered by XFO DENY).
- **Host header:** Go `http.Server` does not validate `Host`. Impact: local browser tab could request the loopback port with an arbitrary Host — but response is static first-party content with no CORS; no cache-poisoning blast radius outside the single process/port. Low.
- **Index/symlink serving:** FileServer over embed FS only — no `..` escape possible outside staged bundle.

**Finding 3.1 (low):** tighten CSP `connect-src`/`img-src` to the concrete feed origins. No blocker; the current policy is reasonable for a live-data app.

---

## 4. Supply chain

- **Go module pins — ✅ strong.** `go.mod` requires `github.com/webview/webview_go v0.0.0-20240217094020-f8e8d34d29dd` (immutable commit-tag); `go.sum` hashes the module and its `go.mod` (`h1:` license hashes). **Vendored in-repo** at `installer/vendor/github.com/webview/webview_go/` (with the documented EventToken.h fix for upstream issue #21) and built with `-mod=vendor` → CI cannot drift from the vendored copy, and the vendored diff is visible in git history. Selftest module is dependency-free (no `require` line). ✅
- **Toolchain verification — ✅ strong.** Every downloaded tarball (Node 24.14.0, Go 1.27.1, Zig 0.16.0) is verified with `sha256sum -c` against hardcoded digests in `env:` before use — including Node (deliberately bypassing `setup-node` since it offers no artifact-verification hook; documented in the workflow).
- **Action pins — ✅.** All `uses:` are pinned to immutable commit SHAs: `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683`, `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02`, `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`, `softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65`. ⚠️ Verify `3bb12739…` corresponds to a known-good release of `softprops/action-gh-release` (comment notes the tag moved 2026-09-07 — confirm the SHA actually tracks v2, not an older commit; SHA pin is still correct practice either way).
- **Permissions — ✅ least privilege.** Workflow-wide `permissions: contents: read`; only the `release` job elevates to `contents: write` (required to attach assets), and never includes `id-token`/`packages`/`secrets` inheritance. `persist-credentials: false` on checkout. `concurrency: cancel-in-progress: true` prevents races.
- **npm install:** `npm ci` — full lockfile (`package-lock.json` exists at repo root). ✅
- **Build context flagging:** `-buildvcs=false` prevents buildtree leakage. `PUPPETEER_SKIP_DOWNLOAD=1` avoids an unnecessary untrusted binary download.
- **Hours-of-trust note:** hardcoded SHA digests protect against *downstream* tampering of official mirrors, not against a compromised mirror publishing a new official build (same as everyone; standard practice). Fine.

**Finding 4.1 (verify-only):** confirm `softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65` maps to the intended upstream release.

---

## 5. Auto-update integrity

**There is no auto-update mechanism in the EXE** — and that is the right call for v1.

- Grep across `main.go`, vendored binding, `launcher-app.mjs`, `selftest`, and the workflow found **zero** update/download-check/replace code in the Windows wrapper. No `releases/latest` API call, no self-replacement, no remote code fetch at runtime.
- Distribution shrink-wrap: `build.mjs` generates `SHA256SUMS.txt`, and the release job attaches `Evol-Eye-Installer.exe` + `SHA256SUMS.txt` + Windows selftest to the GitHub Release. CI verifies the checksums of built artifacts (`sha256sum -c SHA256SUMS.txt` run inside `dist-installer/` to handle bare filenames — the recent fix).
- **Residual risk:** the checksums are produced *by the same build* that produces the exe, and the GitHub Release itself is the trust anchor (repo-write = publish-write). This is the standard "trust the release page" model; it does not defend a user who downloads a repackaged/corrupted exe from elsewhere. The only real defense at that point is **code signing + Windows verification** (see §6).
- **If an auto-updater is added later:** require (a) TLS to `api.github.com`, (b) pin to the release asset SHA256 from `SHA256SUMS.txt` **re-downloaded over TLS and validated**, ideally (c) detached Ed25519 signature over the asset using a key kept out of CI, and (d) atomic replace with rollback and a disabled-by-default prompt. None of this exists yet — nothing to attack today.

**Finding 5.1 (info / future-proofing):** document the "no auto-update" decision in `installer/README.md` so a future contributor doesn't bolt on an unsigned updater.

---

## 6. Code signing / SmartScreen path

- **Status: NOT SIGNED.** No signing step exists in `installer-exe.yml` (no secrets, no signtool invocation, no certificate). `dist-installer/Evol-Eye-Installer.exe` is a bare unsigned PE.
- **User impact on Windows 10/11:** SmartScreen "Windows can't verify the publisher" warning on run; Chrome/Edge flag unsigned downloads; enterprises with application-control (SmartScreen L1+/EDR allowlists) may block it outright. For a private/internal distribution this is an accepted nuisance; for **public distribution it is effectively a blocker for user trust**.
- **Tamper integrity:** because the exe embeds the entire web bundle, an attacker can hex-patch the embedded HTML/JS and the app will happily render it (no self-verification possible without a key). Signing the exe (EV/OV cert) lets Windows flag tampered copies at run time.
- **Recommended path:**
  1. **STAGE A (now):** document that the exe is unsigned; explicit "Unknown publisher — expect warning" note in the release notes. Change nothing else about the pipeline.
  2. **STAGE B (before public release):** EV code-signing certificate; sign in CI with a HSM-backed signer (Azure Trusted Signing / DigiCert KeyVault, etc.), populate `SIGSTORE`/code-signing secrets, add a `signtool sign` step in `installer-exe.yml` before release, and verify with `sigcheck`/`Get-AuthenticodeSignature` in `win-smoke`.
  3. Optionally pair with a sigstore/GitHub Attestations provenance attestation for supply-chain transparency.

**Finding 6.1 (CONDITIONAL gate):** unsigned exe = SmartScreen warning + tamper-invisible embedded bundle. Not a blocker for internal use; gate before public release.

---

## 7. RCE / privilege escalation / data-exfiltration vectors

| Vector | Assessment |
|---|---|
| **RCE via HTTP server** | ❌ Not found. Static-only virtual FS, no POST routes, no path traversal (embed FS), loopback-bound. |
| **RCE via WebView2 / page content** | ❌ Not found. `script-src 'self'` blocks remote/inline script; no `Eval`/`Init` calls; no plugins; sandbox flags not disabled. Remaining exposure is browser-engine vuln in WebView2 runtime itself (out of repo control — mitigated by Microsoft/Edge servicing), not wrapper code. |
| **RCE via IPC bridge** | ❌ Not found. Single read-only binding (`evolEyeInfo`); no exec/file/network capability crosses the boundary. |
| **Privilege escalation** | ❌ Not found. No elevation request, no service/registry/persistence writes from the wrapper; runs as the invoking user; no setuid-style tricks (Windows, user-level). |
| **Data exfiltration** | ⚠️ **Indirect / by-design only.** Page JS may `connect-src https:` to any HTTPS host — that is the live-feed requirement, but it is also the only plausible exfil path, and it requires the embedded page itself to be compromised (XSS). Tightening `connect-src`/`img-src` to the concrete feed origins (§3, Finding 3.1) shrinks this to near zero. |
| **Local attack on the loopback port** | ⚠️ Low. Random port + CORS-less static content + no Host-header validation (cosmetic). A local malware process can already do worse than read embedded static assets; no mutation endpoints exist in the wrapper. |
| **Tampered exe / bundle swap** | ⚠️ Medium (distribution-time). Unsigned exe → attacker-modified embedded bundle runs silently. Code signing closes this (§6). |
| **Debug flag** | ✅ `EVOL_EYE_DEBUG` devtools opt-in by env var only; off by default. |
| **DNS rebinding** | ❌ Not applicable — loopback IP literal, IPv4 only, no privileged endpoints. |

**Finding 7.1 (info):** no RCE, no priv-esc, and no direct exfil vector found in the wrapper. The realistic threat model is (a) XSS in the embedded first-party app → HTTPS exfil (mitigate by pinning `connect-src`), and (b) supply-chain/distribution tampering of an unsigned exe (mitigate by signing).

---

## Findings summary

| ID | Severity | Type | Item |
|---|---|---|---|
| 1.1 | Low | Hardening | CFG not enabled (optional `-fcf-protection=return` via Zig/clang for CGo) |
| 1.2 | Info | Hygiene | `build.mjs` comment says webview_go 0.10.0; actual pin is `v0.0.0-20240217094020-f8e8d34d29dd` |
| 2.1 | Low | Hardening | No navigation interceptor on the WebView2 window (confine to loopback origin, block `file:`/external) |
| 3.1 | Low | Hardening | CSP `connect-src https:` / `img-src https: data:` are broad; pin to feed hosts; add `base-uri`, `object-src` |
| 4.1 | Verify | Supply chain | Confirm `softprops/action-gh-release@3bb12739…` SHA matches the intended upstream release |
| 5.1 | Info | Future-proofing | Document "no auto-update" decision in `installer/README.md` |
| 6.1 | **CONDITIONAL** | Release gate | Exe unsigned → SmartScreen + tamper-invisible bundle; sign before public release |
| 7.1 | Info | Threat model | Main residual exposures: first-party XSS → HTTPS exfil; unsigned-binary tampering |

---

## Verdict: **CONDITIONAL** ✅

No blockers. The EVOL Eye EXE installer is a well-hardened, minimal-surface wrapper:

- **PASS** — binary hardening baseline (PIE/ASLR, DEP, stripped, trimpath, no packing); loopback-only random-port static server with timeouts and security headers; read-only IPC; no eval/plugin/update code; no auto-update mechanism; Go module commit+hash pinned and vendored; toolchains SHA-256 verified in CI; actions SHA-pinned; least-privilege workflow permissions; selftest + windows smoke validated in CI.
- **CONDITIONAL (fix before public distribution):** code signing (§6, Finding 6.1). Optionally tighten CSP egress to the known feed origins (§3, Finding 3.1).
- **Recommended follow-ups (non-blocking):** navigation confinement interceptor (2.1), CFG hardening (1.1), verify action-gh-release SHA (4.1), CSP base-uri/object-src (3.1).

Sign the exe, pin the feed origins, and this is shippable.
