import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crewOf, openDb } from '../crews.mjs';

test('wallets funded from one source across launches form a crew, with how its coins ended', () => {
  const db = openDb(':memory:');
  const L = db.prepare('INSERT INTO launches (mint, t, slot, creator, name, symbol, same_slot, mc0) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const B = db.prepare('INSERT INTO buys (mint, wallet, signature) VALUES (?, ?, ?)');
  const F = db.prepare("INSERT INTO funding (wallet, funder, sol, signature, t) VALUES (?, ?, 1, 's', 0)");
  const O = db.prepare('INSERT INTO outcomes (mint, mc1h, checked1h) VALUES (?, ?, 1)');
  // Two earlier launches and today's, each bought in the launch block by wallets the same funder topped up.
  [['old1', 1], ['old2', 2], ['new', 3]].forEach(([m, i]) => {
    L.run(m, i * 1000, i, 'dev' + i, m, m.toUpperCase(), 3, 28);
    for (const w of ['a', 'b', 'c']) { B.run(m, `${w}${i}`, 'x'); F.run(`${w}${i}`, 'boss'); }
  });
  O.run('old1', 4_200); O.run('old2', 80_000);
  // An exchange funding everyone must not glue strangers together.
  L.run('other', 5, 9, 'devX', 'other', 'OTH', 3, 28);
  B.run('other', 'z1', 'x'); F.run('z1', '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
  B.run('other', 'z2', 'x'); F.run('z2', '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');

  const c = crewOf(db, 'new');
  assert.equal(c.crew.walletsHere, 3);
  assert.deepEqual(c.crew.funders, ['boss']);
  assert.equal(c.crew.launches, 2);
  assert.equal(c.crew.under10kAt1h, 1);
  assert.equal(c.crew.over50kAt1h, 1);
  assert.equal(crewOf(db, 'other').crew, null);
  assert.equal(crewOf(db, 'nope').known, false);
});
