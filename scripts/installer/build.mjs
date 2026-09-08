import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { buildZip } from '../../installer/zipcode.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const installerDir = path.join(repoRoot, 'installer');
const outDir = path.join(repoRoot, 'dist-installer');

const BUNDLE_FILES = [
  'README.md',
  'bootstrap.cmd',
  'bootstrap.sh',
  'ensure-runtime.ps1',
  'launcher-app.mjs',
  'server.mjs',
  'runner.mjs',
  'core.mjs',
  'zipcode.mjs',
  'index.html',
  'installer.css',
  'installer.js',
  'manifest.json',
  'EVOL Eye.cmd',
  'Evol-Eye.sh',
];

export { BUNDLE_FILES };

async function main() {
  const pkg = JSON.parse(await fsp.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const appVersion = pkg.version;
  const rootFolder = `Evol-Eye-Setup-${appVersion}`;
  const zipName = `${rootFolder}.zip`;

  await fsp.mkdir(outDir, { recursive: true });

  const entries = [];
  let totalBytes = 0;
  for (const sourceName of BUNDLE_FILES) {
    const data = await fsp.readFile(path.join(installerDir, sourceName));
    entries.push({ path: `${rootFolder}/${sourceName}`, data });
    totalBytes += data.length;
  }

  const zipBuffer = buildZip(entries, { method: 'deflate' });
  const zipPath = path.join(outDir, zipName);
  await fsp.writeFile(zipPath, zipBuffer);

  const sha256 = createHash('sha256').update(zipBuffer).digest('hex');
  const perFile = Object.fromEntries(
    entries.map((entry) => {
      const rel = entry.path.slice(rootFolder.length + 1);
      return [rel, createHash('sha256').update(entry.data).digest('hex')];
    }),
  );

  const sums = [
    `${sha256}  ${zipName}`,
    ...Object.entries(perFile).map(([file, hex]) => `${hex}  ${file}`),
  ].join('\n') + '\n';
  await fsp.writeFile(path.join(outDir, 'SHA256SUMS.txt'), sums);

  const metadata = {
    version: appVersion,
    installerVersion: '1.0.0',
    builtAt: new Date().toISOString(),
    zip: zipName,
    sha256,
    bytes: zipBuffer.length,
    unzippedBytes: totalBytes,
    files: perFile,
  };
  await fsp.writeFile(path.join(outDir, 'installer.json'), JSON.stringify(metadata, null, 2) + '\n');

  console.log(`Wrote ${path.join(outDir, zipName)} (${(zipBuffer.length / 1024).toFixed(1)} KB)`);
  console.log(`sha256 ${sha256}`);
  console.log(`Bundle location: ${outDir}`);
}

const cliEntry = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (cliEntry === path.resolve(fileURLToPath(import.meta.url))) {
  await main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}