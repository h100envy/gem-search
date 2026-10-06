// Operator commands, run inside the container:
//   node admin.mjs ops     makes the launchpad's own small wallet (once) and prints its address and balance
//   node admin.mjs table   with that wallet funded (~0.01 SOL), makes the lookup table launches share and prints it
//
// The ops wallet pays only for the lookup table. It never touches a launch: launches are paid and signed by their
// creators. Its key stays in the data volume (OPS_KEY_FILE), readable by the container user alone.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { AddressLookupTableProgram, Connection, Keypair, LAMPORTS_PER_SOL, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { sharedLaunchKeys } from './launch.mjs';

const KEY = process.env.OPS_KEY_FILE ?? '/data/ops-key.json';
const conn = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

function ops() {
  if (!existsSync(KEY)) {
    writeFileSync(KEY, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
    chmodSync(KEY, 0o600);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY, 'utf8'))));
}

async function send(payer, instructions) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message());
  tx.sign([payer]);
  const signature = await conn.sendRawTransaction(tx.serialize());
  const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (res.value.err) throw new Error(`transaction failed: ${JSON.stringify(res.value.err)}`);
  return signature;
}

const cmd = process.argv[2];
const wallet = ops();
const balance = await conn.getBalance(wallet.publicKey);
if (cmd === 'ops') {
  console.log(`ops wallet ${wallet.publicKey.toBase58()}, balance ${balance / LAMPORTS_PER_SOL} SOL`);
} else if (cmd === 'table') {
  if (balance < 0.006 * LAMPORTS_PER_SOL) throw new Error(`fund ${wallet.publicKey.toBase58()} with ~0.01 SOL first (has ${balance / LAMPORTS_PER_SOL})`);
  const addresses = await sharedLaunchKeys(conn);
  const slot = await conn.getSlot('finalized');
  const [create, table] = AddressLookupTableProgram.createLookupTable({ authority: wallet.publicKey, payer: wallet.publicKey, recentSlot: slot });
  await send(wallet, [create, AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: wallet.publicKey, payer: wallet.publicKey, addresses })]);
  console.log(`LAUNCH_TABLE=${table.toBase58()}  (${addresses.length} keys; usable from the next slot)`);
} else {
  console.log('usage: node admin.mjs ops|table');
}
