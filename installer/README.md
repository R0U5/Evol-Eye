# EVOL Eye — Installer for Dummies

A zero-prerequisite way to get EVOL Eye running on a Windows, macOS, or Linux
machine. No source cloning, no manual Node setup, no command line required.

## What it does

1. **Bootstraps a Node.js runtime** — if your machine has no usable Node, the
   installer downloads an official, checksum-verified Node.js and stores it next
   to itself in `.evol-runtime/`. A system Node that is recent enough is reused.
2. **Starts a local installer** — a small server bound to `127.0.0.1` opens your
   browser to a guided UI.
3. **Downloads the app from GitHub** — the source archive for
   `R0U5/Evol-Eye` is pulled, verified, and extracted into your chosen folder.
4. **Installs dependencies** — `npm install` runs inside the extracted app.
5. **Builds and installs** — the production bundle is compiled with Vite.
6. **Writes a launcher** — a double-clickable `EVOL Eye.cmd` /
   `Evol-Eye.sh` + an optional desktop shortcut start the app on
   http://127.0.0.1:4173/ using a bundled private Node runtime when present.

## The "extracted exe"

The installer produces a native launcher rather than a compiled binary. The
launcher is a tiny script that pins the bundled Node and runs `vite preview`
against the built app. A real single-file `.exe` is possible later with
`pkg`/`nexe`-style bundling of this launcher; none of the generated files need
to change when that is introduced.

## Private repo, public later

While the repository is private, the source download needs read access:

- Either paste a GitHub fine-grained token (contents: **Read**) into the
  installer UI — the token is kept **in memory only** and is never written to
  disk — or
- start the server with `--token <token>` / `EVOL_INSTALLER_TOKEN`.

The download URL is the same GitHub archive URL in both cases. To go public,
edit `manifest.json` in this bundle, set `repoIsPrivate` to `false`, and
rebuild — nothing else changes.

## Running the installer

- **Windows:** unzip, then double-click `bootstrap.cmd`.
- **macOS / Linux:** `./bootstrap.sh`.

Both check/replace Node as needed, start the installer service, and open the
browser.

## Building the release bundle

`npm run installer:build` writes `dist-installer/Evol-Eye-Setup-<version>.zip`
plus `SHA256SUMS.txt` and `installer.json`. The same archive is published
automatically to GitHub Releases by `.github/workflows/installer.yml` on a
`installer-v*` tag (or manual dispatch).

## Developing

- `node installer/server.mjs --port 8787` — run the installer server locally
  (UI at http://127.0.0.1:8787).
- `npm run installer:test` — unit + fixture end-to-end tests.
- Security: the server binds to loopback, rejects non-loopback peers,
  cross-origin requests, and unknown `Host` headers, and never echoes the
  token. Only `localhost`, `127.0.0.1`, and `[::1]` are accepted clients.