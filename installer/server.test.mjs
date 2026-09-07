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
    process.env.GEV_BOOTSTRAP_NODE = process.execPath;
    assert.equal(bootstrapRuntimeRoot(), expected);
  } finally {
    delete process.env.GEV_BOOTSTRAP_NODE;
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
  assert.equal(admitInstallerRequest({ remoteAddress: '10.0.0.5', host: loopbackHost, hostOverride: '0.0.0.0' }).allowed, true);
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
  assert.ok(html.includes('Devil'));
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

  const installDir = await tempDir('gev-server-');
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
  const dir = await tempDir('gev-launch-');
  const res = await fetch(`${started.baseUrl}/api/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installDir: dir }),
  });
  assert.equal(res.status, 400);
  const payload = await res.json();
  assert.equal(payload.code, 'NO_LAUNCHER');
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