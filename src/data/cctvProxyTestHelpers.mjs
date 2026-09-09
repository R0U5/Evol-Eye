// src/data/cctvProxyTestHelpers.mjs — mock upstream servers + response doubles
// for the CCTV proxy regression tests (F1 socket teardown, F2 per-IP cap, F5
// content-type mismatch). Zero dependencies; mirrors review/mock-mjpg-server.mjs
// but exposes programmatic start/stop and socket accounting so tests can assert
// that upstream sockets actually close.
import http from 'node:http';
import { Writable } from 'node:stream';

/** @param {number} ms */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `predicate` until it returns truthy or the timeout elapses.
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs=3000]
 * @param {number} [intervalMs=25]
 * @returns {Promise<boolean>}
 */
export async function waitFor(predicate, timeoutMs = 3000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(intervalMs);
  }
  return predicate();
}

/**
 * Start a mock Axis-style MJPEG upstream that streams forever (like a real
 * camera) and tracks open sockets.
 * @returns {Promise<{server: import('node:http').Server, port: number, openSockets: number, accepted: number, close: () => Promise<void>}>}
 */
export function startMockMjpgUpstream() {
  const sockets = new Set();
  let accepted = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' });
    // First frame immediately (browsers want a chunk right away).
    res.write(Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n\xff\xd8\xff\xd9\r\n'));
    // Deliberately leave the connection open forever — like a real Axis cam.
    res.socket?.setTimeout(0);
  });
  server.on('connection', (socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        get openSockets() { return sockets.size; },
        get accepted() { return accepted; },
        close: () => {
          for (const socket of sockets) socket.destroy();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

/**
 * Start a mock upstream that accepts the TCP connection but never responds —
 * simulates a stalled camera handshake.
 * @returns {Promise<{server: import('node:http').Server, port: number, openSockets: number, accepted: number, close: () => Promise<void>}>}
 */
export function startMockStalledUpstream() {
  const sockets = new Set();
  let accepted = 0;
  const server = http.createServer(() => {
    // Never write a response — the handshake stays pending.
  });
  server.on('connection', (socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        get openSockets() { return sockets.size; },
        get accepted() { return accepted; },
        close: () => {
          for (const socket of sockets) socket.destroy();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

/**
 * Start a mock upstream that answers 200 with a non-video content-type (an
 * HTML error page) — the F5 mismatch case.
 * @returns {Promise<{server: import('node:http').Server, port: number, close: () => Promise<void>}>}
 */
export function startMockHtmlUpstream() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>upstream error page</body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * Minimal ServerResponse double: a Writable so stream.pipe(res) works, with
 * writeHead/statusCode/body capture for assertions. destroy() emits 'close'
 * exactly like a real response, which is what triggers the proxy teardown.
 */
export class MockServerResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.body = '';
  }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }

  _write(chunk, encoding, callback) {
    this.body += chunk.toString('utf8');
    callback();
  }

  _final(callback) {
    callback();
  }
}

/**
 * Minimal IncomingMessage double carrying the fields the media handler reads:
 * headers (Range) and socket.remoteAddress (per-IP cap).
 * @param {string} ip
 * @param {Record<string, string>} [headers]
 */
export function mockReq(ip = '127.0.0.1', headers = {}) {
  return { headers, socket: { remoteAddress: ip } };
}