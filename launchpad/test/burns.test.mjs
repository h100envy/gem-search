import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { _reset, answer, burnRows, burnsInTx, createBurnScanner, MINT, pickAccount, nextBurnAt, summarize, TOKEN_2022 } from '../burns.mjs';

// The same BurnChecked the burn page builds in the browser: [15, amount u64 LE, decimals].
function burnChecked(account, owner, raw, decimals = 6) {
  const data = new Uint8Array(10);
  data[0] = 15;
  new DataView(data.buffer).setBigUint64(1, raw, true);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_2022),
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(MINT), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

test('BurnChecked is encoded as index 15, u64 little-endian amount, decimals', () => {
  const owner = Keypair.generate().publicKey, acct = Keypair.generate().publicKey;
  const ix = burnChecked(acct, owner, 1_234_567_890_123n);
  assert.deepEqual([...ix.data], [15, 0xcb, 0x04, 0xfb, 0x71, 0x1f, 0x01, 0x00, 0x00, 6]);
  assert.equal(ix.keys[0].isWritable && !ix.keys[0].isSigner, true);
  assert.equal(ix.keys[1].pubkey.toBase58(), MINT);
  assert.equal(ix.keys[2].isSigner, true);
  assert.equal(ix.programId.toBase58(), TOKEN_2022);
});

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/burns/${name}.json`, import.meta.url), 'utf8'));

test('real mainnet burns parse to the amounts recorded by the old scanner', () => {
  // top-level burn in a v1 transaction
  assert.deepEqual(burnsInTx(fixture('2yBoFYNo')), [{ amount: 38.574969, wallet: 'GJsEadecNRdFtYA75VxzDdjT5CNQUWfRQ1ZpSkTxpDoQ' }]);
  // inner burn under a burn-and-close tool (v0)
  assert.deepEqual(burnsInTx(fixture('2RitcPEF')), [{ amount: 105.673602, wallet: 'FqUR8Ti5KTmEP1pnm4hjxVszbuECvsagTPdEYX3aBfRu' }]);
  // three inner burns of three mints, only ours counts
  assert.deepEqual(burnsInTx(fixture('4hUT1Wqh')), [{ amount: 0.91229, wallet: 'CD9TnJ8DyqfbAQ8FbNaYxrTE2t7YLa3u2AZWxqpCC5ic' }]);
  // swap then burn: the transferChecked is ignored
  const rows = burnRows(fixture('3jiF1NcQ'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 2811770.289751);
  assert.equal(rows[0].wallet, '35ffdmNmBvqTobSQL6kct1S85wZ8ddUu1P18EUWAzwPA');
  assert.equal(rows[0].signature, fixture('3jiF1NcQ').transaction.signatures[0]);
  assert.equal(rows[0].at, fixture('3jiF1NcQ').blockTime * 1000);
});

/** A parsed transaction shaped like getParsedTransaction's answer. */
function parsedTx(sig, { top = [], inner = [], err = null, blockTime = 1_700_000_000 } = {}) {
  return { blockTime, meta: { err, innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [] }, transaction: { signatures: [sig], message: { instructions: top } } };
}
const burnIx = (amount, { mint = MINT, checked = false, programId = TOKEN_2022, authority = 'owner1' } = {}) => ({
  program: 'spl-token', programId, stackHeight: null,
  parsed: checked
    ? { type: 'burnChecked', info: { account: 'acct', mint, authority, tokenAmount: { amount: String(amount), decimals: 6, uiAmount: amount / 1e6, uiAmountString: String(amount / 1e6) } } }
    : { type: 'burn', info: { account: 'acct', mint, authority, amount: String(amount) } },
});

test('burnChecked, multisig authority and inner burns count; other mints, programs, transfers and failed txs do not', () => {
  const tx = parsedTx('s1', {
    top: [burnIx(5_000_000_000_000, { checked: true }), { programId: 'X', accounts: [], data: '' }],
    inner: [
      burnIx(1_000_000),
      burnIx(7, { mint: 'OtherMint1111111111111111111111111111111111' }),
      burnIx(9, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }),
      { program: 'spl-token', programId: TOKEN_2022, parsed: { type: 'transferChecked', info: { mint: MINT, tokenAmount: { amount: '5', decimals: 6 } } } },
      { program: 'spl-token', programId: TOKEN_2022, parsed: { type: 'burn', info: { account: 'a', mint: MINT, multisigAuthority: 'msig', signers: ['x'], amount: '2000000' } } },
    ],
  });
  assert.deepEqual(burnsInTx(tx), [{ amount: 5_000_000, wallet: 'owner1' }, { amount: 1, wallet: 'owner1' }, { amount: 2, wallet: 'msig' }]);
  assert.deepEqual(burnRows(tx)[0], { signature: 's1', amount: 5_000_000, wallet: 'owner1', at: 1_700_000_000_000 });
  assert.deepEqual(burnRows(parsedTx('s2', { top: [burnIx(1_000_000)], err: { InstructionError: [0, 'x'] } })), []);
  assert.deepEqual(burnRows(null), []);
});

/** A fake Connection over a list of transactions, newest first, counting calls. */
function fakeChain(n, burnEvery = 50) {
  const chain = Array.from({ length: n }, (_, i) => ({ signature: 'sig' + i, err: null, tx: parsedTx('sig' + i, { top: i % burnEvery === 7 ? [burnIx(2_000_000)] : [], blockTime: 1000 + i }) })).reverse();
  const log = { list: [], get: [] };
  const conn = {
    chain, log, failOn: null,
    async getSignaturesForAddress(mint, opts) {
      const { until, before, limit } = opts;
      assert.equal(mint.toBase58(), MINT);
      log.list.push({ ...opts });
      let from = before ? conn.chain.findIndex((t) => t.signature === before) + 1 : 0;
      let to = until ? conn.chain.findIndex((t) => t.signature === until) : conn.chain.length;
      if (to < 0) to = conn.chain.length;
      return conn.chain.slice(from, Math.min(to, from + limit)).map((t) => ({ signature: t.signature, err: t.err, blockTime: t.tx?.blockTime ?? null }));
    },
    async getParsedTransaction(sig, opts) {
      assert.equal(opts.maxSupportedTransactionVersion, 1);
      log.get.push(sig);
      if (conn.failOn === sig) throw new Error('429 Too Many Requests');
      return conn.chain.find((t) => t.signature === sig)?.tx ?? null;
    },
  };
  return conn;
}
const tmpState = (st) => {
  const dir = mkdtempSync(join(tmpdir(), 'burns-'));
  const file = join(dir, 'burns.json');
  if (st) writeFileSync(file, JSON.stringify(st));
  return file;
};

test('an old Helius state file is read as is and only newer transactions are scanned', async () => {
  const conn = fakeChain(250);
  // the production state: burns from the Helius backfill, newest = the newest signature it saw, done backfill
  const file = tmpState({ newest: 'sig199', oldest: 'sig0', done: true, burns: [{ signature: 'sig157', amount: 2, wallet: 'owner1', at: 1157000 }, { signature: 'sig107', amount: 2, wallet: 'owner1', at: 1107000 }] });
  const sc = createBurnScanner({ conn, file, gap: 0 });
  const r = await sc.sync();
  assert.deepEqual(conn.log.list, [{ until: 'sig199', limit: 1000 }]);
  assert.equal(conn.log.get.length, 50, 'only sig200..sig249 are read');
  assert.equal(conn.log.get[0], 'sig200', 'oldest first');
  assert.deepEqual(r, { calls: 51, read: 50, left: 0 });
  assert.deepEqual(sc.recent().map((b) => b.signature), ['sig207', 'sig157', 'sig107']);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.newest, 'sig249');
  assert.equal(saved.oldest, 'sig0');
  assert.equal(saved.burns.length, 3);
  // nothing new: one cheap call
  conn.log.list.length = 0; conn.log.get.length = 0;
  assert.deepEqual(await sc.sync(), { calls: 1, read: 0, left: 0 });
  // a new burn arrives
  conn.chain.unshift({ signature: 'sig250', err: null, tx: parsedTx('sig250', { top: [burnIx(3_000_000)], blockTime: 1250 }) });
  await sc.sync();
  assert.equal(sc.recent()[0].signature, 'sig250');
  assert.equal(sc.recent()[0].amount, 3);
});

test('a state with burns but no cursor goes forward from the newest recorded burn, never back through history', async () => {
  const conn = fakeChain(250);
  const file = tmpState({ burns: [{ signature: 'sig107', amount: 2, wallet: 'owner1', at: 1107000 }, { signature: 'sig157', amount: 2, wallet: 'owner1', at: 1157000 }] });
  const sc = createBurnScanner({ conn, file, gap: 0 });
  assert.equal(sc.state().newest, 'sig157');
  await sc.sync();
  assert.equal(conn.log.list[0].until, 'sig157');
  assert.equal(conn.log.get[0], 'sig158');
  assert.ok(!conn.log.get.includes('sig7'));
  assert.deepEqual(sc.recent().map((b) => b.signature), ['sig207', 'sig157', 'sig107']);
});

test('a node that does not know the cursor transaction is answered by listing from the tip by block time', async () => {
  const conn = fakeChain(250);
  const list = conn.getSignaturesForAddress;
  conn.getSignaturesForAddress = async (mint, opts) => {
    if (opts.until) { const e = new Error('failed to get signatures for address: Transaction sig199 not found'); e.code = -32020; throw e; }
    return list(mint, opts);
  };
  // old-format state: no newestAt, so the newest recorded burn's time bounds the listing
  const sc = createBurnScanner({ conn, file: tmpState({ newest: 'sig199', burns: [{ signature: 'sig157', amount: 2, wallet: 'owner1', at: 1157000 }] }), gap: 0 });
  await sc.sync();
  assert.equal(conn.log.list.at(-1).until, undefined);
  assert.equal(conn.log.get.length, 50, 'stops at the cursor signature');
  assert.equal(sc.state().newest, 'sig249');
  assert.equal(sc.state().newestAt, 1249000);
  assert.deepEqual(sc.recent().map((b) => b.signature), ['sig207', 'sig157']);
});

test('a node whose history ends before the cursor is not trusted', async () => {
  const conn = fakeChain(250);
  const list = conn.getSignaturesForAddress;
  let calls = 0;
  conn.getSignaturesForAddress = async (mint, opts) => {
    calls++;
    if (opts.until) { const e = new Error('Transaction sig199 not found'); e.code = -32020; throw e; }
    return (await list(mint, opts)).slice(0, 20); // keeps only the last few hours
  };
  const sc = createBurnScanner({ conn, file: tmpState({ newest: 'sig199', newestAt: 1199000, burns: [] }), gap: 0 });
  await assert.rejects(sc.sync(), /does not reach/);
  assert.equal(calls, 6, 'three tries, each with until and then by time');
  assert.equal(sc.state().newest, 'sig199', 'cursor untouched');
  assert.equal(conn.log.get.length, 0);
});

test('an empty state starts from the tip without reading any transaction', async () => {
  const conn = fakeChain(250);
  const sc = createBurnScanner({ conn, file: tmpState(), gap: 0 });
  assert.deepEqual(await sc.sync(), { calls: 1, read: 0 });
  assert.equal(sc.state().newest, 'sig249');
  assert.equal(conn.log.get.length, 0);
});

test('work per sync is bounded, failed txs are not read, and an RPC error keeps the cursor at the last processed one', async () => {
  const conn = fakeChain(1000, 100);
  for (const t of conn.chain) if (['sig1', 'sig2'].includes(t.signature)) t.err = { InstructionError: [0, 'x'] };
  const sc = createBurnScanner({ conn, file: tmpState({ newest: 'sig0', burns: [{ signature: 'old', amount: 5, wallet: 'w', at: 1 }] }), gap: 0, maxTx: 300, retry: { backoff: 0 } });
  const r1 = await sc.sync();
  assert.equal(r1.read, 300);
  assert.ok(!conn.log.get.includes('sig1') && !conn.log.get.includes('sig2'), 'failed transactions are skipped from the listing');
  assert.equal(sc.state().newest, 'sig302');
  assert.equal(r1.left, 999 - 302);
  conn.failOn = 'sig400';
  await assert.rejects(sc.sync(), /429/);
  const before = sc.state().newest;
  assert.ok(Number(before.slice(3)) < 400 && Number(before.slice(3)) >= 398, 'cursor stops right before the failure');
  conn.failOn = null;
  conn.log.get.length = 0;
  await sc.sync();
  assert.equal(conn.log.get[0], 'sig' + (Number(before.slice(3)) + 1), 'resumes right after the cursor');
  await sc.sync();
  assert.equal(sc.state().newest, 'sig999');
  assert.deepEqual(sc.recent().map((b) => b.signature).slice(0, 3), ['sig907', 'sig807', 'sig707']);
  assert.equal(sc.recent(50).filter((b) => b.signature.startsWith('sig')).length, 10);
});

test('a transaction the RPC returns null for is retried, then skipped', async () => {
  const conn = fakeChain(10);
  conn.chain = conn.chain.map((t) => (t.signature === 'sig5' ? { ...t, tx: null } : t));
  const sc = createBurnScanner({ conn, file: tmpState({ newest: 'sig2', burns: [] }), gap: 0 });
  await assert.rejects(sc.sync(), /not found/);
  assert.equal(sc.state().newest, 'sig4');
  await assert.rejects(sc.sync(), /not found/);
  await sc.sync();
  assert.equal(sc.state().newest, 'sig9');
});

test('when the RPC is down the endpoint serves the last good numbers flagged stale', async () => {
  _reset();
  const file = tmpState({ newest: 'sig1', burns: [{ signature: 'b', amount: 49_628_331.187587, wallet: 'w', at: 1 }], supply: 950_371_668.812413, supplyAt: 1 });
  const down = { getTokenSupply: async () => { throw new Error('402 Payment Required'); } };
  const sc = createBurnScanner({ conn: down, file, gap: 0 });
  const r = await answer(down, sc, Date.UTC(2026, 9, 8, 1));
  assert.equal(r.stale, true);
  assert.equal(r.supply, 950_371_668.812413);
  assert.equal(r.recent.length, 1);
  // no supply saved: falls back to the sum of recorded burns
  _reset();
  const sc2 = createBurnScanner({ conn: down, file: tmpState({ newest: 'x', burns: [{ signature: 'b', amount: 1000, wallet: 'w', at: 1 }] }) });
  assert.equal((await answer(down, sc2)).burned, 1000);
  // nothing at all: a 503, not a 500
  _reset();
  const sc3 = createBurnScanner({ conn: down, file: tmpState() });
  await assert.rejects(answer(down, sc3), (e) => e.status === 503);
  // back up: fresh numbers, no flag, remembered in the state file
  _reset();
  const up = { getTokenSupply: async () => ({ value: { amount: '950371668812413', decimals: 6, uiAmount: 950371668.812413, uiAmountString: '950371668.812413' } }) };
  const r2 = await answer(up, sc);
  assert.equal(r2.stale, undefined);
  assert.equal(r2.burned, 1_000_000_000 - 950_371_668.812413);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).supply, 950_371_668.812413);
  _reset();
});

test('next burn is the next 00:00 or 12:00 UTC', () => {
  assert.equal(nextBurnAt(Date.UTC(2026, 9, 8, 3, 15)), Date.UTC(2026, 9, 8, 12));
  assert.equal(nextBurnAt(Date.UTC(2026, 9, 8, 12, 0)), Date.UTC(2026, 9, 9, 0));
  assert.equal(nextBurnAt(Date.UTC(2026, 9, 8, 23, 59, 59)), Date.UTC(2026, 9, 9, 0));
});

test('burned is what is missing from the 1B pump.fun supply', () => {
  const s = summarize(950_370_000.5, [], Date.UTC(2026, 9, 8, 1));
  assert.equal(s.burned, 49_629_999.5);
  assert.equal(s.burnedPct, 4.96);
  assert.equal(s.initialSupply, 1_000_000_000);
  assert.equal(s.nextBurnAt, Date.UTC(2026, 9, 8, 12));
  assert.equal(summarize(1_000_000_001, []).burned, 0);
});

test('the burn page gets the Token-2022 account holding the most', () => {
  const acc = (pubkey, owner, amount) => ({ pubkey: { toString: () => pubkey }, account: { owner: { toString: () => owner }, data: { parsed: { info: { tokenAmount: { amount } } } } } });
  assert.deepEqual(pickAccount([acc('a', TOKEN_2022, '5'), acc('b', TOKEN_2022, '900000000000000000'), acc('c', 'Tokenkeg', '999999999999999999')]), { account: 'b', balance: '900000000000000000' });
  assert.deepEqual(pickAccount([]), { account: null, balance: '0' });
});
