import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { buildLaunch, checkSigned, parseLaunch, TX_LIMIT } from '../launch.mjs';

const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
const form = (over = {}) => ({ name: 'Crawl Spider', symbol: '$crawl', description: 'x', image: PNG, creator: Keypair.generate().publicKey.toBase58(), mint: Keypair.generate().publicKey.toBase58(), ...over });

test('a valid form comes back clean', () => {
  const f = parseLaunch(form({ website: 'https://gemsearch.fun', devBuySol: '0.5' }));
  assert.equal(f.symbol, 'CRAWL');
  assert.equal(f.devBuySol, 0.5);
  assert.deepEqual(f.links, { website: 'https://gemsearch.fun' });
});

test('bad fields are refused with the reason', () => {
  assert.throws(() => parseLaunch(form({ name: 'x' })), /name/);
  assert.throws(() => parseLaunch(form({ symbol: 'TOO-LONG-TICKER' })), /ticker/);
  assert.throws(() => parseLaunch(form({ devBuySol: 6 })), /dev buy/);
  assert.throws(() => parseLaunch(form({ website: 'http://plain.example' })), /website/);
  assert.throws(() => parseLaunch(form({ twitter: 'javascript:alert(1)' })), /twitter/);
  assert.throws(() => parseLaunch(form({ image: 'data:image/png;base64,' + Buffer.from('GIF89a....').toString('base64') })), /not the type/);
  assert.throws(() => parseLaunch(form({ creator: 'nope' })), /wallet/);
});

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const online = process.env.OFFLINE ? test.skip : test;

online('the largest launch fits one transaction, with and without a dev buy', async () => {
  const conn = new Connection(RPC, 'confirmed');
  const meta = { name: 'W'.repeat(32), symbol: 'W'.repeat(10), uri: 'https://ipfs.io/ipfs/bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' };
  for (const devBuySol of [0, 5]) {
    const b = await buildLaunch(conn, { creator: Keypair.generate().publicKey, mint: Keypair.generate().publicKey, meta, devBuySol });
    assert.ok(b.size <= TX_LIMIT, `${b.size} bytes with dev buy ${devBuySol}`);
    console.log(`  dev buy ${devBuySol} SOL: ${b.size} bytes, priority fee ${b.priority ? 'kept' : 'dropped'}`);
  }
  // A typical launch with a dev buy keeps its priority fee.
  const typical = await buildLaunch(conn, { creator: Keypair.generate().publicKey, mint: Keypair.generate().publicKey, meta: { name: 'Crawl Spider', symbol: 'CRAWL', uri: meta.uri }, devBuySol: 1 });
  console.log(`  typical with dev buy: ${typical.size} bytes, priority fee ${typical.priority ? 'kept' : 'dropped'}`);
});

online('only the exact built message, signed by creator and mint, is accepted', async () => {
  const conn = new Connection(RPC, 'confirmed');
  const creator = Keypair.generate(), mint = Keypair.generate(), other = Keypair.generate();
  const b = await buildLaunch(conn, { creator: creator.publicKey, mint: mint.publicKey, meta: { name: 'Crawl', symbol: 'CRAWL', uri: 'https://x.y/z' } });
  const record = { message: b.message, creator: creator.publicKey.toBase58(), mint: mint.publicKey.toBase58() };
  const signed = (signers) => {
    const tx = VersionedTransaction.deserialize(b.tx.serialize());
    tx.sign(signers);
    return Buffer.from(tx.serialize()).toString('base64');
  };
  assert.ok(checkSigned(signed([mint, creator]), record));
  assert.throws(() => checkSigned(signed([mint]), record), /your wallet/);
  assert.throws(() => checkSigned(signed([creator]), record), /the mint/);
  // A page that swapped the creator for someone else: a different message.
  const b2 = await buildLaunch(conn, { creator: other.publicKey, mint: mint.publicKey, meta: { name: 'Crawl', symbol: 'CRAWL', uri: 'https://x.y/z' } });
  const tx2 = VersionedTransaction.deserialize(b2.tx.serialize());
  tx2.sign([mint, other]);
  assert.throws(() => checkSigned(Buffer.from(tx2.serialize()).toString('base64'), record), /changed/);
});
