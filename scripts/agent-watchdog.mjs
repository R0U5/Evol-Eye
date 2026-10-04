#!/usr/bin/env node
/**
 * Agent Watchdog — standalone background monitor for OpenClaw sessions.
 *
 * Watches a target session via the OpenClaw gateway REST API and emits one
 * structured JSON event per line to stdout so a spawned subagent's progress is
 * visible in real time without passive waiting.
 *
 * Usage:
 *   node agent-watchdog.mjs <target-session-key> [--interval=5000] [--timeout=300000]
 *
 * Options:
 *   --interval=MS   Poll period for sessions_history (default 5000)
 *   --timeout=MS    Stall threshold — no activity for this long = stalled (default 300000)
 *   --limit=N       History window per poll (default 100, max 500)
 *   --token=XX      Gateway bearer token (default: $OPENCLAW_GATEWAY_TOKEN then ~/.openclaw/openclaw.json)
 *   --host=H        Gateway host (default $OPENCLAW_GATEWAY_HOST or localhost)
 *   --port=P        Gateway port (default $OPENCLAW_GATEWAY_PORT or 18789)
 *   --help
 *
 * Events (one JSON object per stdout line):
 *   {"type":"progress", sessionKey, timestamp, summary, details}
 *   {"type":"stall",    sessionKey, timestamp, stalledMs}
 *   {"type":"error",    sessionKey, timestamp, errorDetails}
 *   {"type":"complete", sessionKey, timestamp, summary, success}
 *
 * Lifecycle:
 *   - Emits a baseline progress event on startup.
 *   - Emits progress on new tool calls / file writes / significant output.
 *   - Emits error on tool failures and agent errors in the transcript.
 *   - Emits stall once when idle > --timeout; exits with complete(success=false)
 *     if the stall persists for a second full timeout (hung session / run timeout reached).
 *   - Emits complete and exits cleanly when the session ends (status done/ended)
 *     or the session key disappears / becomes invisible.
 *   - SIGINT/SIGTERM: emits complete(success=null, "watchdog stopped") and exits 0.
 *
 * Requires: Node >= 18 (global fetch), no other deps. Gateway auth must be
 * token/password mode; the token is read from --token, $OPENCLAW_GATEWAY_TOKEN,
 * or the gateway.auth.token in ~/.openclaw/openclaw.json.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_PATH = `${homedir()}/.openclaw/openclaw.json`;

function findTokenInConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return '';
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    try {
      const cfg = JSON.parse(raw);
      const tok = cfg?.gateway?.auth?.token || cfg?.gateway?.auth?.password;
      if (typeof tok === 'string' && tok) return tok;
    } catch { /* fall through to regex scan */ }
    // Regex fallback for JSONC-ish configs:
    const m = raw.match(/"auth"\s*:\s*\{[^}]*?"(?:token|password)"\s*:\s*"([^"]+)"/s);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const args = { interval: 5000, timeout: 300000, limit: 100, token: '', host: '', port: 18789, help: false };
  const positionals = [];

  for (const a of argv) {
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a.startsWith('--interval=')) { args.interval = parseInt(a.split('=', 2)[1], 10); continue; }
    if (a.startsWith('--timeout='))  { args.timeout = parseInt(a.split('=', 2)[1], 10); continue; }
    if (a.startsWith('--limit='))    { args.limit = parseInt(a.split('=', 2)[1], 10); continue; }
    if (a.startsWith('--token='))    { args.token = a.split('=', 2)[1]; continue; }
    if (a.startsWith('--host='))     { args.host = a.split('=', 2)[1]; continue; }
    if (a.startsWith('--port='))     { args.port = parseInt(a.split('=', 2)[1], 10); continue; }
    positionals.push(a);
  }

  args.targetSessionKey = positionals[0] || '';
  args.interval = Number.isFinite(args.interval) ? Math.max(args.interval, 250) : 5000;
  args.timeout  = Number.isFinite(args.timeout)  ? Math.max(args.timeout, 1000) : 300000;
  args.limit    = Number.isFinite(args.limit)    ? Math.min(Math.max(args.limit, 10), 500) : 100;
  args.port     = Number.isFinite(args.port)     ? args.port : 18789;

  if (!args.token) args.token = process.env.OPENCLAW_GATEWAY_TOKEN || findTokenInConfig();
  if (!args.host)  args.host  = process.env.OPENCLAW_GATEWAY_HOST || 'localhost';
  return args;
}

function usage() {
  console.error('Usage: node agent-watchdog.mjs <target-session-key> [--interval=5000] [--timeout=300000]');
  console.error('  --interval=MS  Poll period for sessions_history (default 5000)');
  console.error('  --timeout=MS   Stall threshold — no activity this long = stalled (default 300000)');
  console.error('  --limit=N      History window per poll (default 100, max 500)');
  console.error('  --token=XX     Gateway bearer token (default: $OPENCLAW_GATEWAY_TOKEN or openclaw.json)');
  console.error('  --host=H --port=P  Gateway address (default localhost:18789)');
  console.error('  --help');
  console.error('Emits JSON events to stdout: progress | stall | error | complete');
}

// ---------------------------------------------------------------------------
// Gateway client
// ---------------------------------------------------------------------------

let baseUrl = '';
let bearerToken = '';

function emit(event) {
  console.log(JSON.stringify(event));
}

async function invokeTool(tool, args) {
  const res = await fetch(`${baseUrl}/tools/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    },
    body: JSON.stringify({ tool, args }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Parse the JSON string inside the tool result's first text content block. */
function resultText(result) {
  if (!result?.ok) {
    const err = result?.error || {};
    return { error: err?.message || err?.type || 'tool_error', rawError: result?.error };
  }
  const content = result?.result?.content || [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
      return { text: block.text };
    }
  }
  return { error: 'unexpected tool result shape', raw: result };
}

// ---------------------------------------------------------------------------
// History parsing
// ---------------------------------------------------------------------------

function parseHistory(payload) {
  let data;
  try {
    data = JSON.parse(payload);
  } catch (e) {
    return { error: `malformed history JSON: ${e.message}` };
  }
  if (data && typeof data === 'object' && data.status === 'forbidden') {
    return { forbidden: true, message: data.error || 'session visible: false' };
  }
  if (!Array.isArray(data?.messages)) {
    return { error: `unexpected history payload: ${String(payload).slice(0, 200)}` };
  }
  return { messages: data.messages };
}

function msgSeq(msg) {
  const s = msg?.__openclaw?.seq;
  if (Number.isFinite(s)) return s;
  const id = msg?.__openclaw?.id;
  if (typeof id === 'string' && /^[0-9a-f]+$/i.test(id)) return parseInt(id, 16);
  return null;
}

function msgTime(msg) {
  for (const t of [msg?.timestamp, msg?.__openclaw?.recordTimestampMs, msg?.time?.timestamp]) {
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function msgText(msg) {
  const parts = [];
  const content = Array.isArray(msg?.content) ? msg.content : [];
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue; }
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'toolUse' && block?.name) parts.push(`[uses ${block.name}]`);
  }
  return parts.join('\n').trim();
}

const FILE_WRITE_RE = /^(write|edit|apply_patch|create)$|write|edit|patch/i;
const SIGNIFICANT_OUT_RE = /\b(complete|fail|error|done|fix|commit|test pass|ship|landed)\b/i;

function summarizeMessages(newMsgs) {
  // Compact human summary of the newly-seen messages.
  const tools = [];
  const writes = [];
  const outputs = [];
  let errorBits = [];

  for (const m of newMsgs) {
    const role = m?.role || '?';
    const text = msgText(m);
    if (role === 'toolResult' || (m?.toolName && m?.toolCallId)) {
      const tool = m?.toolName || 'tool';
      tools.push(tool);
      if (FILE_WRITE_RE.test(tool)) writes.push(tool);
      if (m?.isError) errorBits.push(`${tool} failed`);
    } else if (role === 'assistant' && text) {
      const snippet = text.replace(/\s+/g, ' ').slice(0, 120);
      if (text.length > 40 || SIGNIFICANT_OUT_RE.test(text)) outputs.push(snippet);
    } else if (role === 'toolResult' && text && text.length > 60) {
      const snippet = text.replace(/\s+/g, ' ').slice(0, 80);
      if (SIGNIFICANT_OUT_RE.test(text)) outputs.push(snippet);
    }
  }

  const bits = [];
  if (writes.length) bits.push(`${new Set(writes).size} file write(s)`);
  if (tools.length) bits.push(`${tools.length} tool call(s) [${[...new Set(tools)].slice(0, 6).join(', ')}]`);
  if (outputs.length) bits.push(`output: "${outputs[0]}"`);
  if (errorBits.length) bits.push(`ERROR: ${errorBits[0]}`);
  return bits.length ? bits.join(' | ') : `${newMsgs.length} new message(s)`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.targetSessionKey) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  if (!args.token) {
    emit({
      type: 'error',
      sessionKey: args.targetSessionKey,
      timestamp: new Date().toISOString(),
      errorDetails: { message: 'No gateway token found (use --token, $OPENCLAW_GATEWAY_TOKEN, or gateway.auth in ~/.openclaw/openclaw.json)', fatal: true },
    });
    process.exit(1);
  }

  baseUrl = `http://${args.host}:${args.port}`;
  bearerToken = args.token;
  const sessionKey = args.targetSessionKey;

  console.error(`[watchdog] watching ${sessionKey} @ ${baseUrl} every ${args.interval}ms | stall threshold ${args.timeout}ms`);

  let lastSeq = -1n;            // highest message seq observed (BigInt for hex ids)
  let lastActivityMs = Date.now();
  let sessionEnded = false;
  let stallFired = false;
  let fatal = false;
  let sawToolError = false;
  let everSeen = false;
  let lastStatus = null;
  let consecutivePollFailures = 0;

  const nowIso = () => new Date().toISOString();

  const fail = (msg) => {
    fatal = true;
    emit({ type: 'error', sessionKey, timestamp: nowIso(), errorDetails: { message: msg, fatal: true } });
    process.exit(1);
  };

  // --- one sessions_list fetch to get authoritative session status ---
  async function fetchSessionStatus() {
    try {
      const res = await invokeTool('sessions_list', {});
      const { text, error } = resultText(res);
      if (error) return null;
      const data = JSON.parse(text);
      if (!Array.isArray(data?.sessions)) return null;
      const entry = data.sessions.find(s => s?.key === sessionKey);
      if (!entry) return { missing: true };
      return {
        status: entry.status,
        updatedAt: entry.updatedAt,
        endedAt: entry.endedAt,
        startedAt: entry.startedAt,
        childSessions: entry.childSessions,
      };
    } catch {
      return null;
    }
  }

  // --- poll sessions_history ---
  async function pollHistory() {
    const res = await invokeTool('sessions_history', {
      sessionKey,
      limit: args.limit,
      includeTools: true,
    });
    const { text, error, rawError } = resultText(res);
    if (error) {
      // Session gone / invisible = ended from our vantage point.
      throw Object.assign(new Error(error), { ended: true, rawError });
    }
    const hist = parseHistory(text);
    if (hist.forbidden) {
      throw Object.assign(new Error(`session became invisible: ${hist.message}`), { ended: true });
    }
    if (hist.error) throw new Error(hist.error);
    return hist.messages;
  }

  // --- startup baseline ---
  try {
    const messages = await pollHistory();
    everSeen = true;
    for (const m of messages) {
      const s = msgSeq(m);
      if (s !== null && s > lastSeq) lastSeq = s;
      const t = msgTime(m);
      if (t && t > lastActivityMs) lastActivityMs = t;
    }
    const lastMsg = messages.length ? messages[messages.length - 1] : null;
    emit({
      type: 'progress',
      sessionKey,
      timestamp: nowIso(),
      summary: lastMsg ? summarizeMessages([lastMsg]) : 'session live, no transcript yet',
      details: { initial: true, messageCount: messages.length, lastSeq: lastSeq === -1n ? null : String(lastSeq) },
    });
  } catch (e) {
    if (e.ended) {
      emit({ type: 'complete', sessionKey, timestamp: nowIso(), summary: `session not visible at start: ${e.message}`, success: null });
      process.exit(0);
    }
    fail(`initial sessions_history poll failed: ${e.message}`);
  }

  // --- poll loop ---
  while (!sessionEnded && !fatal) {
    await new Promise(r => setTimeout(r, args.interval));

    const t0 = Date.now();

    // 1) History: new messages / errors / activity
    let newMessages = [];
    try {
      const messages = await pollHistory();
      consecutivePollFailures = 0;
      everSeen = true;
      const fresh = [];
      for (const m of messages) {
        const s = msgSeq(m);
        if (s !== null && s > lastSeq) {
          fresh.push(m);
          lastSeq = s;
        } else if (s === null && everSeen) {
          // no seq info: fall back to timestamp delta
          const t = msgTime(m);
          if (t && t > lastActivityMs + 1) fresh.push(m);
        }
        const t = msgTime(m);
        if (t > lastActivityMs) lastActivityMs = t;
      }
      newMessages = fresh;

      if (newMessages.length) {
        stallFired = false;
        const toolErrors = newMessages.filter(m => m?.isError || (m?.role === 'toolResult' && m?.isError));
        for (const em of toolErrors) {
          sawToolError = true;
          emit({
            type: 'error',
            sessionKey,
            timestamp: nowIso(),
            errorDetails: {
              toolName: em?.toolName || 'tool',
              message: msgText(em).replace(/\s+/g, ' ').slice(0, 300) || 'tool result marked isError',
              messageTime: msgTime(em),
            },
          });
        }
        const summary = summarizeMessages(newMessages);
        if (summary) {
          emit({
            type: 'progress',
            sessionKey,
            timestamp: nowIso(),
            summary,
            details: { newMessages: newMessages.length, lastSeq: lastSeq === -1n ? null : String(lastSeq) },
          });
        }
      }
    } catch (e) {
      if (e.ended) {
        // Session history no longer reachable → session ended.
        sessionEnded = true;
        break;
      }
      consecutivePollFailures++;
      if (consecutivePollFailures >= 5) {
        fail(`sessions_history unreachable after ${consecutivePollFailures} consecutive failures: ${e.message}`);
      }
      emit({
        type: 'error',
        sessionKey,
        timestamp: nowIso(),
        errorDetails: { message: `poll failed (${consecutivePollFailures}/5): ${e.message}`, transient: true },
      });
    }

    // 2) Status: authoritative end detection
    if (!sessionEnded) {
      const status = await fetchSessionStatus();
      if (status) {
        if (status.updatedAt && status.updatedAt > lastActivityMs) lastActivityMs = status.updatedAt;
        if (status.status && status.status !== lastStatus) {
          console.error(`[watchdog] session status -> ${status.status}`);
          lastStatus = status.status;
        }
        if (status.endedAt || /^(done|ended|completed|archived|failed|error)$/i.test(status.status || '')) {
          sessionEnded = true;
        }
      } else if (status === null && everSeen) {
        // fetchSessionStatus only returns null on API failure; missing handled inside
      }
    }

    // 3) Stall detection
    if (!sessionEnded) {
      const stalledMs = Date.now() - lastActivityMs;
      if (stalledMs >= args.timeout) {
        if (!stallFired) {
          stallFired = true;
          emit({ type: 'stall', sessionKey, timestamp: nowIso(), stalledMs });
        } else if (stalledMs >= args.timeout * 2) {
          // Hung: no activity for 2x the timeout → run timeout reached.
          emit({
            type: 'complete',
            sessionKey,
            timestamp: nowIso(),
            summary: `no activity for ${stalledMs}ms (>= 2x ${args.timeout}ms timeout)`,
            success: false,
          });
          sessionEnded = true;
        }
      } else {
        stallFired = false;
      }
    }

    // 4) Stall after a completed-looking quiet period is fine; keep looping until ended.
  }

  // --- final summary fetch for the complete event ---
  let finalSummary = 'session ended';
  let success = !sawToolError;
  try {
    if (everSeen) {
      const messages = await pollHistory();
      if (messages.length) {
        const last = messages[messages.length - 1];
        const text = msgText(last).replace(/\s+/g, ' ').slice(0, 200);
        finalSummary = text ? `final: ${text}` : 'session ended';
      }
    }
  } catch {
    // session already gone; keep defaults
  }

  emit({ type: 'complete', sessionKey, timestamp: nowIso(), summary: finalSummary, success });

  console.error(`[watchdog] monitor ended for ${sessionKey} (success=${success})`);
  process.exit(0);
}

process.on('SIGINT', () => {
  const k = process.argv[2] || 'unknown';
  console.log(JSON.stringify({
    type: 'complete',
    sessionKey: k,
    timestamp: new Date().toISOString(),
    summary: 'watchdog stopped by signal',
    success: null,
  }));
  process.exit(0);
});
process.on('SIGTERM', () => {
  const k = process.argv[2] || 'unknown';
  console.log(JSON.stringify({
    type: 'complete',
    sessionKey: k,
    timestamp: new Date().toISOString(),
    summary: 'watchdog stopped by signal',
    success: null,
  }));
  process.exit(0);
});

main().catch((e) => {
  console.error(`[watchdog] fatal: ${e.message}`);
  process.exit(1);
});