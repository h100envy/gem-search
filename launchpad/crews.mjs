import { DatabaseSync } from 'node:sqlite';
import { PublicKey } from '@solana/web3.js';
import { EXCHANGES } from './xray.mjs';

/**
 * Bundle Crews: the spider's memory across coins. For every launch the Bundle Index finds with buys in its launch
 * block, it records who bought in that block, which wallet first sent each of them SOL, and later what became of the
 * coin. Wallets that keep being funded from the same sources and keep landing in launch blocks together form a crew;
 * a new launch is then compared against everything the crew did before.
 *
 * A crew is a funding pattern on chain, not a proven identity, and every answer says so.
 */
const LAMPORTS_MIN = 10_000_000; // ignore dust when looking for who funded a wallet
const HUB = 300; // a funder that topped up this many wallets is a service, not a crew

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS launches (mint TEXT PRIMARY KEY, t INTEGER, slot INTEGER, creator TEXT, name TEXT, symbol TEXT, same_slot INTEGER, mc0 REAL);
    CREATE TABLE IF NOT EXISTS buys (mint TEXT, wallet TEXT, signature TEXT, PRIMARY KEY (mint, wallet));
    CREATE INDEX IF NOT EXISTS buys_wallet ON buys(wallet);
    CREATE TABLE IF NOT EXISTS funding (wallet TEXT PRIMARY KEY, funder TEXT, sol REAL, signature TEXT, t INTEGER);
    CREATE INDEX IF NOT EXISTS funding_funder ON funding(funder);
    CREATE TABLE IF NOT EXISTS outcomes (mint TEXT PRIMARY KEY, mc1h REAL, mc24h REAL, checked1h INTEGER, checked24h INTEGER);
  `);
  return db;
}

/** Who first sent this wallet a real amount of SOL before `beforeSig`, from its last few transactions. */
async function funderOf(conn, wallet, beforeSig) {
  const sigs = await conn.getSignaturesForAddress(new PublicKey(wallet), { before: beforeSig, limit: 8 }, 'confirmed');
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    for (const ix of tx?.transaction?.message?.instructions ?? []) {
      const info = ix.parsed?.info;
      if (ix.program === 'system' && ix.parsed?.type === 'transfer' && info?.destination === wallet && Number(info.lamports) >= LAMPORTS_MIN) {
        return { funder: info.source, sol: Number(info.lamports) / 1e9, signature: s.signature, t: (tx.blockTime ?? 0) * 1000 };
      }
    }
  }
  return null;
}

/**
 * Records one launch whose launch block had other buys: the buyers in that block and who funded each of them, the dev
 * included. `sigs` are the coin's signatures as the index read them; `coin` is the creation event.
 */
export async function recordLaunch(db, conn, coin, sigs, { pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const own = sigs.find((s) => s.signature === coin.sig);
  if (!own) return 0;
  const block = sigs.filter((s) => s.slot === own.slot && s.signature !== coin.sig && !s.err).slice(0, 25);
  db.prepare('INSERT OR REPLACE INTO launches (mint, t, slot, creator, name, symbol, same_slot, mc0) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(coin.mint, coin.t, own.slot, coin.creator ?? null, coin.name, coin.symbol, block.length, coin.mcSol ?? null);
  const buyers = new Map();
  for (const s of block) {
    const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
    const payer = tx?.transaction?.message?.accountKeys?.find((k) => k.signer)?.pubkey?.toString();
    if (payer) buyers.set(payer, s.signature);
    await pause(120);
  }
  const insBuy = db.prepare('INSERT OR IGNORE INTO buys (mint, wallet, signature) VALUES (?, ?, ?)');
  for (const [w, sig] of buyers) insBuy.run(coin.mint, w, sig);
  const known = db.prepare('SELECT 1 FROM funding WHERE wallet = ?');
  const insFund = db.prepare('INSERT OR REPLACE INTO funding (wallet, funder, sol, signature, t) VALUES (?, ?, ?, ?, ?)');
  for (const [w, sig] of [...buyers, ...(coin.creator ? [[coin.creator, coin.sig]] : [])]) {
    if (known.get(w)) continue;
    const f = await funderOf(conn, w, sig).catch(() => null);
    if (f) insFund.run(w, f.funder, f.sol, f.signature, f.t);
    await pause(150);
  }
  return buyers.size;
}

/** Market caps an hour and a day after launch, from DexScreener, 30 coins a call. */
export async function checkOutcomes(db, now = Date.now()) {
  const due = (col, age) => db.prepare(`SELECT l.mint FROM launches l LEFT JOIN outcomes o ON o.mint = l.mint WHERE l.t < ? AND (o.${col} IS NULL) LIMIT 30`).all(now - age).map((r) => r.mint);
  for (const [col, age, val] of [['checked1h', 3_600_000, 'mc1h'], ['checked24h', 86_400_000, 'mc24h']]) {
    const mints = due(col, age);
    if (!mints.length) continue;
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(',')}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const pairs = res?.ok ? await res.json().catch(() => []) : null;
    if (!Array.isArray(pairs)) continue;
    const mc = new Map();
    for (const p of pairs) { const m = p.baseToken?.address; const v = p.marketCap ?? p.fdv ?? 0; if (m && v > (mc.get(m) ?? -1)) mc.set(m, v); }
    const up = db.prepare(`INSERT INTO outcomes (mint, ${val}, ${col}) VALUES (?, ?, ?) ON CONFLICT(mint) DO UPDATE SET ${val} = excluded.${val}, ${col} = excluded.${col}`);
    // A coin DexScreener no longer lists is recorded as 0: it had no market left to show.
    for (const m of mints) up.run(m, mc.get(m) ?? 0, now);
  }
}

const ignoredFunder = (db, f) => !f || EXCHANGES.has(f) || db.prepare('SELECT COUNT(*) AS n FROM funding WHERE funder = ?').get(f).n >= HUB;

/**
 * The crew behind a coin: its launch-block buyers and dev, the wallets that funded them, and every other recorded
 * launch where wallets funded from those same sources bought in the launch block, with how those coins ended.
 */
export function crewOf(db, mint) {
  const launch = db.prepare('SELECT * FROM launches WHERE mint = ?').get(mint);
  const wallets = db.prepare('SELECT wallet FROM buys WHERE mint = ?').all(mint).map((r) => r.wallet);
  if (launch?.creator) wallets.push(launch.creator);
  if (!launch) return { known: false };
  const funders = new Set();
  for (const w of wallets) { const f = db.prepare('SELECT funder FROM funding WHERE wallet = ?').get(w)?.funder; if (!ignoredFunder(db, f)) funders.add(f); }
  // Wallets of this crew: funded by the same sources, or the funders themselves buying.
  const crewWallets = new Set(wallets.filter((w) => funders.has(db.prepare('SELECT funder FROM funding WHERE wallet = ?').get(w)?.funder)));
  for (const f of funders) { crewWallets.add(f); for (const r of db.prepare('SELECT wallet FROM funding WHERE funder = ?').all(f)) crewWallets.add(r.wallet); }
  const linkedHere = wallets.filter((w) => crewWallets.has(w));
  if (!funders.size || linkedHere.length < 2) return { known: true, crew: null, launch: { t: launch.t, sameSlot: launch.same_slot, buyers: wallets.length } };
  const others = new Map();
  for (const w of crewWallets) for (const r of db.prepare('SELECT mint FROM buys WHERE wallet = ? AND mint != ?').all(w, mint)) others.set(r.mint, (others.get(r.mint) ?? 0) + 1);
  for (const w of crewWallets) for (const r of db.prepare('SELECT mint FROM launches WHERE creator = ? AND mint != ?').all(w, mint)) others.set(r.mint, (others.get(r.mint) ?? 0) + 1);
  const rows = [...others.keys()].map((m) => ({ ...db.prepare('SELECT mint, t, name, symbol, same_slot AS sameSlot, mc0 FROM launches WHERE mint = ?').get(m), ...(db.prepare('SELECT mc1h, mc24h FROM outcomes WHERE mint = ?').get(m) ?? {}), wallets: others.get(m) }));
  const judged = rows.filter((r) => r.mc1h !== undefined && r.mc1h !== null);
  // pump.fun coins start near $4-5K, so an hour in: under $10K went nowhere, over $50K took off.
  const flat = judged.filter((r) => r.mc1h < 10_000).length;
  const ran = judged.filter((r) => r.mc1h >= 50_000).length;
  return {
    known: true,
    launch: { t: launch.t, sameSlot: launch.same_slot, buyers: wallets.length },
    crew: {
      walletsHere: linkedHere.length,
      funders: [...funders],
      wallets: crewWallets.size,
      launches: rows.length,
      judged: judged.length,
      under10kAt1h: flat,
      over50kAt1h: ran,
      history: rows.sort((a, b) => b.t - a.t).slice(0, 20),
    },
  };
}
