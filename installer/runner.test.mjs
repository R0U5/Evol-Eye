import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

import { defaultDeps, runInstall, deduceRepoRoot, InstallError } from './runner.mjs';
import { makeRepoArchive, makeFakeNodeDist, startFixtureServer, tempDir } from './test-fixture.mjs';

const SIXTY_SECONDS = { timeout: 120_000 };

function context(fixture) {
  return { ...defaultDeps(), fetch: fixture.fetch };
}

function collector() {
  const events = [];
  return {
    events,
    emit: (event) => events.push(event),
    done: () => events.find((e) => e.type === 'done'),
    error: () => events.find((e) => e.type === 'error'),
  };
}

function defaultOverrides(installDir, sourceArchiveUrl, extra = {}) {
  return {
    installDir,
    sourceArchiveUrl,
    mode: 'development',
    bundleNode: false,
    shortcut: false,
    build: false,
    ...extra,
  };
}

test('deduceRepoRoot finds the single top folder or the flat root', () => {
  assert.equal(deduceRepoRoot(['Evol-Eye-main/package.json', 'Evol-Eye-main/src/a.txt']), 'Evol-Eye-main');
  assert.equal(deduceRepoRoot(['package.json', 'src/a.txt']), '');
  assert.equal(deduceRepoRoot(['a/x.txt', 'b/y.txt']), null);
  assert.equal(deduceRepoRoot([]), null);
});

test('full install in development mode installs the fixture and writes launchers', async (t) => {
  const fixture = await startFixtureServer({ repoZip: makeRepoArchive() });
  const installDir = await tempDir();
  t.after(async () => { await fixture.close(); });

  const log = collector();
  await runInstall({
    manifest: {},
    overrides: defaultOverrides(installDir, `${fixture.baseUrl}/archive.zip`),
    emit: log.emit,
    deps: context(fixture),
  });

  assert.ok(log.done(), 'expected a done event');
  assert.equal(log.done().summary.mode, 'development');
  assert.equal(log.done().summary.node, 'system');
  assert.equal(log.error(), undefined);

  assert.equal(await fsp.readFile(path.join(installDir, 'app', 'package.json'), 'utf8'), JSON.stringify({
    name: 'evol-eye-fixture',
    version: '0.0.1',
    private: true,
    scripts: { build: 'node build.mjs' },
    dependencies: {},
  }, null, 2));
  assert.ok(await fsp.readFile(path.join(installDir, 'app', 'index.html'), 'utf8'), '<h1>fixture</h1>');
  assert.ok(await fsp.stat(path.join(installDir, 'launcher-app.mjs')));
  const wrapper = process.platform === 'win32' ? 'EVOL Eye.cmd' : 'Evol-Eye.sh';
  assert.ok(await fsp.stat(path.join(installDir, wrapper)));
  const meta = JSON.parse(await fsp.readFile(path.join(installDir, '.evol-install.json'), 'utf8'));
  assert.equal(meta.appPort, 4173);
  assert.equal(meta.mode, 'development');
  assert.equal(meta.node, 'system');
  const stages = new Set(log.events.filter((e) => e.type === 'step' && e.state === 'done').map((e) => e.id));
  assert.deepEqual([...stages], ['source', 'extract', 'runtime', 'deps', 'ready']);
});

test('production mode runs the build step and emits dist output', async (t) => {
  const fixture = await startFixtureServer({ repoZip: makeRepoArchive() });
  const installDir = await tempDir();
  t.after(async () => { await fixture.close(); });

  const log = collector();
  await runInstall({
    manifest: {},
    overrides: defaultOverrides(installDir, `${fixture.baseUrl}/archive.zip`, { mode: 'production', build: true }),
    emit: log.emit,
    deps: context(fixture),
  });

  assert.ok(log.done());
  assert.equal(log.done().summary.mode, 'production');
  const built = await fsp.readFile(path.join(installDir, 'app', 'dist', 'index.html'), 'utf8');
  assert.equal(built, 'fixture-built');
});

test('bundled runtime path downloads, verifies sha, unpacks, and runs npm via the bundled node', async (t) => {
  const nodeDist = await makeFakeNodeDist();
  const fixture = await startFixtureServer({ repoZip: makeRepoArchive(), nodeDist });
  const installDir = await tempDir();
  t.after(async () => { await fixture.close(); });

  const log = collector();
  await runInstall({
    manifest: {},
    overrides: defaultOverrides(installDir, `${fixture.baseUrl}/archive.zip`, {
      bundleNode: true,
      runtimeDistBase: fixture.baseUrl,
    }),
    emit: log.emit,
    deps: context(fixture),
  });

  assert.equal(log.error(), undefined, JSON.stringify(log.events.filter((e) => e.type === 'error')));
  assert.ok(log.done());
  assert.equal(log.done().summary.node, 'bundled');

  const dist = nodeDist.spec;
  assert.ok(await fsp.stat(path.join(installDir, 'runtime', 'node', dist.binRel)));
  assert.equal(await fsp.readFile(path.join(installDir, 'app', 'npm-stub-ran.txt'), 'utf8'), 'stub');
  const anyRuntimeDownload = log.events.some((e) => e.type === 'step' && e.id === 'runtime' && e.state === 'active');
  assert.ok(anyRuntimeDownload);
});

test('a checksum that does not list the archive aborts the bundle step', async (t) => {
  const nodeDist = await makeFakeNodeDist();
  nodeDist.shasumsText = `ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff  other.zip\n`;
  const fixture = await startFixtureServer({ repoZip: makeRepoArchive(), nodeDist });
  const installDir = await tempDir();
  t.after(async () => { await fixture.close(); });

  const log = collector();
  await assert.rejects(
    runInstall({
      manifest: {},
      overrides: defaultOverrides(installDir, `${fixture.baseUrl}/archive.zip`, { bundleNode: true, runtimeDistBase: fixture.baseUrl }),
      emit: log.emit,
      deps: context(fixture),
    }),
    (err) => err instanceof InstallError && err.code === 'SHASUM_MISSING',
  );
});

test('unreachable source reports a token-ish failure', async (t) => {
  const fixture = await startFixtureServer({ repoZip: null });
  const installDir = await tempDir();
  t.after(async () => { await fixture.close(); });

  const log = collector();
  await assert.rejects(
    runInstall({ manifest: {}, overrides: defaultOverrides(installDir, `${fixture.baseUrl}/archive.zip`), emit: log.emit, deps: context(fixture) }),
    (err) => err instanceof InstallError && err.code === 'DOWNLOAD_NEEDS_TOKEN',
  );
});

test('archives without a package.json are rejected as bad layout', async (t) => {
  const weird = makeRepoArchive('SomeThingElse', { withoutPackage: true });
  const fixture = await startFixtureServer({ repoZip: weird });
  const installDir = await tempDir();
  t.after(async () => { await fixture.close(); });

  const log = collector();
  await assert.rejects(
    runInstall({ manifest: {}, overrides: defaultOverrides(installDir, `${fixture.baseUrl}/archive.zip`), emit: log.emit, deps: context(fixture) }),
    (err) => err instanceof InstallError && (err.code === 'BAD_ARCHIVE'),
  );
});

test('cancellation aborts cleanly with a CANCELLED error', async (t) => {
  const fixture = await startFixtureServer({ repoZip: makeRepoArchive() });
  const installDir = await tempDir();
  t.after(async () => { await fixture.close(); });

  const controller = new AbortController();
  controller.abort();
  const log = collector();
  await assert.rejects(
    runInstall({
      manifest: {},
      overrides: defaultOverrides(installDir, `${fixture.baseUrl}/archive.zip`),
      emit: log.emit,
      signal: controller.signal,
      deps: context(fixture),
    }),
    (err) => err instanceof InstallError && err.code === 'CANCELLED',
  );
});

test('install accepts an explicit token without leaking it', async (t) => {
  const fixture = await startFixtureServer({ repoZip: makeRepoArchive(), trackRequests: true });
  const installDir = await tempDir();
  t.after(async () => { await fixture.close(); });

  const log = collector();
  await runInstall({
    manifest: { repoIsPrivate: true },
    overrides: { ...defaultOverrides(installDir, `${fixture.baseUrl}/archive.zip`), token: 'secret-token' },
    emit: log.emit,
    deps: context(fixture),
  });
  assert.ok(log.done());
  for (const event of log.events) {
    assert.ok(!JSON.stringify(event).includes('secret-token'));
  }
});