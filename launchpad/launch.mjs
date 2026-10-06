import { createRequire } from 'node:module';
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

const require = createRequire(import.meta.url);
const { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } = require('@pump-fun/pump-sdk');
const BN = require('bn.js');

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
/** The most a creator can buy of their own coin in the launch transaction. */
export const MAX_DEV_BUY_SOL = 5;
/** Solana's packet limit for one transaction. */
export const TX_LIMIT = 1232;

/** pump.fun's Global and fee config price a first buy; they change rarely, so they are kept ten minutes. */
let globals = null;
export async function pumpGlobals(conn) {
  if (globals && Date.now() - globals.at < 600_000) return globals;
  const sdk = new OnlinePumpSdk(conn);
  const [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig().catch(() => null)]);
  return (globals = { at: Date.now(), global, feeConfig });
}

/**
 * The instructions of a pump.fun launch: create_v2, and the creator's first buy when there is one, as pump.fun's own
 * page builds it. The creator pays and owns the coin; nothing here routes fees anywhere else.
 */
export async function launchInstructions(conn, creator, mint, meta, devBuyLamports = 0n, priority = true) {
  if (devBuyLamports > 0n) {
    const { global, feeConfig } = await pumpGlobals(conn);
    const solAmount = new BN(devBuyLamports.toString());
    // The first buy on a brand-new curve: the token amount is exact; the SOL cap gets 1% of room for rounding.
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount, quoteMint: new PublicKey(SOL_MINT) });
    const create = await PUMP_SDK.createV2AndBuyInstructions({
      global, mint, name: meta.name, symbol: meta.symbol, uri: meta.uri, creator, user: creator,
      amount, solAmount: solAmount.muln(101).divn(100), mayhemMode: false,
    });
    return priority ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 75_000 }), ...create] : create;
  }
  const create = await PUMP_SDK.createV2Instruction({ mint, name: meta.name, symbol: meta.symbol, uri: meta.uri, creator, user: creator, mayhemMode: false });
  return priority ? [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), create] : [create];
}

export class LaunchError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The unsigned launch transaction: the creator pays, the mint (made in the creator's browser) co-signs. A long name
 * with a dev buy can run past Solana's 1232 bytes; then the priority fee goes (about 45 bytes). An address lookup
 * table, when one is configured, makes room for it again.
 */
export async function buildLaunch(conn, { creator, mint, meta, devBuySol = 0, table = null }) {
  const lamports = BigInt(Math.round(Math.min(Math.max(devBuySol, 0), MAX_DEV_BUY_SOL) * 1e9));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  let size = 0;
  for (const priority of [true, false]) {
    const ixs = await launchInstructions(conn, creator, mint, meta, lamports, priority);
    const message = new TransactionMessage({ payerKey: creator, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(table ? [table] : []);
    const tx = new VersionedTransaction(message);
    size = tx.serialize().length;
    if (size <= TX_LIMIT) return { tx, message: Buffer.from(message.serialize()).toString('base64'), lastValidBlockHeight, size, priority };
  }
  throw new LaunchError(400, `that launch does not fit one transaction (${size} of ${TX_LIMIT} bytes): shorten the name or ticker, or lower the dev buy to 0`);
}

/**
 * Takes back the transaction the creator's browser signed: the message must be byte for byte the one built here, and
 * both the creator and the mint must have signed it. A wallet or page that changed anything gets nothing sent.
 */
export function checkSigned(signedBase64, built) {
  let tx;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(signedBase64, 'base64'));
  } catch {
    throw new LaunchError(400, 'that is not a signed transaction');
  }
  if (Buffer.from(tx.message.serialize()).toString('base64') !== built.message) throw new LaunchError(400, 'the transaction was changed after it was built; start the launch again');
  const keys = tx.message.staticAccountKeys;
  for (const [who, key] of [['your wallet', built.creator], ['the mint', built.mint]]) {
    const i = keys.findIndex((k) => k.toBase58() === key);
    if (i < 0 || i >= tx.message.header.numRequiredSignatures || tx.signatures[i].every((b) => b === 0)) throw new LaunchError(400, `the transaction is not signed by ${who}`);
  }
  return tx;
}

const starts = (b, ...sig) => sig.every((x, i) => b[i] === x);
/** The bytes are the image type they claim to be. */
export function imageMatches(contentType, b) {
  if (contentType === 'image/png') return starts(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (contentType === 'image/jpeg') return starts(b, 0xff, 0xd8, 0xff);
  if (contentType === 'image/gif') return starts(b, 0x47, 0x49, 0x46, 0x38);
  if (contentType === 'image/webp') return starts(b, 0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  return false;
}

const URL_RE = /^https:\/\/[^\s]{3,200}$/;
/** The launch form, checked field by field. Returns clean values or throws with the first problem. */
export function parseLaunch(body) {
  if (!body || typeof body !== 'object') throw new LaunchError(400, 'send the launch as JSON');
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const name = str(body.name);
  if (name.length < 2 || name.length > 32) throw new LaunchError(400, 'name: 2 to 32 characters');
  const symbol = str(body.symbol).replace(/^\$/, '').toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) throw new LaunchError(400, 'ticker: 2 to 10 letters or digits');
  const description = str(body.description);
  if (description.length > 500) throw new LaunchError(400, 'description: up to 500 characters');
  const links = {};
  for (const k of ['website', 'twitter', 'telegram']) {
    const v = str(body[k]);
    if (v && !URL_RE.test(v)) throw new LaunchError(400, `${k}: a full https:// link`);
    if (v) links[k] = v;
  }
  const devBuySol = body.devBuySol === undefined || body.devBuySol === '' ? 0 : Number(body.devBuySol);
  if (!Number.isFinite(devBuySol) || devBuySol < 0 || devBuySol > MAX_DEV_BUY_SOL) throw new LaunchError(400, `dev buy: 0 to ${MAX_DEV_BUY_SOL} SOL`);
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(str(body.image));
  if (!m) throw new LaunchError(400, 'image: a PNG, JPEG, WebP or GIF');
  const bytes = new Uint8Array(Buffer.from(m[2], 'base64'));
  if (bytes.length > 2_000_000) throw new LaunchError(400, 'image: up to 2 MB');
  if (!imageMatches(m[1], bytes)) throw new LaunchError(400, 'image: the file is not the type it claims to be');
  let creator, mint;
  try {
    creator = new PublicKey(str(body.creator));
    mint = new PublicKey(str(body.mint));
  } catch {
    throw new LaunchError(400, 'connect a wallet first');
  }
  if (creator.equals(mint)) throw new LaunchError(400, 'the mint must be a fresh key');
  return { name, symbol, description, links, devBuySol, image: { contentType: m[1], bytes }, creator, mint };
}
