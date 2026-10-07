import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../crews.mjs';
import { initRecord, recordVerdict, trackRecord, outcomeOf } from '../record.mjs';

test('verdicts are scored against what the coin did in 24h', () => {
  const db = openDb(':memory:'); initRecord(db);
  const d = (mint, verdict, votes) => ({ mint, verdict, votes: votes.map(([seat, vote]) => ({ seat, vote })) });
  assert.ok(recordVerdict(db, d('a', 'AVOID', [['skeptic', 'AVOID'], ['builder', 'APE']]), { coin: { symbol: 'A' }, market: { marketCap: 10000 } }, 'web'));
  assert.equal(recordVerdict(db, d('a', 'APE', []), { market: { marketCap: 1 } }, 'web'), false, 'one per coin per 6h');
  assert.equal(recordVerdict(db, d('n', 'APE', []), { market: {} }, 'web'), false, 'needs a market cap');
  recordVerdict(db, d('b', 'APE', [['skeptic', 'AVOID'], ['builder', 'APE']]), { coin: { symbol: 'B' }, market: { marketCap: 10000 } }, 'bot');
  db.exec("UPDATE verdicts SET mc24h = 2000 WHERE mint = 'a'; UPDATE verdicts SET mc24h = 9000 WHERE mint = 'b'");
  const r = trackRecord(db);
  assert.equal(r.judged, 2);
  assert.equal(r.council.right, 50);
  assert.equal(r.byVerdict.AVOID.right, 100);
  assert.equal(r.seats.skeptic.pct, 50);
  assert.equal(r.seats.builder.pct, 0);
  assert.equal(outcomeOf(100, 75), 'WATCH');
});
