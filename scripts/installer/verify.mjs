import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseZip, readZipEntry } from '../../installer/zipcode.mjs';
import { BUNDLE_FILES } from './build.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(repoRoot, 'dist-installer');

function fail(message) {
  throw new Error(`Installer bundle verification failed: ${message}`);
}

async function main() {
  const files = await fsp.readdir(outDir);
  const zipFiles = files.filter((f) => /^Evol-Eye-Setup-.+\.zip$/.test(f));
  if (zipFiles.length !== 1) fail(`expected exactly one setup zip in ${outDir}, found ${zipFiles.join(', ') || 'none'}`);
  const zipName = zipFiles[0];
  const rootFolder = zipName.replace(/\.zip$/, '');

  const zipBuffer = await fsp.readFile(path.join(outDir, zipName));

  const parsed = parseZip(zipBuffer);
  const byName = new Map(parsed.entries.map((e) => [e.name, e]));
  if (parsed.entries.length !== BUNDLE_FILES.length) {
    fail(`zip has ${parsed.entries.length} entries, expected ${BUNDLE_FILES.length}`);
  }
  for (const file of BUNDLE_FILES) {
    const name = `${rootFolder}/${file}`;
    const entry = byName.get(name);
    if (!entry) fail(`zip is missing bundled file ${file}`);
    const data = readZipEntry(zipBuffer, entry);
    const actualSha = createHash('sha256').update(data).digest('hex');

    if (file === 'manifest.json') {
      const manifest = JSON.parse(data.toString('utf8'));
      if (typeof manifest.repo !== 'string' || typeof manifest.owner !== 'string') {
        fail('manifest.json inside the zip is malformed');
      }
    }

    const sums = await fsp.readFile(path.join(outDir, 'SHA256SUMS.txt'), 'utf8');
    const line = sums.split(/\r?\n/).find((l) => l.endsWith(`  ${file}`));
    if (!line) fail(`SHA256SUMS.txt lacks an entry for ${file}`);
    if (!line.startsWith(actualSha)) fail(`SHA256SUMS.txt entry for ${file} does not match the zip contents`);
  }

  const metadata = JSON.parse(await fsp.readFile(path.join(outDir, 'installer.json'), 'utf8'));
  if (metadata.zip !== zipName) fail('installer.json does not point at the built zip');
  if (metadata.sha256 !== createHash('sha256').update(zipBuffer).digest('hex')) fail('installer.json sha256 does not match the zip');
  const sumsText = await fsp.readFile(path.join(outDir, 'SHA256SUMS.txt'), 'utf8');
  if (!sumsText.includes(`${metadata.sha256}  ${zipName}`)) fail('SHA256SUMS.txt does not list the zip hash');
  const serialized = JSON.stringify(metadata).toLowerCase();
  for (const secret of ['token', 'secret', 'private_key', 'password']) {
    if (serialized.includes(`"${secret}"`)) fail(`installer.json leaks a metadata key "${secret}"`);
  }

  console.log(`Verified ${zipName}: ${BUNDLE_FILES.length} files, sha256 ${metadata.sha256}`);
}

const cliEntry = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (cliEntry === path.resolve(fileURLToPath(import.meta.url))) {
  await main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}