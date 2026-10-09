import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { devHistory } from '../scan.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const CREATE = fixture('pump-create-tx');
const BUY = fixture('pump-bundle-buy-tx');
const DEV = 'DvoEJQguWoE2Y6qpmR2MvBZTLf1G2XZjeV54PUCDMCLb';
const MINT = 'CUDaYTpsWoJEakpv62vQgNLG9Jxrm4djmsFTgEaQpump';
const OTHER = 'GQCGitfVw5LYnj4L4zrNUMYeK9dNxEJi9ZjMwMfQpump';

function conn(txs, extra = []) {
  const calls = [];
  const byId = Object.fromEntries(txs.map((t) => [t.transaction.signatures[0], t]));
  const sigs = [...txs.map((t) => ({ signature: t.transaction.signatures[0], err: null })), ...extra];
  return {
    calls,
    async getSignaturesForAddress() { calls.push('sigs'); return sigs; },
    async getParsedTransaction(s, opts) { calls.push('tx'); assert.equal(opts.maxSupportedTransactionVersion, 1); if (!byId[s]) throw new Error('429'); return byId[s]; },
    async getMultipleAccountsInfo(keys) { calls.push('curves'); return keys.map(() => null); },
  };
}

test('dev history counts pump.fun creates the creator launched, over standard RPC', async () => {
  const c = conn([CREATE, BUY]);
  // The list lacks the scanned coin's own launch, so it was cut short: one launch is a floor.
  assert.deepEqual(await devHistory(c, DEV, OTHER), { launches: 1, graduated: 0, capped: true, examined: 2 });
  assert.deepEqual((await devHistory(conn([CREATE]), DEV, MINT)), { launches: 0, graduated: 0, capped: false, examined: 1 });
  assert.deepEqual(c.calls, ['sigs', 'tx', 'tx', 'curves']);
});

test('creates launched by someone else do not count', async () => {
  const many = [CREATE, ...Array.from({ length: 30 }, (_, i) => ({ ...BUY, transaction: { ...BUY.transaction, signatures: [`b${i}`] } }))];
  assert.equal((await devHistory(conn(many), 'B9yfmMTiejApXcQypZcSciADUgjcbQPLw2AgJKVDcANn', OTHER)).launches, 0);
});

test('a short history without the scanned coin\'s own launch was cut short by the node: unknown, not "first launch"', async () => {
  assert.equal(await devHistory(conn([BUY]), DEV, MINT), null);
});

test('unreadable transactions make the history unknown, never a clean first launch', async () => {
  assert.equal(await devHistory(conn([BUY], [{ signature: 'gone', err: null }]), DEV, OTHER), null);
  const partial = await devHistory(conn([CREATE, BUY, { ...BUY, transaction: { ...BUY.transaction, signatures: ['b2'] } }], [{ signature: 'gone', err: null }]), DEV, OTHER);
  assert.equal(partial.launches, 1);
  assert.equal(partial.capped, true);
  assert.equal(partial.examined, 4);
});

test('reads at most 25 transactions, skipping failed ones', async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ signature: `s${i}`, err: i % 2 ? { x: 1 } : null }));
  const c = conn([], many);
  c.getParsedTransaction = async () => { c.calls.push('tx'); return BUY; };
  const h = await devHistory(c, DEV, OTHER);
  assert.equal(c.calls.filter((x) => x === 'tx').length, 25);
  assert.equal(h.capped, true);
});
