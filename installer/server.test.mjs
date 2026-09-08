import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

import { admitInstallerRequest, createInstallerServer, bootstrapRuntimeRoot } from './server.mjs';
import { makeRepoArchive, tempDir } from './test-fixture.mjs';

test('bootstrapRuntimeRoot recovers the runtime root for the bootstrap layout', () => {
  const sep = path.sep;
  const walk = process.platform === 'win32' ? 'node.exe' : `bin${sep}node`;
  const base = path.dirname(process.execPath);
  const expected = process.platform === 'win32' || !base.endsWith(sep + walk)
    ? base
    : path.dirname(base);
  try {
    process.env.EVOL_BOOTSTRAP_NODE = process.execPath;
    assert.equal(bootstrapRuntimeRoot(), expected);
  } finally {
    delete process.env.EVOL_BOOTSTRAP_NODE;
  }
  assert.equal(bootstrapRuntimeRoot(), null);
});

test('admitInstallerRequest blocks non-loopback peers, spoofed hosts, and cross-origin pages', () => {
  const loopbackHost = '127.0.0.1:8787';
  assert.equal(admitInstallerRequest({ remoteAddress: '127.0.0.1', host: loopbackHost }).allowed, true);
  assert.ok(admitInstallerRequest({
    remoteAddress: '::1',
    host: '[::1]:8787',
    origin: 'http://localhost:8787',
  }).allowed);
  assert.equal(admitInstallerRequest({ remoteAddress: '8.8.8.8', host: loopbackHost }).allowed, false);
  assert.equal(admitInstallerRequest({ remoteAddress: '127.0.0.1', host: 'evil.com' }).allowed, false);
  assert.equal(admitInstallerRequest({
    remoteAddress: '127.0.0.1',
    host: loopbackHost,
    origin: 'http://evil.com',
  }).allowed, false);
  assert.equal(admitInstallerRequest({
    remoteAddress: '127.0.0.1',
    host: loopbackHost,
    referer: 'https://attacker.example/',
  }).allowed, false);
  assert.equal(admitInstallerRequest({
    remoteAddress: '127.0.0.1',
    host: loopbackHost,
    origin: 'file:///C:/x/index.html',
  }).allowed, true);
  // Non-loopback host override admits non-mutating requests from any peer…
  assert.equal(admitInstallerRequest({ remoteAddress: '10.0.0.5', host: loopbackHost, hostOverride: '0.0.0.0', path: '/api/health', method: 'GET' }).allowed, true);
  // …but mutating endpoints require a server token.
  assert.equal(admitInstallerRequest({ remoteAddress: '10.0.0.5', host: loopbackHost, hostOverride: '0.0.0.0', path: '/api/install', method: 'POST' }).allowed, false);
  assert.equal(admitInstallerRequest({ remoteAddress: '10.0.0.5', host: loopbackHost, hostOverride: '0.0.0.0', path: '/api/launch', method: 'POST' }).allowed, false);
});

test('loopback default admits mutating endpoints without a token', () => {
  const loopbackHost = '127.0.0.1:8787';
  assert.equal(admitInstallerRequest({ remoteAddress: '127.0.0.1', host: loopbackHost, path: '/api/install', method: 'POST' }).allowed, true);
  assert.equal(admitInstallerRequest({ remoteAddress: '127.0.0.1', host: loopbackHost, path: '/api/launch', method: 'POST' }).allowed, true);
});

test('non-loopback host with a server token requires a matching request token', () => {
  const base = { remoteAddress: '10.0.0.5', host: '127.0.0.1:8787', hostOverride: '0.0.0.0', serverToken: 's3cret' };
  assert.equal(admitInstallerRequest({ ...base, path: '/api/install', method: 'POST', requestToken: 's3cret' }).allowed, true);
  assert.equal(admitInstallerRequest({ ...base, path: '/api/launch', method: 'POST', requestToken: 's3cret' }).allowed, true);
  assert.equal(admitInstallerRequest({ ...base, path: '/api/install', method: 'POST', requestToken: 'wrong' }).allowed, false);
  assert.equal(admitInstallerRequest({ ...base, path: '/api/install', method: 'POST' }).allowed, false);
  assert.equal(admitInstallerRequest({ ...base, path: '/api/launch', method: 'POST', requestToken: '' }).allowed, false);
});

async function bootServer(t, manifest, options = {}) {
  const started = await createInstallerServer({ port: 0, manifest, ...options });
  t.after(async () => { await started.close(); });
  return started;
}

test('health and static UI are served without network', async (t) => {
  const started = await bootServer(t, {}, {});
  const health = await fetch(`${started.baseUrl}/api/health`);
  assert.equal(health.status, 200);

  const res = await fetch(`${started.baseUrl}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('EVOL'));
  assert.ok(html.includes('installer.js'));
});

test('plan reachability uses the configured source override', async (t) => {
  const archive = makeRepoArchive();
  const { startFixtureServer } = await import('./test-fixture.mjs');
  const fixture = await startFixtureServer({ repoZip: archive });
  t.after(async () => { await fixture.close(); });

  const started = await bootServer(t, {}, { sourceArchiveUrl: `${fixture.baseUrl}/archive.zip` });
  const plan = await (await fetch(`${started.baseUrl}/api/plan`)).json();
  assert.equal(plan.ok, true);
  assert.equal(plan.manifest.owner, 'R0U5');
  assert.equal(plan.reachability, 'ok');
  assert.equal(plan.defaults.bundleNode, true);
  assert.ok(Array.isArray(plan.deps));
  assert.ok(Array.isArray(plan.steps));
  assert.ok(plan.nodeVersion);
});

test('a private repo that is unreachable without a token reports need-token', async (t) => {
  const { startFixtureServer } = await import('./test-fixture.mjs');
  const fixture = await startFixtureServer({ failAll: true });
  t.after(async () => { await fixture.close(); });

  const started = await bootServer(t, { repoIsPrivate: true }, { sourceArchiveUrl: `${fixture.baseUrl}/archive.zip` });
  const plan = await (await fetch(`${started.baseUrl}/api/plan`)).json();
  assert.equal(plan.reachability, 'need-token');
});

test('a full install runs end-to-end with the fixture source', async (t) => {
  const { startFixtureServer } = await import('./test-fixture.mjs');
  const fixture = await startFixtureServer({ repoZip: makeRepoArchive() });
  t.after(async () => { await fixture.close(); });

  const installDir = await tempDir('evol-server-');
  const started = await bootServer(t, {}, { sourceArchiveUrl: `${fixture.baseUrl}/archive.zip` });

  const res = await fetch(`${started.baseUrl}/api/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      installDir,
      mode: 'development',
      bundleNode: false,
      build: false,
      shortcut: false,
    }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const events = text.trim().split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
  const types = events.map((e) => e.type);
  assert.ok(types.includes('done'), JSON.stringify(events));
  assert.ok(types.includes('progress'), JSON.stringify(events));
  assert.ok(!types.includes('error'), JSON.stringify(events));
  const done = events.find((e) => e.type === 'done').summary;
  assert.equal(done.installDir, installDir);
  assert.equal(done.appPort, 4173);
  assert.ok(await fsp.stat(path.join(installDir, 'app', 'package.json')));
});

test('install rejects cross-origin requests', async (t) => {
  const started = await bootServer(t, {}, {});
  const res = await fetch(`${started.baseUrl}/api/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 403);
});

test('launch rejects an install dir without a launcher', async (t) => {
  const started = await bootServer(t, {}, {});
  const dir = await tempDir('evol-launch-');
  const res = await fetch(`${started.baseUrl}/api/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installDir: dir }),
  });
  assert.equal(res.status, 400);
  const payload = await res.json();
  assert.equal(payload.code, 'NO_LAUNCHER');
});

test('non-loopback server without a token refuses mutating endpoints', async (t) => {
  const started = await bootServer(t, {}, { host: '0.0.0.0' });
  const dir = await tempDir('evol-launch-');

  const install = await fetch(`${started.baseUrl}/api/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(install.status, 403);
  const installPayload = await install.json();
  assert.equal(installPayload.reason, 'non-loopback host requires a server token');

  const launch = await fetch(`${started.baseUrl}/api/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installDir: dir }),
  });
  assert.equal(launch.status, 403);

  // Non-mutating endpoints stay reachable so the operator can diagnose.
  const health = await fetch(`${started.baseUrl}/api/health`);
  assert.equal(health.status, 200);
});

test('non-loopback server with a token admits mutating endpoints only with the token', async (t) => {
  const started = await bootServer(t, {}, { host: '0.0.0.0', token: 's3cret' });
  const dir = await tempDir('evol-launch-');

  const refused = await fetch(`${started.baseUrl}/api/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installDir: dir }),
  });
  assert.equal(refused.status, 403);
  const refusedPayload = await refused.json();
  assert.equal(refusedPayload.reason, 'invalid or missing token');

  // Correct token → admitted; the request proceeds and fails later with
  // NO_LAUNCHER (400), proving the gate let it through.
  const accepted = await fetch(`${started.baseUrl}/api/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 's3cret', installDir: dir }),
  });
  assert.equal(accepted.status, 400);
  const acceptedPayload = await accepted.json();
  assert.equal(acceptedPayload.code, 'NO_LAUNCHER');
});

test('malformed bodies and unknown api routes are rejected', async (t) => {
  const started = await bootServer(t, {}, {});
  const bad = await fetch(`${started.baseUrl}/api/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{{{',
  });
  assert.equal(bad.status, 400);
  const missing = await fetch(`${started.baseUrl}/api/nope`);
  assert.equal(missing.status, 404);
  const wrong = await fetch(`${started.baseUrl}/api/launch`, {
    method: 'GET',
  });
  assert.equal(wrong.status, 404);
});