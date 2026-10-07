import assert from 'node:assert/strict';
import { test } from 'node:test';
import { factsOf, SEATS } from '../council.mjs';

test('the council gets the spider facts, and says plainly what is missing', () => {
  const scan = { mint: 'M', name: 'Coin', symbol: 'C', score: 70, checks: [{ status: 'pass', label: 'Mint authority', detail: 'Revoked' }], market: { liquidityUsd: 5000 } };
  const f = factsOf(scan, null, null);
  assert.equal(f.coin.symbol, 'C');
  assert.equal(f.launchBlock, 'not X-rayed');
  assert.equal(f.bundleCrew, 'not checked');
  assert.match(f.checks[0], /PASS · Mint authority: Revoked/);
  const g = factsOf(scan, { mint: 'M', bundle: { sameBlockWallets: 5 }, poolPct: 40, clusters: [{ size: 3, holdsPct: 9, reasons: ['x'] }] }, { crew: { walletsHere: 2, launches: 4, judged: 3, under10kAt1h: 3, over50kAt1h: 0 } });
  assert.equal(g.launchBlock.sameBlockWallets, 5);
  assert.deepEqual(g.bundleCrew, { walletsHere: 2, otherLaunches: 4, wentNowhereIn1h: 3, tookOffIn1h: 0, pending: 1 });
  assert.deepEqual(Object.keys(SEATS), ['lookout', 'skeptic', 'builder', 'timing']);
});
