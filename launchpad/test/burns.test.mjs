import assert from 'node:assert/strict';
import { test } from 'node:test';
import bs58 from 'bs58';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { burnRows, burnsInTx, createBurnScanner, MINT, pickAccount, nextBurnAt, summarize, TOKEN_2022 } from '../burns.mjs';

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

test('burns are read from top-level and inner token instructions, other mints and failed txs ignored', () => {
  const owner = Keypair.generate().publicKey, acct = Keypair.generate().publicKey;
  const enc = (ix) => ({ programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => k.pubkey.toBase58()), data: bs58.encode(Buffer.from(ix.data)) });
  const top = enc(burnChecked(acct, owner, 5_000_000_000_000n));
  // plain Burn (index 8, no decimals byte) nested under another program
  const plain = { ...top, data: bs58.encode(Buffer.from([8, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0])) };
  const other = { ...top, accounts: [top.accounts[0], Keypair.generate().publicKey.toBase58(), top.accounts[2]] };
  const transfer = { ...top, data: bs58.encode(Buffer.from([12, 1, 0, 0, 0, 0, 0, 0, 0, 6])) };
  const tx = { signature: 's1', timestamp: 1_700_000_000, feePayer: 'payer', instructions: [top, { programId: 'X', accounts: [], data: '', innerInstructions: [plain, other, transfer] }] };
  const b = burnsInTx(tx);
  assert.deepEqual(b, [{ amount: 5_000_000, wallet: owner.toBase58() }, { amount: 1, wallet: owner.toBase58() }]);
  const rows = burnRows([tx, { ...tx, signature: 's2', transactionError: { x: 1 } }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { signature: 's1', amount: 5_000_000, wallet: owner.toBase58(), at: 1_700_000_000_000 });
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

test('the scanner backfills history once, then reads only newer transactions', async () => {
  const owner = Keypair.generate().publicKey, acct = Keypair.generate().publicKey;
  const ix = burnChecked(acct, owner, 2_000_000n);
  const burn = { programId: TOKEN_2022, accounts: ix.keys.map((k) => k.pubkey.toBase58()), data: bs58.encode(Buffer.from(ix.data)) };
  const mk = (i, isBurn) => ({ signature: 'sig' + i, timestamp: 1000 + i, feePayer: 'p', instructions: isBurn ? [burn] : [] });
  let chain = Array.from({ length: 250 }, (_, i) => mk(i, i % 50 === 7)).reverse(); // newest first
  const calls = [];
  const fetchPage = async (before) => {
    calls.push(before);
    const from = before ? chain.findIndex((t) => t.signature === before) + 1 : 0;
    return chain.slice(from, from + 100);
  };
  const sc = createBurnScanner({ fetchPage, gap: 0 });
  await sc.sync();
  assert.equal(sc.state().done, true);
  assert.deepEqual(sc.recent().map((b) => b.signature), ['sig207', 'sig157', 'sig107', 'sig57', 'sig7']);
  assert.equal(sc.recent()[0].amount, 2);
  chain = [mk(251, true), mk(250, false), ...chain];
  calls.length = 0;
  await sc.sync();
  assert.equal(calls.length, 1, 'one page reaches the last seen transaction');
  assert.equal(sc.recent()[0].signature, 'sig251');
  assert.equal(sc.recent().length, 6);
});

test('the burn page gets the Token-2022 account holding the most', () => {
  const acc = (pubkey, owner, amount) => ({ pubkey: { toString: () => pubkey }, account: { owner: { toString: () => owner }, data: { parsed: { info: { tokenAmount: { amount } } } } } });
  assert.deepEqual(pickAccount([acc('a', TOKEN_2022, '5'), acc('b', TOKEN_2022, '900000000000000000'), acc('c', 'Tokenkeg', '999999999999999999')]), { account: 'b', balance: '900000000000000000' });
  assert.deepEqual(pickAccount([]), { account: null, balance: '0' });
});
