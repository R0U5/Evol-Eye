import http from 'node:http';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  INSTALLER_VERSION,
  DEFAULT_INSTALLER_PORT,
  normalizeManifest,
  resolveSourceUrl,
  sanitizeInstallDir,
  defaultInstallDir,
  buildDependencyItems,
  classifyReachability,
  INSTALL_STEPS,
  MIN_NODE_VERSION,
} from './core.mjs';
import { runInstall, launchApp } from './runner.mjs';
import * as core from './core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const MAX_BODY = 64 * 1024;
const LOOPBACK_PEERS = new Set(['::1', '127.0.0.1', '::ffff:127.0.0.1']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function admitInstallerRequest({ remoteAddress, host, origin, referer, hostOverride }) {
  if (hostOverride && hostOverride !== '127.0.0.1') {
    return { allowed: true, reason: 'explicit-host' };
  }
  if (!LOOPBACK_PEERS.has(remoteAddress)) {
    return { allowed: false, reason: 'non-loopback peer' };
  }
  const hostMatch = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host || '');
  if (!hostMatch) {
    return { allowed: false, reason: 'host header mismatch' };
  }
  for (const headerValue of [origin, referer]) {
    if (!headerValue) continue;
    if (/^file:/.test(headerValue)) continue;
    let hostname = null;
    try {
      hostname = new URL(headerValue).host;
    } catch {
      return { allowed: false, reason: 'invalid origin' };
    }
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(hostname || '')) {
      return { allowed: false, reason: 'cross-origin request' };
    }
  }
  return { allowed: true, reason: 'loopback' };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

async function detectPython() {
  for (const command of ['python', 'python3']) {
    try {
      const result = await new Promise((resolve) => {
        execFile(command, ['--version'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
          resolve(err ? null : (stdout || stderr).trim());
        });
      });
      if (result) return result.replace(/^Python\s+/i, '');
    } catch {
      /* command failed */
    }
  }
  return null;
}

function buildPlan(context) {
  const { manifest, opts } = context;
  const items = buildDependencyItems({
    platform: process.platform,
    arch: process.arch,
    nodeVersion: context.nodeVersion,
    pythonVersion: context.pythonVersion,
  });
  return {
    ok: true,
    kind: 'plan',
    installerVersion: INSTALLER_VERSION,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: context.nodeVersion,
    nodeSatisfiesMin: context.nodeSatisfiesMin,
    reachability: context.reachability ?? 'untested',
    pythonVersion: context.pythonVersion,
    defaults: {
      installDir: defaultInstallDir(process.platform),
      appPort: manifest.appPort,
      bundleNode: true,
    },
    manifest: {
      name: manifest.name,
      owner: manifest.owner,
      repo: manifest.repo,
      defaultBranch: manifest.defaultBranch,
      repoIsPrivate: manifest.repoIsPrivate,
      homepage: manifest.homepage,
      appPort: manifest.appPort,
    },
    steps: INSTALL_STEPS,
    deps: items,
  };
}

async function readManifestFile(manifestPath) {
  if (!manifestPath) return { ...core.DEFAULT_MANIFEST };
  try {
    return normalizeManifest(JSON.parse(await fsp.readFile(manifestPath, 'utf8')));
  } catch (err) {
    throw new Error(`Cannot read installer manifest at ${manifestPath}: ${err.message}`);
  }
}

async function resolveManifestPath(flags) {
  if (flags.get('manifest')) return String(flags.get('manifest'));
  const candidate = path.join(here, 'manifest.json');
  try {
    await fsp.access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

export function bootstrapRuntimeRoot() {
  const marker = process.env.GEV_BOOTSTRAP_NODE;
  if (!marker) return null;
  if (path.resolve(marker) !== process.execPath) return null;
  const walk = process.platform === 'win32' ? null : 'bin' + path.sep + 'node';
  const base = path.dirname(process.execPath);
  return walk && base.endsWith(path.sep + walk) ? path.dirname(base) : base;
}

export async function createInstallerServer(options = {}) {
  const manifest = normalizeManifest(options.manifest ?? { ...core.DEFAULT_MANIFEST });
  const port = options.port ?? manifest.installerPort ?? DEFAULT_INSTALLER_PORT;
  const hostOverride = options.host ?? '127.0.0.1';
  const staticDir = options.staticDir ?? here;
  let serverToken = options.token ?? null;
  const context = {
    manifest,
    opts: { ...options, sourceArchiveUrl: options.sourceArchiveUrl ?? null, runtimeDistBase: options.runtimeDistBase ?? null },
    nodeVersion: process.versions.node,
    nodeSatisfiesMin: core.satisfiesNodeVersion(process.versions.node, MIN_NODE_VERSION),
    pythonVersion: null,
    reachability: 'untested',
    serverToken,
  };

  const ensurePlanInfo = async () => {
    if (context.pythonVersion === null || context.reachability === 'untested') {
      context.pythonVersion = await detectPython();
    }
    if (context.reachability === 'untested') {
      try {
        const url = resolveSourceUrl(context.manifest, { sourceArchiveUrl: context.opts.sourceArchiveUrl });
        const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(12_000) });
        context.reachability = classifyReachability(res.status, context.manifest.repoIsPrivate);
      } catch {
        context.reachability = context.manifest.repoIsPrivate ? 'need-token' : 'error';
      }
    }
  };

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    const admission = admitInstallerRequest({
      remoteAddress: req.socket.remoteAddress,
      host: req.headers.host,
      origin: req.headers.origin,
      referer: req.headers.referer,
      hostOverride,
    });
    if (!admission.allowed) {
      sendJson(res, 403, { error: 'forbidden', reason: admission.reason });
      return;
    }

    try {
      if (req.method === 'GET' && urlPath === '/api/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && urlPath === '/api/plan') {
        await ensurePlanInfo();
        sendJson(res, 200, buildPlan(context));
        return;
      }

      if (req.method === 'POST' && urlPath === '/api/install') {
        const raw = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' });
          return;
        }
        const token = typeof body.token === 'string' && body.token.length > 0 ? body.token.slice(0, 1024) : serverToken;

        let installDir;
        if (typeof body.installDir === 'string' && body.installDir.trim().length > 0) {
          installDir = sanitizeInstallDir(body.installDir.trim());
          if (!installDir) {
            sendJson(res, 400, { error: 'invalid install directory' });
            return;
          }
        }

        const mode = body.mode === 'development' ? 'development' : 'production';
        const overrides = {
          installDir,
          token,
          sourceArchiveUrl: context.opts.sourceArchiveUrl,
          runtimeDistBase: context.opts.runtimeDistBase,
          reuseRuntimeRoot: bootstrapRuntimeRoot(),
          mode,
          build: body.build !== false,
          bundleNode: body.bundleNode !== false,
          shortcut: body.shortcut !== false,
        };

        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.flushHeaders();

        const controller = new AbortController();
        const onClientGone = () => controller.abort();
        res.on('close', onClientGone);

        const emit = (event) => {
          if (!res.destroyed) res.write(JSON.stringify(event) + '\n');
        };

        let summary = null;
        let failed = null;
        try {
          summary = await runInstall({
            manifest: context.manifest,
            overrides,
            emit,
            signal: controller.signal,
          });
        } catch (err) {
          failed = { code: err.code || 'INSTALL', message: err.message };
        }
        res.removeListener('close', onClientGone);
        if (failed) {
          emit({ type: 'error', code: failed.code, message: failed.message });
        }
        emit({ type: 'end', summary });
        res.end();
        return;
      }

      if (req.method === 'POST' && urlPath === '/api/launch') {
        const raw = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' });
          return;
        }
        if (typeof body.installDir !== 'string' || body.installDir.length === 0) {
          sendJson(res, 400, { error: 'installDir is required' });
          return;
        }
        const resolvedDir = sanitizeInstallDir(body.installDir);
        if (!resolvedDir) {
          sendJson(res, 400, { error: 'invalid install directory' });
          return;
        }
        try {
          const launched = await launchApp(resolvedDir);
          sendJson(res, 200, { ok: true, ...launched });
        } catch (err) {
          sendJson(res, 400, { error: err.message, code: err.code });
        }
        return;
      }

      if (req.method === 'GET' && urlPath.startsWith('/api/')) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        const requested = urlPath === '/' ? 'index.html' : urlPath.slice(1);
        const safe = requested.replace(/\\/g, '/').replace(/^\.\.\//g, '');
        const full = path.resolve(staticDir, safe);
        if (!full.startsWith(path.resolve(staticDir) + path.sep)) {
          sendJson(res, 403, { error: 'forbidden' });
          return;
        }
        try {
          const data = await fsp.readFile(full);
          const ext = path.extname(full).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME[ext] ?? 'application/octet-stream',
            'Content-Length': data.length,
            'Cache-Control': 'no-store',
          });
          res.end(req.method === 'HEAD' ? undefined : data);
        } catch {
          sendJson(res, 404, { error: 'not found' });
        }
        return;
      }

      sendJson(res, 405, { error: 'method not allowed' });
    } catch (err) {
      sendJson(res, 500, { error: err.message || String(err) });
    }
  });

  const installDirDefault = options.installDir ?? defaultInstallDir(process.platform);
  server.setMaxListeners(0);

  const validPort = port === 0 || (Number.isInteger(port) && port >= 1 && port <= 65535);
  if (!validPort) throw new Error(`Invalid installer port: ${port}`);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostOverride, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        port: actualPort,
        baseUrl: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise((ok) => server.close(ok)),
        installDirDefault,
      });
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
      flags.set(key, value);
      if (value !== true) i += 1;
    }
  }
  const host = process.env.GEV_INSTALLER_HOST || (flags.get('host') ? String(flags.get('host')) : '127.0.0.1');
  const manifest = await readManifestFile(await resolveManifestPath(flags));
  const requestedPort = flags.get('port') ? Number(flags.get('port')) : manifest.installerPort;
  const port = Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535
    ? requestedPort
    : manifest.installerPort;
  const options = {
    manifest,
    port,
    host,
    token: process.env.GEV_INSTALLER_TOKEN || (flags.get('token') ? String(flags.get('token')) : null),
    sourceArchiveUrl: process.env.GEV_INSTALLER_SOURCE_URL || (flags.get('source') ? String(flags.get('source')) : null),
    runtimeDistBase: process.env.GEV_INSTALLER_RUNTIME_DIST || (flags.get('runtime-dist') ? String(flags.get('runtime-dist')) : null),
    installDir: flags.get('install-dir') ? String(flags.get('install-dir')) : null,
  };
  const started = await createInstallerServer(options);
  console.log(`[installer] Devil's Eye installer v${INSTALLER_VERSION}`);
  console.log(`[installer] Serving installer UI at ${started.baseUrl}`);
  console.log(`[installer] Repo: ${manifest.owner}/${manifest.repo} (${manifest.repoIsPrivate ? 'private' : 'public'}), branch ${manifest.defaultBranch}`);
  if (manifest.repoIsPrivate) {
    console.log('[installer] Tip: provide a GitHub fine-grained token via --token or the GEV_INSTALLER_TOKEN env var for the source download.');
  }
  return started;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`[installer] Failed to start: ${err.message}`);
    process.exitCode = 1;
  });
}