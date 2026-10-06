// Simulates GitHub fee-sharing launches on mainnet without signing or spending:
// `node test/simulate-share.mjs <lookup-table> [funded-wallet]`. Also prints sizes against our own shared keys.
import { AddressLookupTableAccount, Connection, Keypair, PublicKey } from '@solana/web3.js';
import { buildLaunch, sharedLaunchKeys } from '../launch.mjs';
const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const creator = new PublicKey(process.argv[3] || '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
const meta = { name: 'Crawl Spider Test', symbol: 'CRAWLT', uri: 'https://ipfs.io/ipfs/bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' };
const longMeta = { name: 'W'.repeat(32), symbol: 'W'.repeat(10), uri: meta.uri };
const shared = await sharedLaunchKeys(conn);
const own = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: shared } });
console.log(`our table would hold ${shared.length} keys`);
const torvalds = process.env.GH_ID || 1024025;
for (const [devBuySol, bps, m] of [[0, 10000, meta], [0.1, 5000, meta], [5, 2500, longMeta]]) {
  const b = await buildLaunch(conn, { creator, mint: Keypair.generate().publicKey, meta: m, devBuySol, table: own, share: { githubId: torvalds, bps } }).catch((e) => ({ err: e.message }));
  if (b.err) { console.log(`own table: dev buy ${devBuySol}, github ${bps / 100}%: refused, ${b.err}`); continue; }
  console.log(`own table: dev buy ${devBuySol}, github ${bps / 100}%, ${m === longMeta ? 'longest name' : 'normal name'}: ${b.size} bytes, priority fee ${b.priority ? 'kept' : 'dropped'}${b.pre ? `, fee address made first (${b.pre.size} bytes)` : ''}`);
}
const table = (await conn.getAddressLookupTable(new PublicKey(process.argv[2]))).value;
for (const [devBuySol, bps] of [[0, 10000], [0.1, 5000]]) {
  const b = await buildLaunch(conn, { creator, mint: Keypair.generate().publicKey, meta, devBuySol, table, share: { githubId: torvalds, bps } });
  if (b.pre) {
    const p = (await conn.simulateTransaction(b.pre.tx, { sigVerify: false, replaceRecentBlockhash: true })).value;
    console.log(`SIMULATED fee address first: err=${JSON.stringify(p.err)} ` + (p.logs || []).filter((l) => /Instruction: /.test(l)).join(' | '));
  }
  const sim = (await conn.simulateTransaction(b.tx, { sigVerify: false, replaceRecentBlockhash: true })).value;
  console.log(`SIMULATED dev buy ${devBuySol}, github ${bps / 100}%: ${b.size} bytes, err=${JSON.stringify(sim.err)}, units=${sim.unitsConsumed}`);
  console.log('  ' + (sim.logs || []).filter((l) => /Instruction: |failed|error/i.test(l)).join('\n  '));
}
