import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  DEFAULT_MANIFEST,
  normalizeManifest,
  githubArchiveUrl,
  resolveSourceUrl,
  authHeaders,
  parseSemver,
  satisfiesNodeVersion,
  nodeDistSpec,
  defaultInstallDir,
  buildDependencyItems,
  classifyReachability,
  sha256LineMatch,
  sanitizeInstallDir,
  resolveAppPort,
  INSTALL_STEPS,
} from './core.mjs';

test('default manifest normalizes cleanly', () => {
  const m = normalizeManifest();
  assert.equal(m.owner, 'R0U5');
  assert.equal(m.repo, 'Devils-Eye');
  assert.equal(m.repoIsPrivate, true);
});

test('manifest rejects bad slugs and coerces invalid ports', () => {
  assert.throws(() => normalizeManifest({ owner: '../x' }));
  assert.throws(() => normalizeManifest({ repo: 'a/b' }));
  const m = normalizeManifest({ installerPort: 'abc', appPort: 999999, repoIsPrivate: 'yes' });
  assert.equal(m.installerPort, DEFAULT_MANIFEST.installerPort);
  assert.equal(m.appPort, DEFAULT_MANIFEST.appPort);
  assert.equal(m.repoIsPrivate, true);
  const pub = normalizeManifest({ repoIsPrivate: false });
  assert.equal(pub.repoIsPrivate, false);
});

test('githubArchiveUrl uses the default branch', () => {
  assert.equal(
    githubArchiveUrl({ owner: 'R0U5', repo: 'Devils-Eye', defaultBranch: 'main' }),
    'https://github.com/R0U5/Devils-Eye/archive/refs/heads/main.zip',
  );
});

test('resolveSourceUrl prefers an explicit override', () => {
  const m = normalizeManifest();
  assert.equal(resolveSourceUrl(m, {}), githubArchiveUrl(m));
  assert.equal(resolveSourceUrl(m, { sourceArchiveUrl: 'http://127.0.0.1:9/a.zip' }), 'http://127.0.0.1:9/a.zip');
  assert.ok(resolveSourceUrl(m, { branch: 'dev' }).includes('/heads/dev.zip'));
});

test('authHeaders only adds a header for non-empty tokens', () => {
  assert.deepEqual(authHeaders(), {});
  assert.deepEqual(authHeaders(''), {});
  assert.deepEqual(authHeaders('abc'), { Authorization: 'Bearer abc' });
});

test('semver parsing and comparison', () => {
  assert.deepEqual(parseSemver('v24.14.0'), [24, 14, 0]);
  assert.deepEqual(parseSemver('22'), [22, 0, 0]);
  assert.equal(parseSemver('nope'), null);
  assert.equal(satisfiesNodeVersion('22.17.0', '20.0.0'), true);
  assert.equal(satisfiesNodeVersion('18.19.0', '20.0.0'), false);
  assert.equal(satisfiesNodeVersion('20.1.0', '20.0.0'), true);
  assert.equal(satisfiesNodeVersion('24.14.0', '24.14.0'), true);
  assert.equal(satisfiesNodeVersion(undefined, '20.0.0'), false);
});

test('nodeDistSpec maps platforms and builds official URLs', () => {
  const win = nodeDistSpec('24.14.0', 'win32', 'x64');
  assert.equal(win.archiveName, 'win-x64');
  assert.equal(win.format, 'zip');
  assert.equal(win.archiveFile, 'node-v24.14.0-win-x64.zip');
  assert.equal(win.binRel, 'node.exe');
  assert.equal(win.npmRel, 'node_modules/npm/bin/npm-cli.js');
  assert.ok(win.url.startsWith('https://nodejs.org/dist/v24.14.0/'));
  assert.equal(win.shasumsUrl, 'https://nodejs.org/dist/v24.14.0/SHASUMS256.txt');

  const mac = nodeDistSpec('24.14.0', 'darwin', 'arm64');
  assert.equal(mac.format, 'tar.gz');
  assert.equal(mac.binRel, 'bin/node');
  assert.equal(mac.archiveFile, 'node-v24.14.0-darwin-arm64.tar.gz');

  const linux = nodeDistSpec('24.14.0', 'linux', 'arm');
  assert.equal(linux.archiveName, 'linux-armv7l');
  assert.throws(() => nodeDistSpec('24.14.0', 'win32', 'mips'));
});

test('defaultInstallDir is per-user and platform-aware', () => {
  const win = defaultInstallDir('win32', { localAppData: 'C:\\Users\\tester\\AppData\\Local' });
  assert.ok(win.endsWith('DevilsEye'), win);
  const linux = defaultInstallDir('linux', { homedir: '/home/tester' });
  assert.ok(linux.endsWith(path.join('.local', 'share', 'devils-eye')), linux);
  const darwinDefault = defaultInstallDir('darwin', { homedir: '/Users/tester' });
  assert.ok(darwinDefault.includes('Application Support'), darwinDefault);
});

test('dependency items flag node severity and pytest optional', () => {
  const old = buildDependencyItems({ nodeVersion: '18.0.0' });
  assert.equal(old.find((i) => i.id === 'node').status, 'old');
  const ok = buildDependencyItems({ nodeVersion: '24.14.0' });
  assert.equal(ok.find((i) => i.id === 'node').status, 'ok');
  const none = buildDependencyItems({ nodeVersion: undefined });
  assert.equal(none.find((i) => i.id === 'node').status, 'missing');
  assert.equal(none.find((i) => i.id === 'python').required, false);
  assert.equal(none.find((i) => i.id === 'python').status, 'optional');
});

test('reachability classification distinguishes private token need', () => {
  assert.equal(classifyReachability(200, true), 'ok');
  assert.equal(classifyReachability(302, false), 'ok');
  assert.equal(classifyReachability(404, true), 'need-token');
  assert.equal(classifyReachability(404, false), 'missing');
  assert.equal(classifyReachability(500, false), 'error');
});

test('shasum line matching is strict about the file name', () => {
  const hexA = 'a'.repeat(64);
  const hexB = 'b'.repeat(64);
  const lines = [
    `${hexA}  node-v24.14.0-win-x64.zip`,
    `${hexB}  *SHASUMS256.txt`,
  ];
  assert.equal(sha256LineMatch(lines, 'node-v24.14.0-win-x64.zip'), hexA);
  assert.equal(sha256LineMatch(lines, 'SHASUMS256.txt'), hexB);
  assert.equal(sha256LineMatch(lines, 'other.zip'), null);
});

test('sanitizeInstallDir resolves and rejects junk', () => {
  assert.equal(sanitizeInstallDir(''), null);
  assert.equal(sanitizeInstallDir(null), null);
  const resolved = sanitizeInstallDir('C:\\Users\\x\\DevilsEye');
  assert.ok(resolved.endsWith('DevilsEye'));
  assert.ok(resolved.length >= 3);
});

test('resolveAppPort clamps to manifest defaults', () => {
  const m = normalizeManifest({ appPort: 4173 });
  assert.equal(resolveAppPort(m, {}), 4173);
  assert.equal(resolveAppPort(m, { appPort: 999999 }), 4173);
  assert.equal(resolveAppPort(m, { appPort: 5100 }), 5100);
});

test('steps are present and stable', () => {
  assert.deepEqual(INSTALL_STEPS.map((s) => s.id), ['source', 'extract', 'runtime', 'deps', 'build', 'ready']);
});