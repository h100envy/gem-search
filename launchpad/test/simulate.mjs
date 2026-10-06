// Simulates real launches on mainnet without signing or spending: `node test/simulate.mjs [funded-wallet]`.
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { buildLaunch } from '../launch.mjs';
const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const creator = new PublicKey(process.argv[2] || '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
for (const devBuySol of [0, 0.1]) {
  const b = await buildLaunch(conn, { creator, mint: Keypair.generate().publicKey, meta: { name: 'Crawl Spider Test', symbol: 'CRAWLT', uri: 'https://ipfs.io/ipfs/bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' }, devBuySol });
  const sim = await conn.simulateTransaction(b.tx, { sigVerify: false, replaceRecentBlockhash: true });
  const v = sim.value;
  console.log(`dev buy ${devBuySol}: ${b.size} bytes, err=${JSON.stringify(v.err)}, units=${v.unitsConsumed}`);
  if (v.err) console.log((v.logs || []).slice(-8).join('\n'));
  else console.log('  ' + (v.logs || []).filter((l) => /Instruction: (CreateV2|Buy)|success/i.test(l)).slice(0, 6).join('\n  '));
}
