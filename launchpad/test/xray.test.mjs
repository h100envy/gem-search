import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { initializesMint, pumpCreates, shapeTx, xrayToken } from '../xray.mjs';

// Recorded mainnet getParsedTransaction results (logMessages dropped): the create_v2 + dev buy of a pump.fun coin,
// and a bundle transaction in the same slot where three wallets bought.
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const CREATE = fixture('pump-create-tx');
const BUY = fixture('pump-bundle-buy-tx');
const MINT = 'CUDaYTpsWoJEakpv62vQgNLG9Jxrm4djmsFTgEaQpump';
const CURVE = '5TrvnDGZHNXfvEDG1CTqXEQCFQ78j4ZuJUsQHo3F9JPR';
const DEV = 'DvoEJQguWoE2Y6qpmR2MvBZTLf1G2XZjeV54PUCDMCLb';
const BUYERS = ['3ygcFEK9ZZUthUfY33SxBAxFcuD5WEbNzVR9q5vDPSLA', '25nwwBVqaKGoJhwk9Roh61FKf5fVyWZVcvZVhr13o9r6', 'B9yfmMTiejApXcQypZcSciADUgjcbQPLw2AgJKVDcANn'];

test('a parsed create transaction becomes the Helius-like shape: the dev buy from the curve, SOL moves, fee payer', () => {
  const t = shapeTx(CREATE);
  assert.equal(t.signature, CREATE.transaction.signatures[0]);
  assert.equal(t.slot, 454440397);
  assert.equal(t.timestamp, 1791434574);
  assert.equal(t.feePayer, DEV);
  assert.equal(t.failed, false);
  assert.equal(t.tokenTransfers.length, 1);
  assert.deepEqual({ ...t.tokenTransfers[0] }, {
    fromUserAccount: CURVE, toUserAccount: DEV, fromTokenAccount: 'ArGZg8vhqjWoT6ZQMHoYr9Uc9qBMVQqGauE61jx2HAJ4', toTokenAccount: 'Fx4STYNYmwpL1x9jZxMTxDvYZwG8UAXHcBCEcjg1ZNA5', mint: MINT, tokenAmount: 7018806.171954,
  });
  assert.ok(t.nativeTransfers.some((n) => n.fromUserAccount === DEV && n.toUserAccount === CURVE && n.amount === 197530863));
  assert.ok(t.nativeTransfers.every((n) => Number.isInteger(n.amount)));
});

test('a bundle transaction lists one transfer per buyer, owners resolved for token accounts created in it', () => {
  const t = shapeTx(BUY);
  assert.deepEqual(t.tokenTransfers.map((x) => [x.fromUserAccount, x.toUserAccount, x.mint]), BUYERS.map((b) => [CURVE, b, MINT]));
  assert.deepEqual(t.tokenTransfers.map((x) => x.tokenAmount), [33760291.14289, 89563635.759366, 119097570.019277]);
});

test('pump.fun creates are found by program id and discriminator, with the mint and the launching wallet', () => {
  assert.deepEqual(pumpCreates(CREATE), [{ mint: MINT, user: DEV, kind: 'create_v2' }]);
  assert.deepEqual(pumpCreates(BUY), []);
  assert.equal(initializesMint(CREATE, MINT), true);
  assert.equal(initializesMint(BUY, MINT), false);
  assert.equal(initializesMint(null, MINT), false);
});

test('a failed transaction moves nothing; a plain transfer takes mint and decimals from the balances; PublicKey objects work', () => {
  assert.deepEqual(shapeTx({ ...CREATE, meta: { ...CREATE.meta, err: { InstructionError: [2, 'x'] } } }).tokenTransfers, []);
  assert.equal(pumpCreates({ ...CREATE, meta: { ...CREATE.meta, err: {} } }).length, 0);
  const A = 'So11111111111111111111111111111111111111112';
  const tx = {
    slot: 1, blockTime: 2,
    transaction: {
      signatures: ['sig'],
      message: {
        accountKeys: [{ pubkey: new PublicKey(DEV) }, { pubkey: new PublicKey(BUYERS[0]) }, { pubkey: new PublicKey(BUYERS[1]) }],
        instructions: [{ program: 'spl-token', programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), parsed: { type: 'transfer', info: { source: BUYERS[0], destination: BUYERS[1], amount: '2500000', authority: DEV } } }],
      },
    },
    meta: {
      err: null, innerInstructions: [],
      preTokenBalances: [{ accountIndex: 1, mint: A, owner: DEV, uiTokenAmount: { decimals: 6 } }, { accountIndex: 2, mint: A, owner: CURVE, uiTokenAmount: { decimals: 6 } }],
      postTokenBalances: [],
    },
  };
  assert.deepEqual(shapeTx(tx).tokenTransfers.map(({ fromUserAccount, toUserAccount, mint, tokenAmount }) => ({ fromUserAccount, toUserAccount, mint, tokenAmount })), [{ fromUserAccount: DEV, toUserAccount: CURVE, mint: A, tokenAmount: 2.5 }]);
  assert.equal(shapeTx(tx).feePayer, DEV);
  assert.equal(shapeTx(null), null);
});

test('SOL passed through a wrapped-SOL account opened and closed in one transaction counts as funding', () => {
  // Recorded: 714pyo opens a WSOL account with 1.112 SOL and closes it straight into a fresh bundle wallet.
  const t = shapeTx(fixture('wsol-funding-tx'));
  assert.deepEqual(t.nativeTransfers, [{ fromUserAccount: '714pyoCyvbHyw4fe16WNaQk6RAAxrcY5Zr9bunP4t1MX', toUserAccount: BUYERS[0], amount: 1112039280, via: 'EgqQVS13ookkfPbWcfvuVFsm8xWhKhmshFxtSzSwfwAo' }]);
});

/** A Connection stand-in answering from the fixtures; `sigs` is what getSignaturesForAddress returns for the mint. */
function fakeConn({ sigs, txs = { [CREATE.transaction.signatures[0]]: CREATE, [BUY.transaction.signatures[0]]: BUY } }) {
  const calls = [];
  const supply = '1000000000000000';
  return {
    calls,
    async getParsedAccountInfo() { calls.push('getParsedAccountInfo'); return { value: { owner: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'), data: { parsed: { type: 'mint', info: { supply, decimals: 6 } } } } }; },
    async getAccountInfo() { calls.push('getAccountInfo'); return null; },
    async getSignaturesForAddress(addr) { calls.push('getSignaturesForAddress'); return addr.toBase58() === MINT ? sigs : []; },
    async getParsedTransaction(sig) { calls.push('getParsedTransaction'); if (!(sig in txs)) throw new Error('down'); return txs[sig]; },
    async getTokenLargestAccounts() { calls.push('getTokenLargestAccounts'); return { value: [{ address: new PublicKey(BUYERS[0]), uiAmount: 1e8 }] }; },
    async getMultipleParsedAccounts(keys) { calls.push('getMultipleParsedAccounts'); return { value: keys.map((k) => (k.toBase58() === BUYERS[0] ? { data: { parsed: { info: { owner: CURVE } } } } : { data: { parsed: { info: { tokenAmount: { uiAmount: 1e7 } } } } })) }; },
  };
}
const sig = (tx, transactionIndex) => ({ signature: tx.transaction.signatures[0], slot: tx.slot, blockTime: tx.blockTime, err: null, transactionIndex });

test('the X-ray reads the launch from standard RPC: dev and bundle buyers in the launch block', async () => {
  const conn = fakeConn({ sigs: [sig(BUY, 26), sig(CREATE, 25)] }); // newest first
  const x = await xrayToken(conn, '', MINT);
  assert.equal(x.reachedStart, true);
  assert.equal(x.launch.signature, CREATE.transaction.signatures[0]);
  assert.equal(x.bundle.sameBlockWallets, 4);
  assert.equal(x.bundle.launchWindowWallets, 4);
  assert.equal(x.coverage.launchTxs, 2);
  assert.equal(x.coverage.launchTxsMissed, 0);
  // 1 mint + 1 curve + 1 signature page + 2 launch txs + 2 holder reads + 1 balance batch + 4 traced wallets' pages.
  assert.equal(conn.calls.length, 12);
});

test('a short signature list from a node without full history is not mistaken for the launch', async () => {
  const x = await xrayToken(fakeConn({ sigs: [sig(BUY, 26)] }), '', MINT);
  assert.equal(x.launch, null);
  assert.equal(x.reachedStart, false);
  assert.equal(x.bundle, null);
});

test('an unreadable launch is unknown, not clean', async () => {
  const x = await xrayToken(fakeConn({ sigs: [sig(BUY, 26), sig(CREATE, 25)], txs: {} }), '', MINT);
  assert.equal(x.launch, null);
  assert.equal(x.bundle, null);
});
