# Big Pickle — SPRINT: Devils-Eye Windows EXE Installer

**Repo:** `~/.openclaw/workspace/Devils-Eye` | **Branch:** cut `feat/exe-installer` off `main`

## Context
The Devils-Eye web app currently ships as a Vite bundle in `dist/` (static assets). Goal: produce a **single-file Windows .exe** that users can download and run — no Node, no browser, no install friction.

Groundwork exists:
- `installer/bootstrap.cmd` — bootstraps the environment
- `installer/Evol-Eye.sh` — Unix launcher
- `installer/ensure-runtime.ps1` — PowerShell runtime check
- `dist/` — Vite production build output (ready to embed)
- `package.json` — scripts and dependencies

## The Decision (Billy must weigh in)
Two approaches, different tradeoffs:

| | electron-builder | Portable exe wrapper |
|---|---|---|
| **What** | Full Electron app embedding `dist/` + Node runtime | Custom C++/Go/Rust wrapper that launches a local HTTP server + embedded browser |
| **Size** | ~80-120 MB | ~15-30 MB |
| **Signing** | Standard Electron code-signing | Custom binary signing |
| **Auto-update** | electron-updater built-in | Custom implementation |
| **Dev effort** | Well-documented, standard | Custom, more control |
| **Node dependency** | Bundled (user doesn't need Node) | None if pure wrapper + embedded browser (WebView2) |
| **Browser engine** | Chromium (bundled) | WebView2 (system) or bundled Chromium |

**Billy's call needed:** target/signing requirements, size budget, auto-update requirements. If unsure, Toby will spike both and present a 1-page comparison.

## Your Job (Big Pickle)
1. **If Billy's decision is clear:** implement the chosen approach, commit, test locally.
2. **If Billy needs info:** Toby spikes both (see below), you implement after decision.
3. **Scope:** `installer/` + `dist/` + any new build scripts. Do NOT touch `src/` app logic.
4. **Output:** a GitHub Actions workflow (`.github/workflows/installer.yml`) that builds the `.exe` on push/tag, uploads as release artifact.
4. **Test:** the `.exe` launches, loads the app, no console errors.

## Constraints
- Single commit per approach (or series), conventional commits.
- Scope: `installer/`, `.github/workflows/`, `package.json` (build scripts), new wrapper source if any.
- `npm test` must stay green (2796/0/1).
- DO NOT push to `main` — PM merges after Specs sign-off.
- Report DONE: approach chosen, files changed, build command, test results.

## Team Assignments
- **Big Pickle (you):** implementation
- **Hackerman:** security review of the installer (code signing, auto-update integrity, binary hardening, no RCE surface)
- **Toby:** recon — spike both approaches if Billy undecided; produce 1-page comparison (size, signing, update, effort, user experience)
- **Specs:** QA gate — build the installer, run the .exe, verify it works, sign off

## Billy's Input Needed (Toby will ask)
1. Size ceiling? (e.g., "under 50MB" → rules out full Electron)
2. Code signing cert available? (org cert, or self-signed with SmartScreen warning acceptable?)
3. Auto-update required at launch? (or manual re-download OK for v1?)
4. Target Windows versions? (Win10+, Win11 only?)
5. WebView2 dependency acceptable? (installed by default on Win11, optional on Win10)