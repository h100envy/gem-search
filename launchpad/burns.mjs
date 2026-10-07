/**
 * $GEMSEARCH burn stats for gemsearch.fun/burn. Everything here is read from chain: the supply comes from the RPC,
 * and the burns are Token-2022 Burn / BurnChecked instructions decoded from the mint's history read through Helius.
 * burned = initial pump.fun supply - current supply, so it also counts burns made before this page existed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { LaunchError } from './launch.mjs';

export const MINT = 'GQCGitfVw5LYnj4L4zrNUMYeK9dNxEJi9ZjMwMfQpump';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const DECIMALS = 6;
export const INITIAL_SUPPLY = 1_000_000_000;
const CACHE_MS = 60_000;
const BURN = 8, BURN_CHECKED = 15; // SPL token instruction indexes, the same in Token-2022

/** The next scheduled burn: 00:00 or 12:00 UTC, strictly after `now`. */
export function nextBurnAt(now = Date.now()) {
  const half = 12 * 3_600_000;
  return (Math.floor(now / half) + 1) * half;
}

/** Reads a little-endian u64 from bytes[at..at+8] as a BigInt. */
function u64(bytes, at) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i]);
  return v;
}

/**
 * Finds the burns of `mint` in one Helius enhanced transaction. Looks at top-level and inner instructions of the
 * token program, so a burn made through another program still counts. Returns [{amount, wallet}] in whole tokens.
 */
export function burnsInTx(tx, mint = MINT, program = TOKEN_2022, decimals = DECIMALS) {
  const out = [];
  const all = [];
  for (const ix of tx?.instructions ?? []) { all.push(ix); for (const inner of ix.innerInstructions ?? []) all.push(inner); }
  for (const ix of all) {
    if (ix?.programId !== program || !ix.data) continue;
    let data;
    try { data = bs58.decode(ix.data); } catch { continue; }
    if (!(data[0] === BURN || data[0] === BURN_CHECKED) || data.length < 9) continue;
    const accounts = ix.accounts ?? [];
    if (accounts[1] !== mint) continue;
    const raw = u64(data, 1);
    out.push({ amount: Number(raw) / 10 ** decimals, wallet: accounts[2] ?? tx.feePayer ?? null });
  }
  return out;
}

/** Flattens a page of Helius transactions into burn rows, newest first. Failed transactions are skipped. */
export function burnRows(txs, mint = MINT) {
  const rows = [];
  for (const tx of txs ?? []) {
    if (tx?.transactionError) continue;
    for (const b of burnsInTx(tx, mint)) rows.push({ signature: tx.signature, amount: b.amount, wallet: b.wallet, at: (tx.timestamp ?? 0) * 1000 });
  }
  return rows;
}

/** Shapes the public answer. `supply` is in whole tokens. */
export function summarize(supply, recent, now = Date.now()) {
  const burned = Math.max(0, INITIAL_SUPPLY - supply);
  return {
    mint: MINT,
    decimals: DECIMALS,
    initialSupply: INITIAL_SUPPLY,
    supply,
    burned,
    burnedPct: Math.round((burned / INITIAL_SUPPLY) * 10_000) / 100,
    recent,
    nextBurnAt: nextBurnAt(now),
  };
}

const heliusKey = (rpc) => { try { return new URL(rpc).searchParams.get('api-key') || ''; } catch { return ''; } };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const PAGE_GAP = 1_200; // between Helius pages: the key is shared with the scanner and the bot

/**
 * Burns are found by reading the mint's whole history from Helius (100 parsed transactions a page) and decoding the
 * token instructions ourselves: Helius labels burns made through burn-and-close tools as UNKNOWN, so its type=BURN
 * filter misses them. The first run backfills the history once, later runs only read what is newer than the last
 * transaction seen. Progress is kept in a small JSON file so a restart does not start over.
 */
export function createBurnScanner({ rpc, file, fetchPage, gap = PAGE_GAP } = {}) {
  const key = heliusKey(rpc ?? '');
  const live = Boolean(key || fetchPage);
  fetchPage ??= async (before) => {
    const url = `https://api.helius.xyz/v0/addresses/${MINT}/transactions?api-key=${key}&limit=100${before ? `&before=${before}` : ''}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.status === 429) { await sleep(3_000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`helius ${res.status}`);
      return res.json();
    }
    throw new Error('helius rate limit');
  };
  let st = { newest: null, oldest: null, done: false, burns: [] };
  if (file) try { st = { ...st, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { if (file) try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(st)); } catch {} };
  const add = (rows) => {
    const have = new Set(st.burns.map((b) => b.signature + ':' + b.amount));
    for (const r of rows) if (r.amount > 0 && !have.has(r.signature + ':' + r.amount)) { st.burns.push(r); have.add(r.signature + ':' + r.amount); }
    st.burns.sort((a, b) => b.at - a.at);
  };
  let running = null;
  async function sync() {
    if (!live) return;
    // newer than what we have
    let before = '', top = null;
    for (let page = 0; page < 200; page++) {
      const txs = await fetchPage(before);
      if (!Array.isArray(txs) || !txs.length) { if (!st.newest) st.done = true; break; }
      top ??= txs[0].signature;
      const stop = st.newest ? txs.findIndex((t) => t.signature === st.newest) : -1;
      add(burnRows(stop >= 0 ? txs.slice(0, stop) : txs));
      if (!st.newest) { st.oldest = txs[txs.length - 1].signature; break; } // first run: the backfill below reads the rest
      if (stop >= 0) break;
      before = txs[txs.length - 1].signature;
      await sleep(gap);
    }
    if (top) st.newest = top;
    save();
    // older history, until the mint's first transaction
    for (let page = 0; !st.done && page < 200; page++) {
      await sleep(gap);
      const txs = await fetchPage(st.oldest);
      if (!Array.isArray(txs) || !txs.length) { st.done = true; break; }
      add(burnRows(txs));
      st.oldest = txs[txs.length - 1].signature;
      if (page % 10 === 9) save();
    }
    save();
  }
  return {
    sync: () => (running ??= sync().finally(() => { running = null; })),
    recent: (n = 20) => st.burns.slice(0, n),
    state: () => st,
  };
}

let cache = null, pending = null, scanner = null, lookups = [];

/**
 * The connected wallet's $GEMSEARCH account and a fresh blockhash, so the page can build the burn itself: the public
 * Solana RPC refuses calls from browser origins. Read-only; the page signs and the wallet sends.
 */
export async function ownerAccount(conn, owner) {
  let pk;
  try { pk = new PublicKey(String(owner)); } catch { throw new LaunchError(400, 'not a wallet address'); }
  const now = Date.now();
  lookups = lookups.filter((t) => now - t < 60_000);
  if (lookups.length >= 240) throw new LaunchError(429, 'busy; try again in a minute');
  lookups.push(now);
  const [res, bh] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(pk, { mint: new PublicKey(MINT) }),
    conn.getLatestBlockhash('confirmed'),
  ]);
  return { ...pickAccount(res.value), blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight };
}

/** The Token-2022 account holding the most $GEMSEARCH (usually the only one). Balance is a raw integer string. */
export function pickAccount(accounts) {
  let best = null;
  for (const a of accounts ?? []) {
    if (a.account.owner.toString() !== TOKEN_2022) continue;
    const raw = BigInt(a.account.data.parsed.info.tokenAmount.amount);
    if (!best || raw > best.raw) best = { account: a.pubkey.toString(), raw };
  }
  return { account: best?.account ?? null, balance: (best?.raw ?? 0n).toString() };
}

/** GET /v1/burns. The supply is read live (cached a minute); burns come from the scanner, which syncs in the background.
 * With ?owner=<wallet> it also returns that wallet's account, balance and a blockhash for the burn page. */
export async function burnStats(conn, rpc, owner = null, file = join(dirname(process.env.LAUNCH_LOG ?? './data/launches.jsonl'), 'burns.json')) {
  if (owner) return { ...(await stats(conn, rpc, file)), owner: { address: String(owner), ...(await ownerAccount(conn, owner)) } };
  return stats(conn, rpc, file);
}

async function stats(conn, rpc, file) {
  if (!conn) throw new LaunchError(503, 'burn stats are not switched on yet');
  if (!scanner) {
    scanner = createBurnScanner({ rpc, file });
    const run = () => scanner.sync().catch((e) => console.warn('burns: sync failed:', e.message));
    run();
    setInterval(run, CACHE_MS).unref();
  }
  if (cache && Date.now() - cache.at < CACHE_MS) return summarize(cache.supply, scanner.recent());
  pending ??= (async () => {
    try {
      const sup = await conn.getTokenSupply(new PublicKey(MINT));
      cache = { at: Date.now(), supply: Number(sup.value.uiAmountString ?? sup.value.uiAmount) };
      return summarize(cache.supply, scanner.recent());
    } finally { pending = null; }
  })();
  return pending;
}
