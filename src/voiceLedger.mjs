/**
 * @file Server-side cumulative spend ledger for OpenAI Realtime voice.
 *
 * The client-side cost meter (`src/voice/gevRealtime.js`) is the fast path —
 * it stops a session the moment the per-session cap trips. But it is browser
 * JS, so it is not a gate: a local process or a DNS-rebinding page can mint
 * `/api/realtime/token` secrets directly and never run the meter. This module
 * is the server-side backstop. It is pure (no fs, no process.env) so the
 * budget math is unit-testable with node:test; the vite plugin owns loading
 * and persisting the JSON file under `.gev-cache/`.
 *
 * Budget semantics:
 *  - A daily budget (USD) is enforced per UTC calendar day. The day key rolls
 *    at midnight UTC; the daily counters reset, the totals and mint log stay.
 *  - The ledger is keyed by the API key identity, so swapping keys starts a
 *    fresh ledger instead of inheriting another key's spend.
 *  - "Running estimated cost" is what the client reports when it revokes a
 *    secret on a cap trip. The server never sees OpenAI's bill, so the ledger
 *    is deliberately conservative: it counts only reported spend, and a
 *    per-day mint cap (defense in depth) bounds the damage a client that
 *    never reports cost can do.
 *
 * @module voiceLedger
 */

import { createHash } from 'node:crypto';

/** Bump when the persisted shape changes incompatibly. */
export const VOICE_LEDGER_VERSION = 1;
/** Conservative default daily voice budget (USD). */
export const DEFAULT_VOICE_DAILY_BUDGET_USD = 5.0;
/**
 * Default per-day mint cap. The budget gate alone can be starved by a client
 * that never reports cost; the cap bounds how many live secrets a runaway
 * caller can mint in one day. 100 sessions/day is far beyond a personal
 * project's usage while still stopping a hammering loop.
 */
export const DEFAULT_VOICE_DAILY_MINT_CAP = 100;
/** Cap the persisted mint log so the file cannot grow without bound. */
export const MAX_LEDGER_MINTS = 500;

/**
 * UTC calendar-day key for budget bucketing (matches tomtomTiles.utcDayKey).
 *
 * @param {number} [epochMs=Date.now()] - Timestamp in ms.
 * @returns {string} 'YYYY-MM-DD' in UTC.
 */
export function utcDayKey(epochMs = Date.now()) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Stable short identity for a configured API key. The raw key is never
 * persisted; a 16-hex-char sha256 prefix is enough to detect a key swap.
 *
 * @param {string|undefined} apiKey
 * @returns {string} Identity string ('unconfigured' when no key).
 */
export function ledgerIdentity(apiKey) {
  const raw = String(apiKey || '').trim();
  if (!raw) return 'unconfigured';
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Normalize a persisted ledger against today's identity + day key.
 *
 * - Same identity + same day: return the state (with current budget/cap).
 * - Same identity + different day: reset the daily counters, keep totals and
 *   the mint log (the daily window refreshed).
 * - Different identity (or missing/corrupt state): a fresh ledger.
 *
 * @param {object|null|undefined} state - Persisted ledger.
 * @param {object} [opts]
 * @param {string} [opts.dayKey] - Today's UTC day key.
 * @param {number} [opts.budgetUsd] - Configured daily budget.
 * @param {number} [opts.mintCap] - Configured daily mint cap.
 * @param {string} [opts.identity] - Ledger identity for the current key.
 * @returns {object} Valid ledger for `dayKey`.
 */
export function normalizeLedger(state, { dayKey, budgetUsd, mintCap, identity } = {}) {
  const budget = Number(budgetUsd);
  const validBudget = Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_VOICE_DAILY_BUDGET_USD;
  const cap = Number(mintCap);
  const validCap = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_VOICE_DAILY_MINT_CAP;
  const validIdentity = String(identity || '').trim() || 'unknown';
  const sameIdentity = Boolean(state)
    && state.identity === validIdentity
    && state.version === VOICE_LEDGER_VERSION;
  if (sameIdentity && state.dayKey === dayKey) {
    return { ...state, budgetUsd: validBudget, mintCap: validCap };
  }
  return {
    version: VOICE_LEDGER_VERSION,
    identity: validIdentity,
    budgetUsd: validBudget,
    mintCap: validCap,
    dayKey,
    dayMints: 0,
    dayEstimatedCostUsd: 0,
    totalMints: sameIdentity ? Number(state.totalMints) || 0 : 0,
    totalEstimatedCostUsd: sameIdentity ? Number(state.totalEstimatedCostUsd) || 0 : 0,
    mints: sameIdentity && Array.isArray(state.mints) ? state.mints : [],
  };
}

/**
 * Whether the daily budget is exhausted (no new mints allowed).
 *
 * @param {object|null|undefined} ledger
 * @returns {boolean}
 */
export function isBudgetExhausted(ledger) {
  if (!ledger) return false;
  const spent = Number(ledger.dayEstimatedCostUsd);
  const budget = Number(ledger.budgetUsd);
  return Number.isFinite(spent) && Number.isFinite(budget) && spent >= budget;
}

/**
 * Whether the daily mint cap is reached (defense in depth against clients
 * that never report cost).
 *
 * @param {object|null|undefined} ledger
 * @returns {boolean}
 */
export function isMintCapReached(ledger) {
  if (!ledger) return false;
  const mints = Number(ledger.dayMints);
  const cap = Number(ledger.mintCap);
  return Number.isFinite(mints) && Number.isFinite(cap) && mints >= cap;
}

/**
 * Record one minted client secret. Returns a NEW ledger object (the caller
 * owns persisting it). `now` is injectable for tests.
 *
 * @param {object|null|undefined} ledger
 * @param {object} [opts]
 * @param {string} [opts.secretId] - OpenAI client secret id (`cs_...`).
 * @param {number} [opts.now=Date.now()] - Mint timestamp in ms.
 * @returns {object} Updated ledger.
 */
export function recordMint(ledger, { secretId, now = Date.now() } = {}) {
  const next = normalizeLedger(ledger, {
    dayKey: utcDayKey(now),
    budgetUsd: ledger?.budgetUsd,
    mintCap: ledger?.mintCap,
    identity: ledger?.identity,
  });
  next.dayMints += 1;
  next.totalMints += 1;
  next.mints = [
    ...next.mints,
    {
      id: secretId || null,
      mintedAt: new Date(now).toISOString(),
      estimatedCostUsd: 0,
      revoked: false,
      revokedAt: null,
    },
  ];
  if (next.mints.length > MAX_LEDGER_MINTS) {
    next.mints = next.mints.slice(-MAX_LEDGER_MINTS);
  }
  return next;
}

/**
 * Add a client-reported estimated cost to the ledger. The cost counts toward
 * the daily budget even when the secret id is unknown (e.g. the ledger was
 * reset) — the gate must be conservative. Returns a NEW ledger object.
 *
 * @param {object|null|undefined} ledger
 * @param {object} [opts]
 * @param {string} [opts.secretId] - OpenAI client secret id, when known.
 * @param {number} [opts.costUsd] - Estimated session cost in USD.
 * @param {number} [opts.now=Date.now()] - Report timestamp in ms.
 * @returns {object} Updated ledger.
 */
export function recordCost(ledger, { secretId, costUsd, now = Date.now() } = {}) {
  const next = normalizeLedger(ledger, {
    dayKey: utcDayKey(now),
    budgetUsd: ledger?.budgetUsd,
    mintCap: ledger?.mintCap,
    identity: ledger?.identity,
  });
  const cost = Number(costUsd);
  const delta = Number.isFinite(cost) && cost > 0 ? cost : 0;
  if (delta > 0) {
    next.dayEstimatedCostUsd += delta;
    next.totalEstimatedCostUsd += delta;
  }
  if (secretId) {
    const entry = next.mints.find((m) => m.id === secretId);
    if (entry) {
      entry.estimatedCostUsd = (Number(entry.estimatedCostUsd) || 0) + delta;
    }
  }
  return next;
}

/**
 * Mark a minted secret as revoked (the client reported a cap trip and the
 * server revoked it upstream). Returns a NEW ledger object.
 *
 * @param {object|null|undefined} ledger
 * @param {object} [opts]
 * @param {string} [opts.secretId] - OpenAI client secret id.
 * @param {number} [opts.now=Date.now()] - Revoke timestamp in ms.
 * @returns {object} Updated ledger.
 */
export function markRevoked(ledger, { secretId, now = Date.now() } = {}) {
  const next = normalizeLedger(ledger, {
    dayKey: utcDayKey(now),
    budgetUsd: ledger?.budgetUsd,
    mintCap: ledger?.mintCap,
    identity: ledger?.identity,
  });
  if (secretId) {
    const entry = next.mints.find((m) => m.id === secretId);
    if (entry) {
      entry.revoked = true;
      entry.revokedAt = new Date(now).toISOString();
    }
  }
  return next;
}