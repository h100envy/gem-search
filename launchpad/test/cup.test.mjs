import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rank, weekOf } from '../cup.mjs';

test('weeks run Monday to Monday UTC', () => {
  const w = weekOf(Date.parse('2026-10-08T15:00:00Z')); // a Thursday
  assert.equal(w.id, '2026-10-05');
  assert.equal(w.end - w.start, 7 * 86_400_000);
  assert.equal(weekOf(Date.parse('2026-10-05T00:00:00Z')).id, '2026-10-05');
  assert.equal(weekOf(Date.parse('2026-10-04T23:59:59Z')).id, '2026-09-28');
});

test('one coin per creator, bundled coins out, prizes to the top', () => {
  const rows = [
    { mint: 'a', creator: 'x', marketCap: 50_000, eligible: true },
    { mint: 'b', creator: 'x', marketCap: 90_000, eligible: true },
    { mint: 'c', creator: 'y', marketCap: 200_000, eligible: false },
    { mint: 'd', creator: 'z', marketCap: 30_000, eligible: true },
    { mint: 'e', creator: 'w', marketCap: 10_000, eligible: true },
    { mint: 'f', creator: 'v', marketCap: 5_000, eligible: true },
  ];
  const r = rank(rows, [50, 20, 10]);
  assert.deepEqual(r.map((x) => [x.mint, x.place, x.prize]), [['b', 1, 50], ['d', 2, 20], ['e', 3, 10], ['f', 4, 0]]);
});
