import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  HUD_SUMMARY_UNCONFIGURED_CODE,
  isHudSummaryUnconfigured,
  keylessHudSummaryResponse,
} from './hudSummaryResponse.js';
import {
  hudSummaryProvider,
  openAiRealtimeProxy,
  resetRateLimiterCacheForTests,
} from '../vite.config.js';

const UNCONFIGURED_PAYLOAD = {
  configured: false,
  code: HUD_SUMMARY_UNCONFIGURED_CODE,
  error: null,
  summary: null,
};

function installOpenAiRoutes() {
  const routes = new Map();
  openAiRealtimeProxy().configureServer({
    middlewares: {
      use(path, handler) {
        routes.set(path, handler);
      },
    },
  });
  return routes;
}

function invokeRoute(handler, { method = 'GET', url = '/', remoteAddress = '127.0.0.1', host = 'localhost:4173', body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = new Map();
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { host };
    req.socket = { remoteAddress };
    if (body !== undefined) {
      req.destroy = () => {};
      setImmediate(() => {
        req.emit('data', Buffer.from(String(body), 'utf8'));
        req.emit('end');
      });
    }
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers.set(String(name).toLowerCase(), String(value));
      },
      end(body = '') {
        resolve({
          statusCode: this.statusCode,
          headers: Object.fromEntries(headers),
          body: body ? JSON.parse(String(body)) : null,
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('builds an HTTP-success capability response only when no provider is configured', () => {
  assert.deepEqual(keylessHudSummaryResponse(undefined), {
    statusCode: 200,
    payload: UNCONFIGURED_PAYLOAD,
  });
  assert.deepEqual(keylessHudSummaryResponse({}), {
    statusCode: 200,
    payload: UNCONFIGURED_PAYLOAD,
  });
  assert.deepEqual(keylessHudSummaryResponse({ openAiKey: '  ', ollamaBaseUrl: ' ', ollamaModel: '' }), {
    statusCode: 200,
    payload: UNCONFIGURED_PAYLOAD,
  });
  assert.deepEqual(keylessHudSummaryResponse({ ollamaBaseUrl: 'http://localhost:11434' }), {
    // A lone base URL is not a provider — the model still has to be named.
    statusCode: 200,
    payload: UNCONFIGURED_PAYLOAD,
  });
  assert.equal(keylessHudSummaryResponse({ openAiKey: 'configured-key' }), null);
  assert.equal(keylessHudSummaryResponse({
    openAiKey: 'configured-key',
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'qwen3:8b',
  }), null);
  assert.equal(keylessHudSummaryResponse({
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'qwen3:8b',
  }), null);
});

test('recognizes only the exact deliberate no-key fallback response', () => {
  assert.equal(isHudSummaryUnconfigured(200, UNCONFIGURED_PAYLOAD), true);
  assert.equal(isHudSummaryUnconfigured(503, UNCONFIGURED_PAYLOAD), false);
  assert.equal(isHudSummaryUnconfigured(200, {
    ...UNCONFIGURED_PAYLOAD,
    error: 'provider failed',
  }), false);
  assert.equal(isHudSummaryUnconfigured(200, {
    ...UNCONFIGURED_PAYLOAD,
    summary: 'Unexpected provider output',
  }), false);
  assert.equal(isHudSummaryUnconfigured(200, {
    ...UNCONFIGURED_PAYLOAD,
    configured: true,
  }), false);
  assert.equal(isHudSummaryUnconfigured(200, {
    ...UNCONFIGURED_PAYLOAD,
    unexpected: true,
  }), false);
  assert.equal(isHudSummaryUnconfigured(200, {
    code: HUD_SUMMARY_UNCONFIGURED_CODE,
  }), false);
});

test('does not hide real provider and HTTP failures', () => {
  assert.equal(isHudSummaryUnconfigured(502, {
    code: HUD_SUMMARY_UNCONFIGURED_CODE,
  }), false);
  assert.equal(isHudSummaryUnconfigured(503, UNCONFIGURED_PAYLOAD), false);
  assert.equal(isHudSummaryUnconfigured(200, { error: 'provider failed' }), false);
});

test('the installed keyless HUD route stays successful after the voice quota is exhausted', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousBase = process.env.OPENAI_BASE_URL;
  const previousOllamaBase = process.env.OLLAMA_BASE_URL;
  const previousOllamaModel = process.env.OLLAMA_HUD_SUMMARY_MODEL;
  const previousLimit = process.env.EVOL_RATELIMIT_OPENAI_PER_MIN;
  process.env.OPENAI_API_KEY = '';
  process.env.OPENAI_BASE_URL = '';
  process.env.OLLAMA_BASE_URL = '';
  process.env.OLLAMA_HUD_SUMMARY_MODEL = '';
  process.env.EVOL_RATELIMIT_OPENAI_PER_MIN = '1';
  // Build the rate limiter inside the exact env the test intends it to see.
  resetRateLimiterCacheForTests();
  try {
    const routes = installOpenAiRoutes();
    const token = routes.get('/api/realtime/token');
    const hud = routes.get('/api/openai/hud-summary');
    assert.equal(typeof token, 'function');
    assert.equal(typeof hud, 'function');

    const firstToken = await invokeRoute(token);
    const secondToken = await invokeRoute(token);
    assert.equal(firstToken.statusCode, 503);
    assert.deepEqual(firstToken.body, { error: 'OPENAI_API_KEY is not set' });
    assert.equal(secondToken.statusCode, 429);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await invokeRoute(hud, { method: 'POST' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.body, UNCONFIGURED_PAYLOAD);
    }
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBase;
    if (previousOllamaBase === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previousOllamaBase;
    if (previousOllamaModel === undefined) delete process.env.OLLAMA_HUD_SUMMARY_MODEL;
    else process.env.OLLAMA_HUD_SUMMARY_MODEL = previousOllamaModel;
    if (previousLimit === undefined) delete process.env.EVOL_RATELIMIT_OPENAI_PER_MIN;
    else process.env.EVOL_RATELIMIT_OPENAI_PER_MIN = previousLimit;
  }
});

const OPENAI_HUD_SUMMARY_MODEL_DEFAULT = 'gpt-5-nano';
const HUD_PROVIDER_ENV_VARS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_HUD_SUMMARY_MODEL',
  'OLLAMA_BASE_URL',
  'OLLAMA_HUD_SUMMARY_MODEL',
  'EVOL_RATELIMIT_OPENAI_PER_MIN',
];

/**
 * Run the installed HUD route against a specific env + fetch stub, then fully
 * restore process.env, the global fetch, and the lazily-built rate limiter so
 * tests never leak provider state into each other.
 */
function withProviderRoute(env, fetchImpl, run) {
  return async () => {
    const prior = new Map(HUD_PROVIDER_ENV_VARS.map((name) => [name, process.env[name]]));
    for (const name of HUD_PROVIDER_ENV_VARS) delete process.env[name];
    for (const [name, value] of Object.entries(env)) process.env[name] = value;
    resetRateLimiterCacheForTests();
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url, init });
      return fetchImpl(url, init);
    };
    try {
      const routes = installOpenAiRoutes();
      await run(routes.get('/api/openai/hud-summary'), fetchCalls);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, value] of prior) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      resetRateLimiterCacheForTests();
    }
  };
}

test('hudSummaryProvider selects LOCAL > OpenAI-compatible > OpenAI by environment', () => {
  assert.equal(hudSummaryProvider({}), null);
  assert.equal(hudSummaryProvider({ OPENAI_BASE_URL: 'http://x.local' }), null); // base alone is not a provider
  assert.equal(hudSummaryProvider({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' }), null); // model still required

  assert.deepEqual(hudSummaryProvider({
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434/',
    OLLAMA_HUD_SUMMARY_MODEL: 'qwen3:8b',
  }), {
    source: 'local',
    url: 'http://127.0.0.1:11434/api/chat',
    model: 'qwen3:8b',
  });

  const localWins = hudSummaryProvider({
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    OLLAMA_HUD_SUMMARY_MODEL: 'qwen3:8b',
    OPENAI_API_KEY: 'sk-x',
  });
  assert.equal(localWins.source, 'local');
  assert.equal(localWins.apiKey, undefined); // local never carries a bearer

  const openai = hudSummaryProvider({ OPENAI_API_KEY: 'sk-x' });
  assert.equal(openai.source, 'openai');
  assert.equal(openai.url, 'https://api.openai.com/v1/responses');
  assert.equal(openai.model, OPENAI_HUD_SUMMARY_MODEL_DEFAULT);
  assert.equal(openai.apiKey, 'sk-x');
  assert.equal(hudSummaryProvider({ OPENAI_API_KEY: 'sk-x', OPENAI_HUD_SUMMARY_MODEL: 'gpt-4.1-mini' }).model, 'gpt-4.1-mini');

  const compatible = hudSummaryProvider({ OPENAI_API_KEY: 'sk-x', OPENAI_BASE_URL: 'http://llm.local/' });
  assert.equal(compatible.source, 'openai-compatible');
  assert.equal(compatible.url, 'http://llm.local/v1/chat/completions');
  assert.equal(compatible.apiKey, 'sk-x');
});

test('configured route calls the local Ollama /api/chat endpoint keylessly', withProviderRoute(
  { OLLAMA_BASE_URL: 'http://127.0.0.1:11434', OLLAMA_HUD_SUMMARY_MODEL: 'qwen3:8b' },
  async () => ({ ok: true, status: 200, json: async () => ({ message: { content: 'Fog over the Golden Gate' } }) }),
  async (hud, fetchCalls) => {
    const response = await invokeRoute(hud, {
      method: 'POST',
      body: JSON.stringify({ placeLabels: [] }),
    });
    assert.equal(fetchCalls.length, 1);
    const [call] = fetchCalls;
    assert.equal(call.url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(call.init.headers.Authorization, undefined);
    const sent = JSON.parse(call.init.body);
    assert.equal(sent.model, 'qwen3:8b');
    assert.equal(sent.stream, false);
    assert.deepEqual(sent.options, { num_predict: 100, temperature: 0.3 });
    assert.equal(sent.messages[0].role, 'system');
    assert.equal(sent.messages[1].role, 'user');
    assert.deepEqual(JSON.parse(sent.messages[1].content), { placeLabels: [] });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { summary: 'Fog over the Golden Gate', source: 'local', error: null });
  },
));

test('configured route forwards an OpenAI-compatible chat-completions request with the bearer key', withProviderRoute(
  { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'http://llm.local:8000' },
  async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Fog over the Golden Gate' } }] }) }),
  async (hud, fetchCalls) => {
    const response = await invokeRoute(hud, { method: 'POST', body: '{}' });
    assert.equal(fetchCalls.length, 1);
    const [call] = fetchCalls;
    assert.equal(call.url, 'http://llm.local:8000/v1/chat/completions');
    assert.equal(call.init.headers.Authorization, 'Bearer sk-test');
    const sent = JSON.parse(call.init.body);
    assert.equal(sent.max_tokens, 100);
    assert.equal(sent.stream, undefined);
    assert.equal(sent.instructions, undefined); // chat-completions shape, not Responses shape
    assert.equal(sent.model, OPENAI_HUD_SUMMARY_MODEL_DEFAULT);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { summary: 'Fog over the Golden Gate', source: 'openai-compatible', error: null });
  },
));

test('configured route passes an upstream provider failure through with its HTTP status', withProviderRoute(
  { OPENAI_API_KEY: 'sk-test' },
  async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid api key' } }) }),
  async (hud) => {
    const response = await invokeRoute(hud, { method: 'POST', body: '{}' });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, { summary: null, source: 'openai', error: 'invalid api key' });
  },
));

test('configured route keeps calling the OpenAI Responses API when no base URL is set', withProviderRoute(
  { OPENAI_API_KEY: 'sk-test', OPENAI_HUD_SUMMARY_MODEL: 'gpt-4.1-mini' },
  async () => ({ ok: true, status: 200, json: async () => ({ output_text: 'Fog over the Golden Gate' }) }),
  async (hud, fetchCalls) => {
    const response = await invokeRoute(hud, { method: 'POST', body: '{}' });
    assert.equal(fetchCalls.length, 1);
    const [call] = fetchCalls;
    assert.equal(call.url, 'https://api.openai.com/v1/responses');
    assert.equal(call.init.headers.Authorization, 'Bearer sk-test');
    const sent = JSON.parse(call.init.body);
    assert.equal(sent.model, 'gpt-4.1-mini');
    assert.equal(sent.max_output_tokens, 100);
    assert.equal(typeof sent.instructions, 'string');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { summary: 'Fog over the Golden Gate', source: 'openai', error: null });
  },
));

test('HUD summary refuses a foreign Host header (DNS-rebinding defense)', withProviderRoute(
  { OPENAI_API_KEY: 'sk-test' },
  async () => ({ ok: true, status: 200, json: async () => ({ output_text: 'Fog over the Golden Gate' }) }),
  async (hud, fetchCalls) => {
    const response = await invokeRoute(hud, { method: 'POST', host: 'evil.example.com', body: '{}' });
    assert.equal(response.statusCode, 403);
    assert.match(response.body.error, /local hostnames/);
    assert.equal(fetchCalls.length, 0, 'no upstream call is made for a foreign Host');
  },
));

test('HUD summary rate-limits by default (25/min) even when the env var is unset', withProviderRoute(
  { OPENAI_API_KEY: 'sk-test' },
  async () => ({ ok: true, status: 200, json: async () => ({ output_text: 'Fog over the Golden Gate' }) }),
  async (hud, fetchCalls) => {
    // 25 requests fit within the default window; the 26th is refused.
    for (let i = 0; i < 25; i += 1) {
      const response = await invokeRoute(hud, { method: 'POST', body: '{}' });
      assert.equal(response.statusCode, 200, `request ${i + 1} within the default cap succeeds`);
    }
    const over = await invokeRoute(hud, { method: 'POST', body: '{}' });
    assert.equal(over.statusCode, 429, 'the 26th request is rate-limited by default');
    assert.equal(over.body.error, 'Rate limit exceeded');
    assert.equal(fetchCalls.length, 25, 'only the allowed requests reach the provider');
  },
));

test('HUD summary shares the configured env-var limiter with the token route when set', withProviderRoute(
  { OPENAI_API_KEY: 'sk-test', EVOL_RATELIMIT_OPENAI_PER_MIN: '2' },
  async () => ({ ok: true, status: 200, json: async () => ({ output_text: 'Fog over the Golden Gate' }) }),
  async (hud, fetchCalls) => {
    const first = await invokeRoute(hud, { method: 'POST', body: '{}' });
    const second = await invokeRoute(hud, { method: 'POST', body: '{}' });
    const third = await invokeRoute(hud, { method: 'POST', body: '{}' });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(third.statusCode, 429, 'the env-var cap still applies when set');
    assert.equal(fetchCalls.length, 2);
  },
));
