import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

async function loadMeta() {
  try {
    return JSON.parse(await readFile(path.join(here, '.evol-install.json'), 'utf8'));
  } catch {
    return {};
  }
}

const meta = await loadMeta();
const appDir = path.resolve(here, String(meta.appDir ?? 'app'));
const port = Number(meta.appPort ?? 4173);
const development = meta.mode === 'development';

const viteBin = path.join(appDir, 'node_modules', 'vite', 'bin', 'vite.js');
const args = development
  ? ['--port', String(port), '--host', '127.0.0.1', '--strictPort']
  : ['preview', '--port', String(port), '--host', '127.0.0.1', '--strictPort'];

const server = spawn(process.execPath, [viteBin, ...args], {
  cwd: appDir,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.on('error', (err) => {
  process.stderr.write(`EVOL Eye could not start: ${err.message}\n`);
  process.exit(1);
});
server.stdout.on('data', (chunk) => process.stdout.write(chunk));
server.stderr.on('data', (chunk) => process.stderr.write(chunk));
server.on('exit', (code) => process.exit(code ?? 0));

const startedAt = Date.now();
let opened = false;
let polling = false;

function openBrowser() {
  if (opened) return;
  opened = true;
  const url = `http://127.0.0.1:${port}/`;
  const cmd = process.platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'start', '', url] }
    : process.platform === 'darwin'
      ? { command: 'open', args: [url] }
      : { command: 'xdg-open', args: [url] };
  spawn(cmd.command, cmd.args, { detached: true, stdio: 'ignore' }).unref();
}

function poll() {
  if (polling) return;
  polling = true;
  const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
    res.resume();
    openBrowser();
  });
  req.on('response', () => {
    polling = false;
  });
  req.on('error', () => {
    polling = false;
    if (Date.now() - startedAt < 40000) {
      setTimeout(poll, 400);
    } else {
      process.stderr.write('EVOL Eye did not become ready in time.\n');
      process.exitCode = 1;
    }
  });
  req.on('timeout', () => req.destroy());
}

setTimeout(poll, 150);