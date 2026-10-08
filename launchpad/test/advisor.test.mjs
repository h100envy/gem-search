import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPonsCounter, pickByData } from '../advisor.mjs';

test('higher graduation share wins; close shares go to the smaller crowd', () => {
  const p = (a, b) => pickByData(a, b).pick;
  assert.equal(p({ gradPct: 1.0, sampled: 900, launches24h: 30000 }, { gradPct: 3.0, launches24h: 2000 }), 'robinhood');
  assert.equal(p({ gradPct: 3.0, sampled: 900, launches24h: 30000 }, { gradPct: 0.5, launches24h: 2000 }), 'solana');
  // 1.2% of a 900-coin sample vs 0.7% of 2600: inside the noise, so the smaller crowd wins
  assert.equal(p({ gradPct: 1.2, sampled: 900, launches24h: 30000 }, { gradPct: 0.7, launches24h: 2600 }), 'robinhood');
  assert.match(pickByData({ gradPct: 1.2, sampled: 900, launches24h: 30000 }, { gradPct: 0.7, launches24h: 2600 }).reason, /about the same/);
  assert.equal(p({ gradPct: null }, { gradPct: 1 }), 'robinhood');
  assert.equal(p({ gradPct: null }, { gradPct: null }), null);
});

test('pons counter reads only new blocks and keeps 24h', async () => {
  let head = 1_000_000n; const calls = [];
  const pc = { getBlockNumber: async () => head, getContractEvents: async ({ eventName, fromBlock, toBlock }) => { calls.push([eventName, fromBlock, toBlock]); return eventName === 'TokenLaunched' ? [{ blockNumber: toBlock }] : []; } };
  const now = 1_800_000_000_000;
  const c = createPonsCounter({ pc, now: () => now, pause: async () => {} });
  await c.refresh();
  const first = calls.length;
  assert.ok(first >= 18, 'first fill covers 24h in chunks');
  assert.equal(calls[0][1], head - BigInt(Math.ceil(86_400_000 / 102.5)));
  head += 500n; await c.refresh();
  assert.deepEqual(calls.slice(first).map((x) => [x[1], x[2]]), [[1_000_001n, 1_000_500n], [1_000_001n, 1_000_500n]]);
  assert.equal(c.stats().launches24h, first / 2 + 1);
});
