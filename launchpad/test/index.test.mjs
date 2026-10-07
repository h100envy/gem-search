import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, emptyDay, launchBlock, record, summary } from '../bundle-index.mjs';

test('launch block counts the other transactions in the creation slot', () => {
  const sigs = [{ signature: 'd', slot: 12 }, { signature: 'c', slot: 10 }, { signature: 'b', slot: 10 }, { signature: 'x', slot: 10, err: {} }, { signature: 'a', slot: 10 }];
  assert.equal(launchBlock(sigs, 'a'), 2);
  assert.equal(launchBlock(sigs, 'zzz'), null);
});

test('verdicts', () => {
  assert.equal(classify(null), 'unknown');
  assert.equal(classify(0), 'clean');
  assert.equal(classify(2), 'sniped');
  assert.equal(classify(3), 'bundled');
});

test('a day adds up and the percentages leave unknowns out', () => {
  const d = emptyDay('2026-10-07');
  const t = Date.parse('2026-10-07T05:00:00Z');
  for (const s of [0, 1, 4, 12, null]) record(d, { mint: 'm' + s, name: 'n', symbol: 'S', devBuyPct: 0, sameSlot: s, t });
  const s = summary(d);
  assert.equal(s.checked, 5);
  assert.equal(s.known, 4);
  assert.equal(s.bundledPct, 50);
  assert.equal(s.top[0].sameSlot, 12);
  assert.equal(s.hours[5].bundled, 2);
  assert.equal(s.sameSlotHist['10+'], 1);
});
