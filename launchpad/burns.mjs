/**
 * $GEMSEARCH burn stats for gemsearch.fun/burn. Everything here is read from chain: the supply comes from the RPC,
 * and the burns are Token-2022 Burn / BurnChecked instructions read from the mint's history with standard JSON-RPC
 * (getSignaturesForAddress + getParsedTransaction), so any free public endpoint serves it.
 * burned = initial pump.fun supply - current supply, so it also counts burns made before this page existed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { LaunchError } from './launch.mjs';

export const MINT = 'GQCGitfVw5LYnj4L4zrNUMYeK9dNxEJi9ZjMwMfQpump';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const DECIMALS = 6;
export const INITIAL_SUPPLY = 1_000_000_000;
const CACHE_MS = 60_000;

/** The next scheduled burn: 00:00 or 12:00 UTC, strictly after `now`. */
export function nextBurnAt(now = Date.now()) {
  const half = 12 * 3_600_000;
  return (Math.floor(now / half) + 1) * half;
}

/**
 * Finds the burns of `mint` in one jsonParsed transaction (Connection.getParsedTransaction). Looks at top-level and
 * inner instructions of the token program, so a burn made through another program (burn-and-close tools, swaps) still
 * counts. Returns [{amount, wallet}] in whole tokens.
 */
export function burnsInTx(tx, mint = MINT, program = TOKEN_2022, decimals = DECIMALS) {
  const out = [];
  const all = [...(tx?.transaction?.message?.instructions ?? [])];
  for (const group of tx?.meta?.innerInstructions ?? []) all.push(...(group.instructions ?? []));
  for (const ix of all) {
    if (String(ix?.programId) !== program) continue;
    const p = ix.parsed;
    if (!p || typeof p !== 'object' || !(p.type === 'burn' || p.type === 'burnChecked')) continue;
    const info = p.info ?? {};
    if (info.mint !== mint) continue;
    const raw = info.tokenAmount?.amount ?? info.amount;
    if (raw == null) continue;
    let units;
    try { units = BigInt(raw); } catch { continue; }
    const dec = info.tokenAmount?.decimals ?? decimals;
    out.push({ amount: Number(units) / 10 ** dec, wallet: info.authority ?? info.multisigAuthority ?? null });
  }
  return out;
}

/** Burn rows of one parsed transaction, for the page and the state file. Failed transactions burn nothing. */
export function burnRows(tx, signature = tx?.transaction?.signatures?.[0], mint = MINT) {
  if (!tx || tx.meta?.err) return [];
  return burnsInTx(tx, mint).map((b) => ({ signature, amount: b.amount, wallet: b.wallet, at: (tx.blockTime ?? 0) * 1000 }));
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

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const rateLimited = (e) => /429|rate|too many/i.test(String(e?.message ?? e)) || e?.code === 429 || e?.code === -32429;

/** Runs an RPC call, waiting and retrying when the free endpoint says 429. */
async function withRetry(fn, { tries = 4, backoff = 1_500 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (attempt >= tries || !rateLimited(e)) throw e;
      await sleep(backoff * attempt);
    }
  }
}

export const MAX_TX_PER_SYNC = 300; // free RPCs allow a few requests a second; the rest waits for the next minute
const LIST_LIMIT = 1000; // getSignaturesForAddress maximum
const LIST_PAGES = 20; // at most 20k signatures listed per sync after a long downtime
const NULL_SKIP = 3; // a transaction the RPC keeps returning null for is skipped after this many syncs

/**
 * Burns are found with standard JSON-RPC only: getSignaturesForAddress(mint, { until: newest processed }) lists what
 * is new, getParsedTransaction reads each one (two at a time), and the parsed Burn / BurnChecked token instructions
 * are picked out, inner ones included. Only the forward direction is ever read: the history before this scanner
 * existed (~12k transactions) is already in the state file and is never rescanned. A fresh state with nothing in it
 * starts from the current tip. At most `maxTx` transactions are read per sync, oldest first, so `newest` always marks
 * a contiguous processed prefix and the next sync continues from there. State lives in a small JSON file:
 * { newest, newestAt, oldest, done, burns, supply, supplyAt }; `oldest` and `done` are left from the old Helius backfill,
 * `newestAt` (block time of `newest`) is missing there and taken from the newest recorded burn until the first read.
 */
export function createBurnScanner({ conn, file, maxTx = MAX_TX_PER_SYNC, concurrency = 2, gap = 300, retry = {} } = {}) {
  let st = { newest: null, oldest: null, done: false, burns: [], supply: null, supplyAt: 0 };
  if (file) try { st = { ...st, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch {}
  if (!Array.isArray(st.burns)) st.burns = [];
  st.burns.sort((a, b) => b.at - a.at);
  // an interrupted old backfill could leave burns without a cursor: go forward from the newest recorded burn
  if (!st.newest && st.burns.length) st.newest = st.burns[0].signature;
  const save = () => { if (file) try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(st)); } catch {} };
  const add = (rows) => {
    const have = new Set(st.burns.map((b) => b.signature + ':' + b.amount));
    for (const r of rows) if (r.amount > 0 && !have.has(r.signature + ':' + r.amount)) { st.burns.push(r); have.add(r.signature + ':' + r.amount); }
    st.burns.sort((a, b) => b.at - a.at);
  };
  const nulls = new Map();
  const mint = new PublicKey(MINT);
  let calls = 0;
  const rpc = (fn) => { calls++; return withRetry(fn, retry); };

  async function sync() {
    if (!conn) return { calls: 0, read: 0 };
    calls = 0;
    // 1. what is new, newest first, down to the last processed signature. Some free nodes keep a short index and
    // answer `until` with "Transaction ... not found" (-32020); then list from the tip and stop by block time instead.
    const since = st.newestAt ?? st.burns[0]?.at ?? 0;
    const list = async (byTime) => {
      const out = [];
      let before;
      for (let page = 0; page < LIST_PAGES; page++) {
        const opts = { limit: LIST_LIMIT };
        if (st.newest && !byTime) opts.until = st.newest;
        if (before) opts.before = before;
        const sigs = await rpc(() => conn.getSignaturesForAddress(mint, opts, 'confirmed'));
        if (byTime) {
          const k = sigs.findIndex((x) => x.signature === st.newest || (x.blockTime != null && x.blockTime * 1000 < since));
          if (k >= 0) { out.push(...sigs.slice(0, k)); return out; }
        }
        out.push(...sigs);
        // a short page without the cursor in it: this node's history ends before it (free nodes keep hours, not
        // days), so trusting it would silently drop burns
        if (byTime && sigs.length < LIST_LIMIT) throw new Error('the RPC history does not reach the last processed transaction');
        if (!st.newest || sigs.length < LIST_LIMIT) return out;
        before = sigs[sigs.length - 1].signature;
        if (page === LIST_PAGES - 1) console.warn(`burns: more than ${LIST_PAGES * LIST_LIMIT} new transactions, older ones skipped`);
        await sleep(gap);
      }
      return out;
    };
    const cursorUnknown = (e) => e?.code === -32020 || /not found|does not reach/i.test(String(e?.message));
    let fresh;
    for (let attempt = 1; !fresh; attempt++) { // the pool may send the next try to a node with a longer history
      try { fresh = await list(false); } catch (e) {
        if (!(st.newest && since && cursorUnknown(e))) throw e;
        try { fresh = await list(true); } catch (e2) {
          if (attempt >= 3 || !cursorUnknown(e2)) throw e2;
          await sleep(gap * 3);
        }
      }
    }
    if (!st.newest) { // fresh state: never backfill the whole history on a free RPC, start from the tip
      st.newest = fresh[0]?.signature ?? null;
      st.newestAt = fresh[0]?.blockTime ? fresh[0].blockTime * 1000 : null;
      st.done = true;
      save();
      return { calls, read: 0 };
    }
    // 2. read them oldest first, a bounded batch, `concurrency` at a time; failed transactions are not read at all
    const queue = fresh.reverse();
    const fetchTx = (sig) => rpc(() => conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }));
    let read = 0, i = 0, failure = null;
    while (i < queue.length && read < maxTx && !failure) {
      const chunk = queue.slice(i, i + Math.min(concurrency, maxTx - read));
      const results = await Promise.all(chunk.map((s) => (s.err ? Promise.resolve({ skip: true }) : fetchTx(s.signature).then((tx) => ({ tx }), (e) => ({ e })))));
      for (let k = 0; k < chunk.length; k++) {
        const s = chunk[k], r = results[k];
        if (r.e) { failure = r.e; break; }
        if (!r.skip && !r.tx) { // not visible on this endpoint yet: retry next sync, give up after a few
          const n = (nulls.get(s.signature) ?? 0) + 1;
          nulls.set(s.signature, n);
          if (n < NULL_SKIP) { failure = new Error(`transaction ${s.signature} not found yet`); break; }
          console.warn(`burns: skipped ${s.signature}, the RPC never returned it`);
        }
        if (!r.skip) read++;
        if (r.tx) add(burnRows(r.tx, s.signature));
        nulls.delete(s.signature);
        st.newest = s.signature; // contiguous prefix: everything up to here is processed
        if (s.blockTime) st.newestAt = s.blockTime * 1000;
        i++;
      }
      if (read && read % 50 < concurrency) save();
      if (!failure && i < queue.length && read < maxTx) await sleep(gap);
    }
    save();
    if (failure) throw failure;
    return { calls, read, left: queue.length - i };
  }

  let running = null;
  return {
    sync: () => (running ??= sync().finally(() => { running = null; })),
    recent: (n = 20) => st.burns.slice(0, n),
    state: () => st,
    remember: (supply, at = Date.now()) => { st.supply = supply; st.supplyAt = at; save(); },
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
 * With ?owner=<wallet> it also returns that wallet's account, balance and a blockhash for the burn page. When the RPC
 * fails the last good numbers are served with `stale: true` instead of an error. `rpc` is unused since Helius is gone;
 * it stays so server.mjs keeps calling burnStats(conn, RPC, owner). */
export async function burnStats(conn, rpc, owner = null, file = join(dirname(process.env.LAUNCH_LOG ?? './data/launches.jsonl'), 'burns.json')) {
  if (owner) return { ...(await stats(conn, file)), owner: { address: String(owner), ...(await ownerAccount(conn, owner)) } };
  return stats(conn, file);
}

let syncOk = true;

async function stats(conn, file) {
  if (!conn) throw new LaunchError(503, 'burn stats are not switched on yet');
  if (!scanner) {
    scanner = createBurnScanner({ conn, file });
    const run = () => scanner.sync().then(() => { syncOk = true; }, (e) => { syncOk = false; console.warn('burns: sync failed:', e.message); });
    run();
    setInterval(run, CACHE_MS).unref();
  }
  return answer(conn, scanner);
}

/** The cached-a-minute answer; on an RPC failure the last good supply (memory, then the state file, then the sum of
 * recorded burns) is returned flagged stale, and the RPC is not asked again until the minute is over. */
export async function answer(conn, sc, now = Date.now()) {
  const shape = (c) => ({ ...summarize(c.supply, sc.recent(), now), ...(c.stale || !syncOk ? { stale: true } : {}) });
  if (cache && now - cache.at < CACHE_MS) return shape(cache);
  pending ??= (async () => {
    try {
      const sup = await conn.getTokenSupply(new PublicKey(MINT));
      const supply = Number(sup.value.uiAmountString ?? sup.value.uiAmount);
      if (!Number.isFinite(supply)) throw new Error('bad supply');
      cache = { at: Date.now(), supply, stale: false };
      sc.remember(supply);
    } catch (e) {
      console.warn('burns: supply failed:', e.message);
      const st = sc.state();
      const last = cache?.supply ?? st.supply ?? (st.burns.length ? INITIAL_SUPPLY - st.burns.reduce((s, b) => s + b.amount, 0) : null);
      if (last == null) throw new LaunchError(503, 'burn stats are unavailable right now');
      cache = { at: Date.now(), supply: last, stale: true };
    }
    return shape(cache);
  })().finally(() => { pending = null; });
  return pending;
}

/** Test hook: forget the module caches. */
export function _reset() { cache = null; pending = null; scanner = null; syncOk = true; }
