# EXE Installer: electron-builder vs Portable Wrapper — Comparison

**Date:** 2026-09-10
**Repo:** Devils-Eye (`dist/` = Vite build output, `installer/` = existing bootstrap scripts)

---

## 1. electron-builder (Standard Electron)

### Config (minimal for Vite + static assets)
```json
// package.json additions
"build": {
  "appId": "com.evol-eye.app",
  "productName": "Evol Eye",
  "directories": { "output": "dist-installer" },
  "files": ["dist/**/*"],
  "extraResources": [{ "from": "installer/", "to": "installer/" }],
  "win": {
    "target": "nsis",
    "icon": "installer/assets/icon.ico"
  },
  "nsis": {
    "oneClick": false,
    "perMachine": true,
    "allowToChangeInstallationDirectory": true
  }
}
```

### Measured Output (estimated from similar projects)
| Metric | Value |
|---|---|
| **Installer size** | 85-110 MB (NSIS compressed) |
| **Installed size** | 200-280 MB |
| **Build time (CI)** | 3-5 min |
| **Signing** | Standard `electron-builder` code signing (requires cert) |
| **Auto-update** | `electron-updater` built-in (GitHub releases) |
| **Runtime** | Bundled Chromium + Node (user needs zero deps) |
| **Browser engine** | Chromium (bundled, ~120 MB of the size) |

### Pros
- Standard, battle-tested, huge ecosystem
- Zero user dependencies (runs on clean Windows)
- Auto-update built-in (GitHub releases)
- Code signing well-documented

### Cons
- **Large** (85-110 MB download)
- Requires code signing cert for clean UX (else SmartScreen warning)
- Electron security surface (Chromium + Node = larger attack surface)
- 3-5 min CI build time

---

## 2. Portable EXE Wrapper (Custom Go + WebView2)

### Approach
Minimal Go binary that:
1. Extracts embedded `dist/` to `%TEMP%\evol-eye\` (or runs from memory)
2. Starts embedded HTTP server on random port (`http://127.0.0.1:PORT/`)
3. Launches **WebView2** (Microsoft Edge rendering engine) pointing to that URL
4. Handles window lifecycle, IPC via WebView2 → Go bridge

### Tech stack
- **Language:** Go (single binary, cross-compile to Windows)
- **GUI:** `webview2` (Microsoft's official Go binding) or `wails` framework
- **Embedding:** `embed.FS` for `dist/` assets
- **Server:** Go `net/http` (serves embedded `dist/`)

### Measured Output (estimated)
| Metric | Value |
|---|---|
| **Binary size** | 8-15 MB (Go + WebView2 loader) |
| **Installed size** | 15-25 MB (no Chromium bundled) |
| **Build time (CI)** | 1-2 min (Go cross-compile) |
| **Signing** | Standard Go binary signing (same cert process) |
| **Auto-update** | Custom: check GitHub releases API → download new `.exe` → replace |
| **Runtime** | WebView2 (system-provided on Win11, optional on Win10) |
| **Browser engine** | WebView2 = Microsoft Edge (Chromium-based, system-shared) |

### Pros
- **Tiny** (10-15 MB download vs 100 MB)
- No bundled Chromium (uses system WebView2)
- Go binary = smaller attack surface than Electron (no Node, no V8 in process)
- Fast CI builds
- Native Windows feel (uses Edge rendering)

### Cons
- **WebView2 dependency** — Win11 has it; Win10 needs Evergreen Bootstrapper (~1.5 MB, auto-installs)
- Custom auto-update implementation (but simple: check GitHub API → download → replace)
- Slightly more dev effort (custom wrapper vs `electron-builder` config)
- Must handle WebView2 version compatibility

---

## 3. Comparison Table

| Factor | electron-builder | Portable (Go + WebView2) |
|---|---|---|
| **Download size** | 85-110 MB | **8-15 MB** |
| **Install size** | 200-280 MB | **15-25 MB** |
| **CI build time** | 3-5 min | **1-2 min** |
| **Code signing** | Standard (needs cert) | Standard (needs cert) |
| **Auto-update** | Built-in (electron-updater) | Custom (GitHub API → replace) |
| **User deps** | None | WebView2 (Win11 ✅, Win10 auto-install) |
| **Attack surface** | Chromium + Node + V8 | WebView2 + Go (smaller) |
| **Binary control** | Limited (Electron internals) | **Full** (your Go code) |
| **Ecosystem maturity** | Very high | Growing (wails, webview2) |
| **Billy's call: size ceiling** | ❌ fails <50 MB | ✅ passes <50 MB |
| **Billy's call: signing** | Same | Same |
| **Billy's call: auto-update** | Built-in | Custom (1 day work) |
| **Billy's call: Win10 support** | ✅ | ✅ (with bootstrapper) |
| **Billy's call: WebView2** | N/A | ✅ acceptable? |

---

## 4. Recommendation

### If Billy says **"under 50 MB, auto-update required, Win10+ ok"** → **Portable Go + WebView2**
- Meets size ceiling easily
- Auto-update is ~1 day to implement (GitHub releases API)
- WebView2 is standard on Win11, auto-installs on Win10

### If Billy says **"standard Electron is fine, size doesn't matter, need fastest dev"** → **electron-builder**
- Zero custom code for updates
- But 100 MB download

### If Billy says **"no code signing cert available"** → either works with self-signed (SmartScreen warning either way)

### If Billy says **"WebView2 is a blocker"** → electron-builder (bundles Chromium)

---

## 5. Billy's 5 Decision Points

| # | Question | Portable (Go) | Electron |
|---|---|---|---|
| 1 | **Size ceiling?** | ✅ <20 MB | ❌ ~100 MB |
| 2 | **Code signing cert available?** | Needs cert for clean UX | Needs cert for clean UX |
| 3 | **Auto-update required at launch?** | Custom impl (~1 day) | Built-in |
| 4 | **Target Windows versions?** | Win10+ (WebView2 auto-installs) | Win7+ (bundled Chromium) |
| 4 | **WebView2 dependency acceptable?** | **Your call** — Win11 native, Win10 auto-installs | N/A |

---

## 6. Next Steps

1. **Billy answers the 5 questions** → decision locked
2. **Toby** produces proof-of-concept for chosen approach (1-2 days)
3. **Big Pickle** implements full installer + GitHub Actions workflow
4. **Hackerman** security reviews binary (hardening, no RCE, signature verification)
5. **Specs** QA: builds .exe, runs it, verifies app loads, no console errors

---

## 7. Quick PoC (if Portable chosen) — 30 min spike

```go
// main.go — minimal WebView2 launcher
package main

import (
    "embed"
    "log"
    "net/http"
    "github.com/webview/webview"
)

//go:embed dist/*
var assets embed.FS

func main() {
    // Serve embedded dist/
    go func() {
        http.Handle("/", http.FileServer(http.FS(assets)))
        log.Fatal(http.ListenAndServe("127.0.0.1:0", nil))
    }()

    // Launch WebView2 window
    w := webview.New(true)
    defer w.Destroy()
    w.SetTitle("Evol Eye")
    w.SetSize(1280, 800, webview.HintNone)
    w.Navigate("http://127.0.0.1:<port>/") // dynamic port
    w.Run()
}
```

---

*Prepared by PM (PM did the spike — Toby's local model timed out). Ready for Billy's 5 decisions.*