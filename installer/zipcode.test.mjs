import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

import { buildZip, parseZip, readZipEntry, unzipToDisk, safeRelArchiveName, crc32, ZipError } from './zipcode.mjs';
import { tempDir } from './test-fixture.mjs';

test('crc32 matches the known 123456789 vector', () => {
  assert.equal(crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926);
});

test('deflated round trip preserves names, sizes, and bytes', async () => {
  const when = new Date('2026-01-02T03:04:05Z');
  const zip = buildZip([
    { path: 'a.txt', data: 'hello world' },
    { path: 'dir/b/c.bin', data: Buffer.from([0, 1, 2, 253, 254, 255]) },
    { path: 'dir/', data: undefined, when },
  ], { method: 'deflate' });

  const { entries } = parseZip(zip);
  assert.equal(entries.length, 3);
  const a = entries.find((e) => e.name === 'a.txt');
  const bin = entries.find((e) => e.name === 'dir/b/c.bin');
  const dir = entries.find((e) => e.name === 'dir/');
  assert.ok(a && bin && dir);
  assert.equal(a.method, 8);
  assert.equal(a.uncompressedSize, 11);
  assert.equal(readZipEntry(zip, a).toString('utf8'), 'hello world');
  assert.deepEqual([...readZipEntry(zip, bin)], [0, 1, 2, 253, 254, 255]);
  assert.equal(dir.isDirectory, true);
});

test('store method round trip', () => {
  const zip = buildZip([{ path: 'raw.bin', data: Buffer.from([255, 128, 64, 0]) }], { method: 'store' });
  const { entries } = parseZip(zip);
  assert.equal(entries[0].method, 0);
  assert.deepEqual([...readZipEntry(zip, entries[0])], [255, 128, 64, 0]);
});

test('unzipToDisk writes a faithful tree and honors onEntry', async () => {
  const dir = await tempDir('evol-zip-');
  const zip = buildZip([
    { path: 'root/package.json', data: '{}' },
    { path: 'root/src/a.js', data: 'a' },
  ]);
  const seen = [];
  const count = await unzipToDisk(zip, dir, (info) => seen.push(`${info.name}:${info.size}`));
  assert.equal(count, 2);
  assert.equal(await fsp.readFile(path.join(dir, 'root', 'package.json'), 'utf8'), '{}');
  assert.equal(await fsp.readFile(path.join(dir, 'root', 'src', 'a.js'), 'utf8'), 'a');
  assert.deepEqual(seen, ['root/package.json:2', 'root/src/a.js:1']);
});

test('unsafe traversal entries are refused', async () => {
  const zip = buildZip([{ path: 'sub/../../evil.txt', data: 'x' }]);
  const dir = await tempDir('evol-zip-');
  await assert.rejects(unzipToDisk(zip, dir), (err) => err instanceof ZipError && err.code === 'ZIP_TRAVERSAL');
  await assert.rejects(fsp.stat(path.join(dir, 'evil.txt')));
});

test('safeRelArchiveName normalizes backslashes but rejects traversal and absolute paths', () => {
  assert.equal(safeRelArchiveName('a\\b.txt'), 'a/b.txt');
  assert.equal(safeRelArchiveName('../x'), null);
  assert.equal(safeRelArchiveName('a/../../x'), null);
  assert.equal(safeRelArchiveName('/etc/passwd'), null);
  assert.equal(safeRelArchiveName('C:/Windows/system32'), null);
  assert.equal(safeRelArchiveName(''), null);
  assert.equal(safeRelArchiveName('ok/path/file.bin'), 'ok/path/file.bin');
});

test('non-zip buffers raise a clear header error', () => {
  assert.throws(() => parseZip(Buffer.from('this is definitely not a zip archive at all!!')), ZipError);
});

test('empty-ish file raises', () => {
  assert.throws(() => parseZip(Buffer.alloc(10)), ZipError);
});

test('crc mismatch is detected on corrupted data', () => {
  const zip = buildZip([{ path: 'f.txt', data: 'payload' }]);
  zip[36] ^= 0xff;
  const { entries } = parseZip(zip);
  assert.throws(() => readZipEntry(zip, entries[0]), ZipError);
});

test('backslash absolute path on posix and drive-relative names are rejected', () => {
  assert.equal(safeRelArchiveName('\\\\server\\share\\file.txt'), null);
  assert.equal(safeRelArchiveName('C:/Windows/system32'), null);
  assert.equal(safeRelArchiveName('/abs/path'), null);
});

test('a leading ./ is tolerated', () => {
  assert.equal(safeRelArchiveName('./fine/x.txt'), 'fine/x.txt');
});