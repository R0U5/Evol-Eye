import path from 'node:path';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import http from 'node:http';

import { buildZip } from './zipcode.mjs';
import { RECOMMENDED_NODE_VERSION, nodeDistSpec } from './core.mjs';

export const FIXTURE_PACKAGE = JSON.stringify({
  name: 'devils-eye-fixture',
  version: '0.0.1',
  private: true,
  scripts: { build: 'node build.mjs' },
  dependencies: {},
}, null, 2);

export const FIXTURE_BUILD = `import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await writeFile('dist/index.html', 'fixture-built');
console.log('BUILD OK');
`;

export function makeRepoArchive(rootName = 'Devils-Eye-main', { withoutPackage = false } = {}) {
  const entries = [
    { path: `${rootName}/index.html`, data: '<h1>fixture</h1>' },
    { path: `${rootName}/src/hello.txt`, data: 'hello' },
    { path: `${rootName}/build.mjs`, data: FIXTURE_BUILD },
  ];
  if (!withoutPackage) entries.unshift({ path: `${rootName}/package.json`, data: FIXTURE_PACKAGE });
  return buildZip(entries, { method: 'deflate' });
}

export async function makeFakeNodeDist() {
  const spec = nodeDistSpec(RECOMMENDED_NODE_VERSION, process.platform, process.arch);
  const binBytes = await fsp.readFile(process.execPath);
  const npmStub = `import { writeFile } from 'node:fs/promises';
await writeFile('npm-stub-ran.txt', 'stub');
process.exit(0);
`;
  let buffer;
  if (spec.format === 'tar.gz') {
    const staging = await fsp.mkdtemp(path.join(process.env.TEMP || '/tmp', 'gev-fake-node-'));
    try {
      const binDst = path.join(staging, spec.topDir, spec.binRel);
      const npmDst = path.join(staging, spec.topDir, spec.npmRel);
      await fsp.mkdir(path.dirname(binDst), { recursive: true });
      await fsp.mkdir(path.dirname(npmDst), { recursive: true });
      await fsp.writeFile(binDst, binBytes);
      await fsp.chmod(binDst, 0o755);
      await fsp.writeFile(npmDst, npmStub);
      execFileSync('tar', ['-czf', path.join(staging, spec.archiveFile), spec.topDir], { cwd: staging });
      buffer = await fsp.readFile(path.join(staging, spec.archiveFile));
    } finally {
      await fsp.rm(staging, { recursive: true, force: true });
    }
  } else {
    const entries = [{ path: `${spec.topDir}/${spec.binRel}`, data: binBytes }];
    entries.push({ path: `${spec.topDir}/${spec.npmRel}`, data: npmStub });
    buffer = buildZip(entries, { method: 'deflate' });
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  return {
    spec,
    buffer,
    sha256,
    shasumsText: `${sha256}  ${spec.archiveFile}\n`,
  };
}

export function startFixtureServer({ repoZip = null, nodeDist = null, failAll = false, trackRequests = false }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (trackRequests) requests.push(req.url);
    const urlPath = req.url.split('?')[0];
    const respond = (status, data, contentType = 'application/octet-stream') => {
      res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': data ? data.length : 0 });
      res.end(req.method === 'HEAD' ? undefined : data);
    };
    if (failAll) {
      respond(404, Buffer.from('{}'));
      return;
    }
    if (urlPath === '/archive.zip' && repoZip) {
      respond(200, repoZip, 'application/zip');
      return;
    }
    if (nodeDist && urlPath === `/${nodeDist.spec.archiveFile}`) {
      respond(200, nodeDist.buffer, 'application/octet-stream');
      return;
    }
    if (nodeDist && urlPath === '/SHASUMS256.txt') {
      respond(200, Buffer.from(nodeDist.shasumsText), 'text/plain');
      return;
    }
    respond(404, Buffer.from('{"error":"missing"}'), 'application/json');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        baseUrl,
        requests,
        fetch: (url, init) => fetch(url.startsWith('http') ? url : `${baseUrl}${url}`, init),
        close: () => new Promise((ok) => server.close(ok)),
      });
    });
  });
}

export async function tempDir(prefix = 'gev-installer-test-') {
  return fsp.mkdtemp(path.join(process.env.TEMP || '/tmp', prefix));
}

export function extractDoneEvents(events) {
  return events.filter((e) => e.type === 'done' || e.type === 'error' || e.type === 'end');
}