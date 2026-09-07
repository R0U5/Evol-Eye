import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  deriveAxisSnapshotUrls,
  extractFirstJpegFromMjpg,
  fetchCctvImageFromUpstream,
  isMjpgStreamUrl,
} from '../../vite.config.js';

test('CCTV upstream frame fetch supplies a bounded abort signal', async () => {
  let observedSignal = null;
  const startedAt = Date.now();
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 20,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      observedSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });

  assert.equal(result, null);
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, true);
  assert.ok(Date.now() - startedAt < 500, 'test timeout should settle promptly');
  assert.ok(CCTV_FRAME_FETCH_TIMEOUT_MS < 10_000, 'production timeout must beat the active refresh cadence');
});

test('CCTV upstream frame fetch returns a valid image response', async () => {
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 100,
    fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    }),
  });

  assert.equal(result?.ok, true);
  assert.equal(result?.contentType, 'image/jpeg');
  assert.deepEqual(result?.body, Buffer.from([1, 2, 3]));
});

test('isMjpgStreamUrl detects Axis MJPG stream URLs', () => {
  assert.equal(isMjpgStreamUrl('http://85.4.30.236:80/mjpg/video.mjpg'), true);
  assert.equal(isMjpgStreamUrl('http://88.209.215.194:8801/mjpg/video.mjpg?x=1'), true);
  assert.equal(isMjpgStreamUrl('http://example.com/axis-cgi/jpg/image.cgi'), false);
  assert.equal(isMjpgStreamUrl('https://example.com/frame.jpg'), false);
  assert.equal(isMjpgStreamUrl(null), false);
});

test('deriveAxisSnapshotUrls rewrites MJPG stream URLs to still endpoints', () => {
  const urls = deriveAxisSnapshotUrls('http://85.4.30.236:8080/mjpg/video.mjpg');
  assert.deepEqual(urls, [
    'http://85.4.30.236:8080/mjpg/1/image.jpg?resolution=640x480',
    'http://85.4.30.236:8080/axis-cgi/jpg/image.cgi?resolution=640x480',
  ]);
  assert.deepEqual(deriveAxisSnapshotUrls('https://example.com/frame.jpg'), []);
});

test('extractFirstJpegFromMjpg pulls the first frame out of a multipart body', () => {
  const multipart = Buffer.concat([
    Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n'),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
    Buffer.from([0xff, 0xd9]),
    Buffer.from('\r\n--frame--\r\n'),
  ]);
  const result = extractFirstJpegFromMjpg(multipart, 'multipart/x-mixed-replace');
  assert.equal(result?.ok, true);
  assert.equal(result?.contentType, 'image/jpeg');
  assert.deepEqual(result?.body, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]));
});

test('fetchCctvImageFromUpstream probes Axis still endpoints before buffering the stream', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/mjpg/1/image.jpg')) {
      return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });
    }
    return new Response('no', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  };
  const result = await fetchCctvImageFromUpstream('http://85.4.30.236:8080/mjpg/video.mjpg', {
    timeoutMs: 100,
    fetchImpl,
  });
  assert.equal(result?.ok, true);
  assert.equal(result?.contentType, 'image/jpeg');
  assert.equal(calls[0], 'http://85.4.30.236:8080/mjpg/1/image.jpg?resolution=640x480');
  assert.equal(calls.length, 1, 'should not need to buffer the stream when the still endpoint works');
});

test('fetchCctvImageFromUpstream buffers an MJPG stream and extracts a frame when stills miss', async () => {
  const frame = Buffer.concat([
    Buffer.from('--x\r\nContent-Type: image/jpeg\r\n\r\n'),
    Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]),
    Buffer.from('\r\n--x--\r\n'),
  ]);
  const fetchImpl = async (url) => {
    if (url.includes('/mjpg/1/image.jpg') || url.includes('/axis-cgi/jpg/image.cgi')) {
      return new Response('no', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(frame);
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'multipart/x-mixed-replace' },
    });
  };
  const result = await fetchCctvImageFromUpstream('http://mjx.example:80/mjpg/video.mjpg', {
    timeoutMs: 100,
    fetchImpl,
  });
  assert.equal(result?.ok, true);
  assert.equal(result?.contentType, 'image/jpeg');
  assert.deepEqual(result?.body, Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]));
});
