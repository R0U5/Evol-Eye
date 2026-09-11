#!/usr/bin/env node
// EVOL Eye — portable .exe build orchestrator (Go + WebView2 wrapper).
//
// Builds the single-file Windows executable that embeds the production web
// bundle (dist/), plus the headless selftest binary, and runs the selftest.
//
//   npm run installer:exe                  # stage + selftest + windows exe
//   npm run installer:exe -- --selftest-only
//   npm run installer:exe -- --exe-only
//   npm run installer:exe -- --go /path/to/go --zig /path/to/zig --out dist-installer
//
// Environment overrides: GO, GOOS, GOARCH, ZIG.
//
// The Go module pins github.com/webview/webview_go 0.10.0, vendored under
// installer/vendor/ with a patch that restores the WebView2 SDK's missing
// EventToken.h (upstream webview_go issue #21). The exe embeds dist/ by
// staging it into installer/app/ (embed patterns cannot reach ../dist).

import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const distDir = path.join(repo, 'dist');
const outDir = path.resolve(path.join(repo, 'dist-installer'));

const EXE_NAME = 'Evol-Eye-Installer.exe';
const SELFTEST_NAME = process.platform === 'win32'
  ? 'Evol-Eye-Selftest.exe'
  : 'Evol-Eye-Selftest';

const GOOS = process.env.GOOS || 'windows';
const GOARCH = process.env.GOARCH || 'amd64';

const CLIENT = {
  get GO() { return process.env.GO || 'go'; },
  get ZIG() { return process.env.ZIG || 'zig'; },
};

function hostGoOS() {
  switch (process.platform) {
    case 'win32': return 'windows';
    case 'darwin': return 'darwin';
    default: return 'linux';
  }
}

function parseArgs(argv) {
  const out = { selftestOnly: false, exeOnly: false, out: outDir };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest-only') out.selftestOnly = true;
    else if (a === '--exe-only') out.exeOnly = true;
    else if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--go') process.env.GO = argv[++i];
    else if (a === '--zig') process.env.ZIG = argv[++i];
  }
  return out;
}

async function exec(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, ...opts }, (err, so, se) => {
      if (err) {
        err.output = (se || so || '').toString().trim();
        reject(err);
      } else {
        resolve({ so: (so || '').toString(), se: (se || '').toString() });
      }
    });
  });
}

async function verifyGo() {
  const { so } = await exec(CLIENT.GO, ['version']);
  const m = /go1\.(\d+)/.exec(so);
  if (!m || Number(m[1]) < 23) {
    throw new Error(`Go 1.23+ required (found '${so.trim()}')`);
  }
}

function crossToolchainEnv() {
  // Cross-compiling CGo needs a Windows-targeted C/C++ compiler. Zig's
  // bundled clang targets x86_64-windows-gnu out of the box (mingw-compatible
  // libs for the -ladvapi32 … flags the webview binding links against).
  return {
    CC: `${CLIENT.ZIG} cc -target x86_64-windows-gnu`,
    CXX: `${CLIENT.ZIG} c++ -target x86_64-windows-gnu`,
  };
}

function buildEnv() {
  const env = { ...process.env, GOOS, GOARCH, CGO_ENABLED: '1' };
  if (GOOS !== hostGoOS()) Object.assign(env, crossToolchainEnv());
  return env;
}

function stageAppBundle() {
  const targets = [path.join(here, 'app'), path.join(here, 'selftest', 'app')];
  if (!fs.existsSync(distDir)) {
    throw new Error(`no web bundle at ${distDir} — run 'npm run build' first`);
  }
  for (const t of targets) {
    fs.rmSync(t, { recursive: true, force: true });
    fs.cpSync(distDir, t, { recursive: true });
  }
}

async function buildSelftest(bin) {
  await exec(CLIENT.GO, ['build', '-mod=vendor', '-buildvcs=false', '-o', bin, '.'], {
    cwd: path.join(here, 'selftest'),
  });
  // Headless verification: starts the loopback server, probes the embedded
  // bundle over HTTP, prints a report and exits 0 on success / 1 on failure.
  await exec(bin, [], { cwd: outDir });
}

async function buildSelftestWin(bin) {
  const env = { ...process.env, GOOS, GOARCH };
  await exec(CLIENT.GO, ['build', '-mod=vendor', '-buildvcs=false', '-o', bin, '.'], {
    cwd: path.join(here, 'selftest'),
    env,
  });
}

async function buildExe(exe) {
  const args = ['build', '-mod=vendor', '-buildvcs=false'];
  if (GOOS !== hostGoOS()) {
    args.push('-ldflags=-extldflags=-Wl,--subsystem,windows');
  }
  args.push('-o', exe, '.');
  await exec(CLIENT.GO, args, { cwd: here, env: buildEnv() });
}

function verifyPE(exe) {
  const buf = fs.readFileSync(exe);
  if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) {
    throw new Error(`${exe} is not a PE executable (bad magic)`);
  }
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 4 > buf.length ||
      buf[peOff] !== 0x50 || buf[peOff + 1] !== 0x45 ||
      buf[peOff + 2] !== 0x00 || buf[peOff + 3] !== 0x00) {
    throw new Error(`${exe} has no PE header`);
  }
  return buf.length;
}

function sha256Hex(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function writeSums(files) {
  const lines = files.map((f) => `${sha256Hex(f)} *${path.basename(f)}`);
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.out, { recursive: true });
  const doSelftest = opts.selftestOnly || (!opts.exeOnly && !opts.selftestOnly);
  const doExe = opts.exeOnly || (!opts.exeOnly && !opts.selftestOnly);

  try {
    await verifyGo();
    console.log(`evol-eye installer: go ${GOOS}/${GOARCH}, out=${opts.out}`);

    if (doSelftest) {
      console.log('evol-eye installer: staging web bundle (selftest)…');
      stageAppBundle();
      console.log('evol-eye installer: building + running selftest…');
      const bin = path.join(opts.out, SELFTEST_NAME);
      await buildSelftest(bin);
      console.log('evol-eye installer: selftest PASS');
      // Cross-builds need a Windows verifier for the smoke job: the selftest
      // is pure Go (no CGo), so it cross-compiles without a C toolchain.
      if (GOOS !== hostGoOS()) {
        console.log('evol-eye installer: cross-building Windows selftest…');
        const winBin = path.join(opts.out, 'Evol-Eye-Selftest.exe');
        await buildSelftestWin(winBin);
        console.log('evol-eye installer: Windows selftest built');
      }
    }

    const artifacts = [];
    if (doExe) {
      if (!doSelftest) {
        console.log('evol-eye installer: staging web bundle…');
        stageAppBundle();
      }
      console.log(`evol-eye installer: building ${EXE_NAME}…`);
      const exe = path.join(opts.out, EXE_NAME);
      await buildExe(exe);
      const bytes = verifyPE(exe);
      console.log(`evol-eye installer: OK ${EXE_NAME} (${(bytes / 1048576).toFixed(1)} MiB)`);
      artifacts.push(exe);
    }

    if (artifacts.length > 0) await writeSums(artifacts);
    console.log('evol-eye installer: done');
  } catch (err) {
    console.error(`evol-eye installer: FAILED — ${err.message}`);
    if (err.output) console.error(err.output);
    process.exitCode = 1;
  }
}

await main();