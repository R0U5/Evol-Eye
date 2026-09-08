import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  LIVE_MEDIA_STREAM_CAP,
  deriveAxisSnapshotUrls,
  extractFirstJpegFromMjpg,
  fetchCctvImageFromUpstream,
  isMjpgStreamUrl,
  isPublicCctvUrl,
  liveStreamSlotAvailable,
  normalizeSourceFeedType,
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

test('deriveAxisSnapshotUrls honors a requested resolution for hi-res active reads', () => {
  const hd = deriveAxisSnapshotUrls('http://85.4.30.236:8080/mjpg/video.mjpg', '1280x720');
  assert.deepEqual(hd, [
    'http://85.4.30.236:8080/mjpg/1/image.jpg?resolution=1280x720',
    'http://85.4.30.236:8080/axis-cgi/jpg/image.cgi?resolution=1280x720',
  ]);
  assert.deepEqual(deriveAxisSnapshotUrls('http://x.local/mjpg/video.mjpg', ''), [
    'http://x.local/mjpg/1/image.jpg?resolution=640x480',
    'http://x.local/axis-cgi/jpg/image.cgi?resolution=640x480',
  ]);
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

test('fetchCctvImageFromUpstream refuses a redirect to a non-public host', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'https://example.com/frame.jpg') {
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
      });
    }
    return new Response('unexpected', { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  };
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 100,
    fetchImpl,
  });
  assert.deepEqual(result, { blocked: true });
  assert.deepEqual(calls, ['https://example.com/frame.jpg'], 'the redirect target must never be fetched');
});

test('fetchCctvImageFromUpstream follows a redirect to a public host', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'https://example.com/frame.jpg') {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://cdn.example.net/frame.jpg' },
      });
    }
    return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    });
  };
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 100,
    fetchImpl,
  });
  assert.equal(result?.ok, true);
  assert.equal(result?.contentType, 'image/jpeg');
  assert.deepEqual(calls, ['https://example.com/frame.jpg', 'https://cdn.example.net/frame.jpg']);
});

test('isPublicCctvUrl rejects private, loopback, link-local, and credential URLs', () => {
  assert.equal(isPublicCctvUrl('http://85.4.30.236:8080/mjpg/video.mjpg'), true);
  assert.equal(isPublicCctvUrl('https://cctv.austinmobility.io/image/x.jpg'), true);
  assert.equal(isPublicCctvUrl('http://127.0.0.1:8080/mjpg/video.mjpg'), false);
  assert.equal(isPublicCctvUrl('http://10.0.0.5/mjpg/video.mjpg'), false);
  assert.equal(isPublicCctvUrl('http://192.168.1.10/mjpg/video.mjpg'), false);
  assert.equal(isPublicCctvUrl('http://169.254.169.254/latest/meta-data/'), false);
  assert.equal(isPublicCctvUrl('http://localhost:8080/mjpg/video.mjpg'), false);
  assert.equal(isPublicCctvUrl('http://[::1]/mjpg/video.mjpg'), false);
  assert.equal(isPublicCctvUrl('http://user:pass@example.com/frame.jpg'), false);
  assert.equal(isPublicCctvUrl('ftp://example.com/frame.jpg'), false);
  assert.equal(isPublicCctvUrl('not a url'), false);
});

test('normalizeSourceFeedType: the URL guard wins over a mislabeled feedType', () => {
  // The Axis catalog bug: MJPG stream URLs labeled 'image'. The server must
  // self-heal the catalog at normalize time so the client never sees 'image'.
  assert.equal(
    normalizeSourceFeedType('image', 'http://85.4.30.236:80/mjpg/video.mjpg'),
    'mjpeg',
  );
  assert.equal(
    normalizeSourceFeedType('image', 'http://85.4.30.236:80/mjpg/video.mjpg?resolution=640x480'),
    'mjpeg',
  );
  // Non-MJPG URLs keep their declared type.
  assert.equal(
    normalizeSourceFeedType('image', 'https://cctv.austinmobility.io/image/123.jpg'),
    'image',
  );
  assert.equal(
    normalizeSourceFeedType('mjpeg', 'https://cctv.austinmobility.io/image/123.jpg'),
    'mjpeg',
  );
  // Missing URL falls back to the declared type.
  assert.equal(normalizeSourceFeedType('image', ''), 'image');
  assert.equal(normalizeSourceFeedType('mjpg', ''), 'mjpeg');
});

test('live stream cap: server allows up to LIVE_MEDIA_STREAM_CAP concurrent streams', () => {
  // Fresh module state has no open streams, so a slot is available.
  assert.equal(liveStreamSlotAvailable(), true);
  // The server cap is deliberately higher than the client cap (2) so a second
  // tab or a non-cooperating client can't starve the primary feed.
  assert.equal(LIVE_MEDIA_STREAM_CAP, 4);
  assert.ok(LIVE_MEDIA_STREAM_CAP >= 2, 'server cap must cover at least one client at its cap');
});
