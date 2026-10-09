import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRpcPool, parseEndpoints } from '../rpc-pool.mjs';

const ok = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
const rpcError = (code, message) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }), { status: 200 });
const call = async (pool, method, params = []) => (await (await pool.fetch('x', { body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) })).json());
let clock = 0;
const opts = (fetchFn, eps = [{ url: 'a', rps: 100 }, { url: 'b', rps: 100 }]) => ({ endpoints: eps, fetchFn, now: () => clock, sleep: async (ms) => { clock += ms; }, logger: {} });

test('a 429 moves the request to the next endpoint and keeps the caller id', async () => {
  const hits = [];
  const pool = createRpcPool(opts(async (url) => { hits.push(url); return url === 'a' ? new Response('{}', { status: 429 }) : ok(42); }));
  const r = await call(pool, 'getSlot');
  assert.equal(r.result, 42); assert.equal(r.id, 7); assert.deepEqual(hits, ['a', 'b']);
  hits.length = 0; await call(pool, 'getSlot');
  assert.deepEqual(hits, ['b'], 'a stays cooled down for this method');
});

test('403 marks the method unsupported there, other methods still use it', async () => {
  const hits = [];
  const pool = createRpcPool(opts(async (url, init) => { const m = JSON.parse(init.body).method; hits.push(url + ':' + m); return url === 'a' && m === 'getTokenSupply' ? new Response('', { status: 403 }) : ok(1); }));
  await call(pool, 'getTokenSupply'); await call(pool, 'getTokenSupply'); await call(pool, 'getSlot');
  assert.deepEqual(hits, ['a:getTokenSupply', 'b:getTokenSupply', 'b:getTokenSupply', 'a:getSlot']);
});

test('real JSON-RPC errors are returned, not retried', async () => {
  let n = 0;
  const pool = createRpcPool(opts(async () => { n++; return rpcError(-32602, 'Invalid param'); }));
  const r = await call(pool, 'getAccountInfo', ['bad']);
  assert.equal(r.error.code, -32602); assert.equal(n, 1);
});

test('an internal node error is retried elsewhere', async () => {
  const pool = createRpcPool(opts(async (url) => (url === 'a' ? rpcError(-32603, 'Internal JSON-RPC error.') : ok('fine'))));
  assert.equal((await call(pool, 'getAccountInfo', ['z'])).result, 'fine');
});

test('a 429 that still carries a result is accepted', async () => {
  const pool = createRpcPool(opts(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 5 }), { status: 429 })));
  assert.equal((await call(pool, 'getSlot')).result, 5);
});

test('transactions are cached and identical requests share one call', async () => {
  let n = 0;
  const pool = createRpcPool(opts(async () => { n++; return ok({ slot: 1 }); }));
  await Promise.all([call(pool, 'getTransaction', ['s']), call(pool, 'getTransaction', ['s'])]);
  await call(pool, 'getTransaction', ['s']);
  assert.equal(n, 1);
});

test('transaction reads ask for version-1 transactions', async () => {
  let sent;
  const pool = createRpcPool(opts(async (u, init) => { sent = JSON.parse(init.body); return ok({}); }));
  await call(pool, 'getTransaction', ['sig', { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
  assert.equal(sent.params[1].maxSupportedTransactionVersion, 1);
  assert.equal(sent.params[1].encoding, 'jsonParsed');
});

test('a transaction one node does not have is asked elsewhere', async () => {
  const hits = [];
  const pool = createRpcPool(opts(async (url) => { hits.push(url); return ok(url === 'a' ? null : { slot: 9 }); }));
  assert.deepEqual((await call(pool, 'getTransaction', ['old'])).result, { slot: 9 });
  assert.deepEqual(hits, ['a', 'b']);
  const pool2 = createRpcPool(opts(async () => ok(null)));
  assert.equal((await call(pool2, 'getTransaction', ['none'])).result, null);
});

test('a node that keeps missing transactions is asked last', async () => {
  const hits = [];
  const pool = createRpcPool(opts(async (url) => { hits.push(url); return ok(url === 'a' ? null : { slot: 1 }); }));
  for (let i = 0; i < 8; i++) await call(pool, 'getTransaction', ['s' + i]);
  assert.ok(hits.slice(-3).every((h) => h === 'b'), hits.join(','));
});

test('signature history goes only to full-history nodes', async () => {
  const hits = [];
  const pool = createRpcPool(opts(async (url) => { hits.push(url); return ok([]); }, [{ url: 'shallow', rps: 100 }, { url: 'full', rps: 100, full: true }]));
  for (let i = 0; i < 3; i++) await call(pool, 'getSignaturesForAddress', ['m' + i]);
  await call(pool, 'getSlot', []); await call(pool, 'getSlot', [1]);
  assert.deepEqual(hits.slice(0, 3), ['full', 'full', 'full']);
  assert.ok(hits.slice(3).includes('shallow'), 'other methods still use every node');
});

test('a history cursor one node forgot is asked on the others', async () => {
  const hits = [];
  const pool = createRpcPool({ ...opts(async (url) => { hits.push(url); return url === 'a' ? rpcError(-32020, 'Transaction not found') : ok([{ signature: 'x' }]); }), historyAnyNode: true });
  assert.deepEqual((await call(pool, 'getSignaturesForAddress', ['m', { until: 'old' }])).result, [{ signature: 'x' }]);
  const pool2 = createRpcPool({ ...opts(async () => rpcError(-32020, 'Transaction not found')), historyAnyNode: true });
  assert.equal((await call(pool2, 'getSignaturesForAddress', ['m', { until: 'old' }])).error.code, -32020);
});

test('the backup endpoint is used only when the free ones are out', async () => {
  const hits = [];
  const pool = createRpcPool(opts(async (url) => { hits.push(url); return url === 'a' && hits.filter((h) => h === 'a').length > 1 ? new Response('', { status: 429 }) : ok(1); }, [{ url: 'a', rps: 100 }, { url: 'paid', rps: 100, backup: true }]));
  await call(pool, 'getSlot', [1]); await call(pool, 'getSlot', [2]);
  assert.deepEqual(hits, ['a', 'a', 'paid']);
});

test('rps budget spaces requests on one endpoint', async () => {
  clock = 0; const at = [];
  const pool = createRpcPool(opts(async () => { at.push(clock); return ok(1); }, [{ url: 'a', rps: 2 }]));
  for (let i = 0; i < 3; i++) await call(pool, 'getSlot', [i]);
  assert.deepEqual(at, [0, 500, 1000]);
});

test('batch requests are answered in order', async () => {
  const pool = createRpcPool(opts(async (u, init) => ok(JSON.parse(init.body).params[0])));
  const r = await (await pool.fetch('x', { body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'm', params: ['p1'] }, { jsonrpc: '2.0', id: 2, method: 'm', params: ['p2'] }]) })).json();
  assert.deepEqual(r.map((x) => [x.id, x.result]), [[1, 'p1'], [2, 'p2']]);
});

test('endpoint list from env', () => {
  assert.deepEqual(parseEndpoints('https://a|5, https://b, https://c|2|full|0.8'), [{ url: 'https://a', rps: 5 }, { url: 'https://b', rps: 3 }, { url: 'https://c', rps: 2, full: true, historyRps: 0.8 }]);
});
