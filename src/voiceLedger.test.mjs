import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_VOICE_DAILY_BUDGET_USD,
  DEFAULT_VOICE_DAILY_MINT_CAP,
  MAX_LEDGER_MINTS,
  VOICE_LEDGER_VERSION,
  isBudgetExhausted,
  isMintCapReached,
  ledgerIdentity,
  markRevoked,
  normalizeLedger,
  recordCost,
  recordMint,
  utcDayKey,
} from './voiceLedger.mjs';

const DAY = '2026-09-07';
const NEXT_DAY = '2026-09-08';
const NOW = Date.parse('2026-09-07T12:00:00Z');
const IDENTITY = 'test-identity';

function freshLedger(overrides = {}) {
  return normalizeLedger(null, {
    dayKey: DAY,
    budgetUsd: DEFAULT_VOICE_DAILY_BUDGET_USD,
    mintCap: DEFAULT_VOICE_DAILY_MINT_CAP,
    identity: IDENTITY,
    ...overrides,
  });
}

test('utcDayKey formats a UTC calendar day', () => {
  assert.equal(utcDayKey(NOW), DAY);
  assert.equal(utcDayKey(Date.parse('2026-09-07T23:59:59Z')), DAY);
  assert.equal(utcDayKey(Date.parse('2026-09-08T00:00:00Z')), NEXT_DAY);
});

test('ledgerIdentity is a stable short hash and never the raw key', () => {
  const a = ledgerIdentity('sk-test-123');
  const b = ledgerIdentity('sk-test-123');
  assert.equal(a, b, 'same key hashes to the same identity');
  assert.equal(a.length, 16, 'identity is a 16-hex-char prefix');
  assert.notEqual(a, 'sk-test-123', 'raw key is never the identity');
  assert.notEqual(ledgerIdentity('sk-test-123'), ledgerIdentity('sk-test-456'), 'different keys differ');
  assert.equal(ledgerIdentity(''), 'unconfigured');
  assert.equal(ledgerIdentity(undefined), 'unconfigured');
});

test('normalizeLedger creates a fresh ledger from nothing', () => {
  const ledger = freshLedger();
  assert.equal(ledger.version, VOICE_LEDGER_VERSION);
  assert.equal(ledger.identity, IDENTITY);
  assert.equal(ledger.dayKey, DAY);
  assert.equal(ledger.budgetUsd, DEFAULT_VOICE_DAILY_BUDGET_USD);
  assert.equal(ledger.mintCap, DEFAULT_VOICE_DAILY_MINT_CAP);
  assert.equal(ledger.dayMints, 0);
  assert.equal(ledger.dayEstimatedCostUsd, 0);
  assert.equal(ledger.totalMints, 0);
  assert.equal(ledger.totalEstimatedCostUsd, 0);
  assert.deepEqual(ledger.mints, []);
});

test('normalizeLedger replaces corrupt state and clamps bad budget/cap', () => {
  const corrupt = normalizeLedger({ version: 99, identity: IDENTITY, dayKey: DAY }, {
    dayKey: DAY,
    budgetUsd: DEFAULT_VOICE_DAILY_BUDGET_USD,
    mintCap: DEFAULT_VOICE_DAILY_MINT_CAP,
    identity: IDENTITY,
  });
  assert.equal(corrupt.version, VOICE_LEDGER_VERSION);
  assert.equal(corrupt.dayMints, 0);

  const badBudget = normalizeLedger(null, {
    dayKey: DAY,
    budgetUsd: -3,
    mintCap: 0,
    identity: IDENTITY,
  });
  assert.equal(badBudget.budgetUsd, DEFAULT_VOICE_DAILY_BUDGET_USD, 'non-positive budget falls back to default');
  assert.equal(badBudget.mintCap, DEFAULT_VOICE_DAILY_MINT_CAP, 'non-positive cap falls back to default');
});

test('recordMint tracks the mint with an injectable timestamp', () => {
  const ledger = recordMint(freshLedger(), { secretId: 'cs_1', now: NOW });
  assert.equal(ledger.dayMints, 1);
  assert.equal(ledger.totalMints, 1);
  assert.equal(ledger.mints.length, 1);
  assert.equal(ledger.mints[0].id, 'cs_1');
  assert.equal(ledger.mints[0].mintedAt, new Date(NOW).toISOString());
  assert.equal(ledger.mints[0].estimatedCostUsd, 0);
  assert.equal(ledger.mints[0].revoked, false);
});

test('recordMint caps the persisted mint log', () => {
  let ledger = freshLedger();
  for (let i = 0; i < MAX_LEDGER_MINTS + 10; i += 1) {
    ledger = recordMint(ledger, { secretId: `cs_${i}`, now: NOW });
  }
  assert.equal(ledger.mints.length, MAX_LEDGER_MINTS);
  assert.equal(ledger.mints[0].id, `cs_${10}`, 'oldest mints are pruned');
  assert.equal(ledger.totalMints, MAX_LEDGER_MINTS + 10, 'totals still count every mint');
});

test('recordCost adds reported spend to the daily budget and the entry', () => {
  let ledger = recordMint(freshLedger(), { secretId: 'cs_1', now: NOW });
  ledger = recordCost(ledger, { secretId: 'cs_1', costUsd: 0.42, now: NOW });
  assert.equal(ledger.dayEstimatedCostUsd, 0.42);
  assert.equal(ledger.totalEstimatedCostUsd, 0.42);
  assert.equal(ledger.mints[0].estimatedCostUsd, 0.42);
});

test('recordCost counts spend even for an unknown secret id (conservative gate)', () => {
  const ledger = recordCost(freshLedger(), { secretId: 'cs_unknown', costUsd: 1.25, now: NOW });
  assert.equal(ledger.dayEstimatedCostUsd, 1.25);
  assert.equal(ledger.totalEstimatedCostUsd, 1.25);
});

test('recordCost ignores invalid cost values', () => {
  let ledger = freshLedger();
  ledger = recordCost(ledger, { secretId: 'cs_1', costUsd: -5, now: NOW });
  ledger = recordCost(ledger, { secretId: 'cs_1', costUsd: 'garbage', now: NOW });
  ledger = recordCost(ledger, { secretId: 'cs_1', costUsd: undefined, now: NOW });
  assert.equal(ledger.dayEstimatedCostUsd, 0);
});

test('markRevoked records the revocation', () => {
  let ledger = recordMint(freshLedger(), { secretId: 'cs_1', now: NOW });
  ledger = markRevoked(ledger, { secretId: 'cs_1', now: NOW });
  assert.equal(ledger.mints[0].revoked, true);
  assert.equal(ledger.mints[0].revokedAt, new Date(NOW).toISOString());
});

test('budget exhaustion refuses mints once reported spend reaches the budget', () => {
  let ledger = freshLedger({ budgetUsd: 5 });
  assert.equal(isBudgetExhausted(ledger), false);
  ledger = recordCost(ledger, { secretId: 'cs_1', costUsd: 4.99, now: NOW });
  assert.equal(isBudgetExhausted(ledger), false, 'under budget still mints');
  ledger = recordCost(ledger, { secretId: 'cs_2', costUsd: 0.01, now: NOW });
  assert.equal(isBudgetExhausted(ledger), true, 'at the budget the gate closes');
});

test('mint cap closes the gate for callers that never report cost', () => {
  let ledger = freshLedger({ mintCap: 3 });
  assert.equal(isMintCapReached(ledger), false);
  for (let i = 0; i < 3; i += 1) {
    ledger = recordMint(ledger, { secretId: `cs_${i}`, now: NOW });
  }
  assert.equal(isMintCapReached(ledger), true);
});

test('refresh-within-window: same-day normalization preserves spend, day rollover resets it', () => {
  let ledger = freshLedger();
  ledger = recordMint(ledger, { secretId: 'cs_1', now: NOW });
  ledger = recordCost(ledger, { secretId: 'cs_1', costUsd: 2.5, now: NOW });

  // Same day: nothing resets.
  const sameDay = normalizeLedger(ledger, {
    dayKey: DAY,
    budgetUsd: DEFAULT_VOICE_DAILY_BUDGET_USD,
    mintCap: DEFAULT_VOICE_DAILY_MINT_CAP,
    identity: IDENTITY,
  });
  assert.equal(sameDay.dayMints, 1);
  assert.equal(sameDay.dayEstimatedCostUsd, 2.5);
  assert.equal(sameDay.totalMints, 1);
  assert.equal(sameDay.totalEstimatedCostUsd, 2.5);

  // Next day: the daily window refreshed, totals and the mint log persist.
  const nextDay = normalizeLedger(ledger, {
    dayKey: NEXT_DAY,
    budgetUsd: DEFAULT_VOICE_DAILY_BUDGET_USD,
    mintCap: DEFAULT_VOICE_DAILY_MINT_CAP,
    identity: IDENTITY,
  });
  assert.equal(nextDay.dayKey, NEXT_DAY);
  assert.equal(nextDay.dayMints, 0, 'daily mint count resets on the new day');
  assert.equal(nextDay.dayEstimatedCostUsd, 0, 'daily spend resets on the new day');
  assert.equal(nextDay.totalMints, 1, 'lifetime totals persist');
  assert.equal(nextDay.totalEstimatedCostUsd, 2.5, 'lifetime spend persists');
  assert.equal(nextDay.mints.length, 1, 'mint log persists');
  assert.equal(isBudgetExhausted(nextDay), false, 'a fresh day can mint again');
});

test('backdated timestamps: a mint recorded yesterday lands in yesterday\'s window', () => {
  const yesterday = Date.parse('2026-09-06T23:00:00Z');
  const ledger = recordMint(freshLedger(), { secretId: 'cs_old', now: yesterday });
  assert.equal(ledger.dayKey, '2026-09-06');
  assert.equal(ledger.dayMints, 1);
  assert.equal(ledger.mints[0].mintedAt, new Date(yesterday).toISOString());
});

test('a different API key identity starts a fresh ledger', () => {
  const ledger = freshLedger();
  const otherKey = normalizeLedger(ledger, {
    dayKey: DAY,
    budgetUsd: DEFAULT_VOICE_DAILY_BUDGET_USD,
    mintCap: DEFAULT_VOICE_DAILY_MINT_CAP,
    identity: 'other-identity',
  });
  assert.equal(otherKey.identity, 'other-identity');
  assert.equal(otherKey.dayMints, 0);
  assert.equal(otherKey.totalMints, 0, 'totals do not leak across identities');
  assert.deepEqual(otherKey.mints, []);
});