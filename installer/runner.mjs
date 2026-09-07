import { createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as cp from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INSTALLER_VERSION,
  normalizeManifest,
  resolveSourceUrl,
  authHeaders,
  satisfiesNodeVersion,
  nodeDistSpec,
  sanitizeInstallDir,
  resolveAppPort,
  defaultInstallDir,
} from './core.mjs';
import { unzipToDisk, parseZip } from './zipcode.mjs';

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));

export class InstallError extends Error {
  constructor(message, code = 'INSTALL') {
    super(message);
    this.name = 'InstallError';
    this.code = code;
  }
}

export function defaultDeps() {
  return {
    fetch,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    env: process.env,
    unzipToDisk,
    parseZip,
    zipBuffer: (file) => fsp.readFile(file),
    mkdir: (dir) => fsp.mkdir(dir, { recursive: true }),
    rm: (target) => fsp.rm(target, { recursive: true, force: true }),
    rename: (from, to) => fsp.rename(from, to),
    writeFile: fsp.writeFile,
    copyFile: fsp.copyFile,
    isFile: (file) => fsp.stat(file).then(() => true).catch(() => false),
    spawn: cp.spawn,
  };
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    throw new InstallError('Installation cancelled', 'CANCELLED');
  }
}

function execSpooled(command, args, options, emit, signal) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell === true,
      windowsHide: true,
    });
    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let buffer = '';
    const pump = (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '').trim();
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) emit({ type: 'log', level: 'info', text: line.slice(0, 4000) });
      }
    };
    child.stdout?.on('data', pump);
    child.stderr?.on('data', pump);
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      const tail = buffer.replace(/\r$/, '').trim();
      if (tail.length > 0) emit({ type: 'log', level: 'info', text: tail.slice(0, 4000) });
      if (signal?.aborted) {
        reject(new InstallError('Installation cancelled', 'CANCELLED'));
      } else {
        resolve(code);
      }
    });
  });
}

async function downloadToFile(url, destFile, { headers, signal, emit, stepId, deps }) {
  const res = await deps.fetch(url, { headers, signal, redirect: 'follow' });
  if (!res.ok) {
    const forbidden = res.status === 401 || res.status === 403 || res.status === 404;
    throw new InstallError(
      `Download failed (HTTP ${res.status}) for ${url}`,
      forbidden ? 'DOWNLOAD_NEEDS_TOKEN' : 'DOWNLOAD_FAILED',
    );
  }
  const total = Number(res.headers.get('content-length')) || 0;
  await fsp.mkdir(path.dirname(destFile), { recursive: true });
  const out = createWriteStream(destFile);
  let received = 0;
  try {
    const reader = res.body?.getReader();
    if (!reader) {
      const buf = Buffer.from(await res.arrayBuffer());
      await new Promise((resolveStore, rejectStore) => {
        out.on('error', rejectStore);
        out.end(buf, () => resolveStore());
      });
      emit({ type: 'progress', stepId, received: buf.length, total: buf.length });
      return buf.length;
    }
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(value)) {
        await new Promise((r) => out.once('drain', r));
      }
      emit({ type: 'progress', stepId, received, total });
    }
    await new Promise((resolveStore, rejectStore) => {
      out.on('error', rejectStore);
      out.end(() => resolveStore());
    });
    return received;
  } catch (err) {
    out.destroy();
    await fsp.rm(destFile, { force: true }).catch(() => {});
    throw err;
  }
}

export function deduceRepoRoot(filePaths) {
  const tops = new Set();
  let hasRootPackage = false;
  for (const p of filePaths) {
    if (p === 'package.json') hasRootPackage = true;
    const slash = p.indexOf('/');
    tops.add(slash === -1 ? '' : p.slice(0, slash));
    if (tops.size > 2) break;
  }
  tops.delete('');
  if (hasRootPackage) return '';
  if (tops.size === 1) return [...tops][0];
  return null;
}

async function extractSourceArchive(archiveBuf, stagingDir, deps) {
  const files = [];
  await deps.unzipToDisk(archiveBuf, stagingDir, (info) => files.push(info.name));
  const root = deduceRepoRoot(files);
  if (root === null) {
    throw new InstallError('The downloaded archive does not look like the repo (unexpected layout)', 'BAD_ARCHIVE');
  }
  return root;
}

async function tryReuseRuntimeRoot(candidateRoot, dist, deps) {
  if (!candidateRoot || typeof candidateRoot !== 'string') return null;
  const root = path.resolve(candidateRoot);
  const nodeExe = path.join(root, dist.binRel);
  const npmCli = path.join(root, dist.npmRel);
  if (!(await deps.isFile(nodeExe)) || !(await deps.isFile(npmCli))) return null;
  return { type: 'bundled', nodeExe, npmCli };
}

async function extractRuntimeArchive(deps, spec, archiveBuf, unpackDir, runtimeRoot, emit) {
  if (spec.format === 'zip') {
    await deps.unzipToDisk(archiveBuf, unpackDir);
  } else {
    const tarPath = path.join(unpackDir, '.runtime.tar.gz');
    await deps.mkdir(unpackDir);
    await deps.writeFile(tarPath, archiveBuf);
    const code = await execSpooled('tar', ['-xzf', tarPath, '-C', unpackDir], { cwd: unpackDir, env: deps.env }, emit, undefined);
    if (code !== 0) throw new InstallError('Failed to unpack the Node.js runtime', 'BAD_RUNTIME');
  }
  const unpacked = path.join(unpackDir, spec.topDir);
  if (!(await deps.isFile(path.join(unpacked, spec.binRel)))) {
    throw new InstallError('Node.js runtime archive had an unexpected layout', 'BAD_RUNTIME');
  }
  await deps.mkdir(path.dirname(runtimeRoot));
  await deps.rm(runtimeRoot);
  await deps.rename(unpacked, runtimeRoot);
}

function sha256LineMatch(lines, fileName) {
  for (const line of lines) {
    const match = /^([0-9a-fA-F]{64})  (\*?.+)$/.exec(line.trim());
    if (!match) continue;
    if (match[2].replace(/^\*/, '') === fileName) return match[1].toLowerCase();
  }
  return null;
}

async function verifyRuntimeShasum(dist, shasumsUrl, archiveBuf, emit, signal, deps) {
  const res = await deps.fetch(shasumsUrl, { signal, redirect: 'follow' });
  if (!res.ok) throw new InstallError(`Could not fetch Node.js checksums (HTTP ${res.status})`, 'SHASUM_UNAVAILABLE');
  const body = await res.text();
  const expected = sha256LineMatch(body.split(/\r?\n/), dist.archiveFile);
  if (!expected) throw new InstallError('Node.js checksum file did not list the runtime archive', 'SHASUM_MISSING');
  const actual = createHash('sha256').update(archiveBuf).digest('hex');
  if (actual !== expected) throw new InstallError('Node.js runtime checksum mismatch', 'SHA_MISMATCH');
  emit({ type: 'log', level: 'info', text: `Runtime checksum verified (sha256 ${expected.slice(0, 12)}…)` });
}

async function resolveSystemNpmCli(deps) {
  const execDir = path.dirname(deps.execPath);
  const candidates = deps.platform === 'win32'
    ? [path.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [path.join(execDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const candidate of candidates) {
    if (await deps.isFile(candidate)) return candidate;
  }
  return null;
}

async function runNpm(nodeExe, npmCliPath, appDir, args, deps, emit, signal) {
  const useCli = npmCliPath !== null;
  const command = useCli ? nodeExe : 'npm';
  const full = useCli ? [npmCliPath, ...args] : args;
  emit({ type: 'log', level: 'info', text: `> ${command} ${full.join(' ').slice(0, 400)}` });
  const code = await execSpooled(command, full, {
    cwd: appDir,
    env: deps.env,
    shell: !useCli && deps.platform === 'win32',
  }, emit, signal);
  if (code !== 0) throw new InstallError(`${command} exited with code ${code}`, 'SUB_COMMAND_FAILED');
}

async function createDesktopShortcut(installDir, deps, emit) {
  if (deps.platform !== 'win32' || !deps.env.USERPROFILE) return;
  const desktop = path.join(deps.env.USERPROFILE, 'Desktop');
  const linkPath = path.join(desktop, "Devil's Eye.lnk");
  const cmdPath = path.join(installDir, 'Devils Eye.cmd');
  const script = [
    'New-Item -ItemType Directory -Force -Path ' + JSON.stringify(desktop) + ' | Out-Null;',
    '$s=(New-Object -ComObject WScript.Shell).CreateShortcut(' + JSON.stringify(linkPath) + ');',
    '$s.TargetPath=' + JSON.stringify(cmdPath) + ';',
    '$s.WorkingDirectory=' + JSON.stringify(installDir) + ';',
    '$s.Save();',
  ].join(' ');
  try {
    await execSpooled('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { cwd: installDir, env: deps.env }, emit, undefined);
    emit({ type: 'log', level: 'info', text: `Desktop shortcut created: ${linkPath}` });
  } catch (err) {
    emit({ type: 'log', level: 'warn', text: `Could not create a desktop shortcut: ${err.message}` });
  }
}

function launcherAssets(platform) {
  const common = ['launcher-app.mjs'];
  common.push(platform === 'win32' ? 'Devils Eye.cmd' : 'Devils-Eye.sh');
  return common;
}

export async function runInstall(options) {
  const manifest = normalizeManifest(options.manifest ?? {});
  const emit = options.emit ?? (() => {});
  const signal = options.signal ?? undefined;
  const deps = options.deps ?? defaultDeps();
  const overrides = options.overrides ?? {};

  const installDir = sanitizeInstallDir(
    overrides.installDir || defaultInstallDir(deps.platform, deps.env),
  );
  if (!installDir) throw new InstallError('A valid install directory is required', 'BAD_INSTALL_DIR');

  const appPort = resolveAppPort(manifest, overrides);
  const mode = overrides.mode === 'development' ? 'development' : 'production';
  const build = mode === 'production' && overrides.build !== false;
  const bundleNode = overrides.bundleNode !== undefined ? Boolean(overrides.bundleNode) : true;

  const nodeVersion = process.versions?.node || '';
  const systemOk = nodeVersion ? satisfiesNodeVersion(nodeVersion, manifest.minNodeVersion) : false;

  const sourceUrl = resolveSourceUrl(manifest, overrides);
  const headers = authHeaders(overrides.token);

  const appDir = path.join(installDir, 'app');
  const runtimeRoot = path.join(installDir, 'runtime', 'node');
  const stageBase = path.join(installDir, `.gev-stage-${process.pid}-${Date.now()}`);

  let runtimeInfo = { type: 'system', nodeExe: deps.execPath, npmCli: null };

  try {
    throwIfAborted(signal);
    await deps.mkdir(installDir);
    await deps.mkdir(stageBase);

    emit({ type: 'step', id: 'source', state: 'active' });
    const tempSource = path.join(stageBase, 'source.zip');
    emit({ type: 'log', level: 'info', text: `Downloading ${sourceUrl}` });
    const sourceBytes = await downloadToFile(sourceUrl, tempSource, { headers, signal, emit, stepId: 'source', deps });
    emit({ type: 'log', level: 'info', text: `Downloaded ${sourceBytes} bytes` });
    emit({ type: 'step', id: 'source', state: 'done' });

    emit({ type: 'step', id: 'extract', state: 'active' });
    const archiveBuf = await deps.zipBuffer(tempSource);
    const artifact = deps.parseZip(archiveBuf);
    if (artifact.entries.length === 0) throw new InstallError('The downloaded archive is empty', 'BAD_ARCHIVE');
    const stagingDir = path.join(stageBase, 'unpack');
    await deps.mkdir(stagingDir);
    const root = await extractSourceArchive(archiveBuf, stagingDir, deps);
    const unpackedRoot = root === '' ? stagingDir : path.join(stagingDir, root);
    if (!(await deps.isFile(path.join(unpackedRoot, 'package.json')))) {
      throw new InstallError('The downloaded archive has no package.json; is the repo reachable?', 'BAD_ARCHIVE');
    }
    await deps.rm(appDir);
    await deps.rename(unpackedRoot, appDir);
    emit({ type: 'log', level: 'info', text: `App extracted to ${appDir}` });
    emit({ type: 'step', id: 'extract', state: 'done' });

    emit({ type: 'step', id: 'runtime', state: 'active' });
    if (bundleNode) {
      const dist = nodeDistSpec(manifest.recommendedNodeVersion, deps.platform, deps.arch);
      const reused = await tryReuseRuntimeRoot(overrides.reuseRuntimeRoot, dist, deps);
      if (reused) {
        runtimeInfo = reused;
        emit({ type: 'log', level: 'info', text: `Reusing the runtime that started the installer (${reused.nodeExe})` });
      } else {
        const distBase = overrides.runtimeDistBase || null;
        const distUrl = distBase ? `${distBase}/${dist.archiveFile}` : dist.url;
        const shasumsUrl = distBase ? `${distBase}/SHASUMS256.txt` : dist.shasumsUrl;
        emit({ type: 'log', level: 'info', text: `Downloading Node.js ${manifest.recommendedNodeVersion} (${dist.archiveName})` });
        const runtimeZipFile = path.join(stageBase, 'runtime.zip');
        await downloadToFile(distUrl, runtimeZipFile, { headers: {}, signal, emit, stepId: 'runtime', deps });
        const runtimeArchiveBuf = await deps.zipBuffer(runtimeZipFile);
        await verifyRuntimeShasum(dist, shasumsUrl, runtimeArchiveBuf, emit, signal, deps);
        const unpackDir = path.join(stageBase, 'runtime-unpack');
        await deps.mkdir(unpackDir);
        await extractRuntimeArchive(deps, dist, runtimeArchiveBuf, unpackDir, runtimeRoot, emit);
        runtimeInfo = {
          type: 'bundled',
          nodeExe: path.join(runtimeRoot, dist.binRel),
          npmCli: path.join(runtimeRoot, dist.npmRel),
        };
        emit({ type: 'log', level: 'info', text: `Bundled runtime ready at ${runtimeInfo.nodeExe}` });
      }
    } else {
      const npmCli = await resolveSystemNpmCli(deps);
      runtimeInfo = { type: 'system', nodeExe: deps.execPath, npmCli };
      emit({ type: 'log', level: 'info', text: `Using system Node.js${nodeVersion ? ` v${nodeVersion}` : ''}${npmCli ? '' : ' (npm resolved from PATH)'}` });
    }
    emit({ type: 'step', id: 'runtime', state: 'done' });

    emit({ type: 'step', id: 'deps', state: 'active' });
    await runNpm(runtimeInfo.nodeExe, runtimeInfo.npmCli, appDir, ['install', '--no-audit', '--no-fund'], deps, emit, signal);
    emit({ type: 'step', id: 'deps', state: 'done' });

    if (build) {
      emit({ type: 'step', id: 'build', state: 'active' });
      await runNpm(runtimeInfo.nodeExe, runtimeInfo.npmCli, appDir, ['run', 'build'], deps, emit, signal);
      emit({ type: 'step', id: 'build', state: 'done' });
    }

    emit({ type: 'step', id: 'ready', state: 'active' });
    for (const asset of launcherAssets(deps.platform)) {
      await deps.copyFile(path.join(runtimeDir, asset), path.join(installDir, asset));
    }
    const meta = {
      appDir: 'app',
      appPort,
      mode,
      installedAt: new Date().toISOString(),
      installerVersion: INSTALLER_VERSION,
      node: runtimeInfo.type,
      sourceUrl,
    };
    await deps.writeFile(path.join(installDir, '.gev-install.json'), JSON.stringify(meta, null, 2) + '\n');
    if (overrides.shortcut !== false) {
      await createDesktopShortcut(installDir, deps, emit);
    }
    emit({ type: 'step', id: 'ready', state: 'done' });

    emit({
      type: 'done',
      summary: { installDir, appDir, appPort, mode, node: runtimeInfo.type },
    });
  } finally {
    await deps.rm(stageBase).catch(() => {});
  }
}

export async function launchApp(installDir, deps = defaultDeps()) {
  const appDirectory = path.resolve(installDir);
  const launcher = path.join(appDirectory, 'launcher-app.mjs');
  if (!(await deps.isFile(launcher))) {
    throw new InstallError('No launcher found for that installation', 'NO_LAUNCHER');
  }
  const bundled = path.join(appDirectory, 'runtime', 'node', deps.platform === 'win32' ? 'node.exe' : 'bin/node');
  let nodeExe = deps.execPath;
  if (await deps.isFile(bundled)) nodeExe = bundled;
  const child = cp.spawn(nodeExe, [launcher], {
    cwd: appDirectory,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid };
}