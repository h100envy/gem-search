import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../crews.mjs';
import { addToFeed, DEFAULTS, initFeed, parseFilters, passes } from '../feed.mjs';

test('filters parse and launches match them', () => {
  assert.deepEqual(parseFilters('dev=3 block=1').filters, { ...DEFAULTS, dev: 3, block: 1 });
  assert.deepEqual(parseFilters('foo=1 dev=x').bad, ['foo=1', 'dev=x']);
  const clean = { same_slot: 0, dev_buy_pct: 2, twitter: 'https://x.com/a', website: null, telegram: null, dev_24h: 0, crew: 0 };
  assert.ok(passes(clean, DEFAULTS));
  assert.equal(passes({ ...clean, same_slot: 4 }, DEFAULTS), false);
  assert.equal(passes({ ...clean, dev_buy_pct: 12 }, DEFAULTS), false);
  assert.equal(passes({ ...clean, twitter: null }, DEFAULTS), false);
  assert.equal(passes({ ...clean, dev_24h: 5 }, DEFAULTS), false);
  assert.equal(passes({ ...clean, crew: 3 }, DEFAULTS), false);
  assert.ok(passes({ ...clean, crew: 3 }, { ...DEFAULTS, crew: 1 }));
  assert.equal(passes({ ...clean, clones: 2 }, DEFAULTS), false);
});

test('a serial launcher is counted across the day', () => {
  const db = openDb(':memory:'); initFeed(db);
  for (let i = 0; i < 3; i++) addToFeed(db, { mint: 'm' + i, t: 1000 + i, creator: 'dev', name: 'n', symbol: 's', devBuyPct: 1 }, 0, {});
  assert.equal(db.prepare("SELECT dev_24h FROM feed WHERE mint = 'm2'").get().dev_24h, 2);
  assert.equal(db.prepare("SELECT clones FROM feed WHERE mint = 'm2'").get().clones, 2);
});
