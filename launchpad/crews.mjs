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
/**
 * The same crew lookup for a coin the database never recorded (launched before collection began, or no launch-block
 * buys): starts from wallets and funders an X-ray found, and looks for them in everything recorded.
 */
export function linksFromXray(x) {
  const wallets = x.nodes.filter((n) => n.kind === 'dev' || n.kind === 'bundle' || n.kind === 'sniper' || n.cluster !== null).filter((n) => n.kind !== 'funder').map((n) => n.id);
  const funders = [...new Set([...x.nodes.filter((n) => n.kind === 'funder').map((n) => n.id), ...x.edges.filter((e) => e.kind === 'sol' || e.kind === 'funded').map((e) => e.from)])];
  return { wallets, funders };
}

export function crewFromLinks(db, mint, wallets, funders = []) {
  const funderOfW = (w) => db.prepare('SELECT funder FROM funding WHERE wallet = ?').get(w)?.funder;
  const candidates = new Set([...funders, ...wallets.map(funderOfW)].filter((f) => !ignoredFunder(db, f)));
  // A funder links this coin to the crew only if wallets it funded (or it itself) also show up in other launches.
  const kept = [], crewWallets = new Set(), others = new Map();
  for (const f of candidates) {
    const set = new Set([f, ...db.prepare('SELECT wallet FROM funding WHERE funder = ?').all(f).map((r) => r.wallet)]);
    const mints = new Map();
    for (const w of set) {
      for (const r of db.prepare('SELECT mint FROM buys WHERE wallet = ? AND mint != ?').all(w, mint)) mints.set(r.mint, (mints.get(r.mint) ?? 0) + 1);
      for (const r of db.prepare('SELECT mint FROM launches WHERE creator = ? AND mint != ?').all(w, mint)) mints.set(r.mint, (mints.get(r.mint) ?? 0) + 1);
    }
    if (!mints.size) continue;
    kept.push(f);
    for (const w of set) crewWallets.add(w);
    for (const [m, n] of mints) others.set(m, (others.get(m) ?? 0) + n);
  }
  const here = wallets.filter((w) => crewWallets.has(w) || kept.includes(funderOfW(w)));
  if (!kept.length || !here.length) return null;
  const rows = [...others.keys()].map((m) => ({ ...db.prepare('SELECT mint, t, name, symbol, same_slot AS sameSlot, mc0 FROM launches WHERE mint = ?').get(m), ...(db.prepare('SELECT mc1h, mc24h FROM outcomes WHERE mint = ?').get(m) ?? {}), wallets: others.get(m) })).filter((r) => r.mint);
  const judged = rows.filter((r) => r.mc1h !== undefined && r.mc1h !== null);
  return {
    walletsHere: here.length,
    funders: kept,
    wallets: crewWallets.size,
    launches: rows.length,
    judged: judged.length,
    under10kAt1h: judged.filter((r) => r.mc1h < 10_000).length,
    over50kAt1h: judged.filter((r) => r.mc1h >= 50_000).length,
    history: rows.sort((x, y) => y.t - x.t).slice(0, 20),
  };
}

/**
 * The crew behind a recorded coin: its launch-block buyers and dev, the wallets that funded them, and every other
 * recorded launch where wallets funded from those same sources bought in the launch block, with how those coins ended.
 */
export function crewOf(db, mint) {
  const launch = db.prepare('SELECT * FROM launches WHERE mint = ?').get(mint);
  if (!launch) return { known: false };
  const wallets = db.prepare('SELECT wallet FROM buys WHERE mint = ?').all(mint).map((r) => r.wallet);
  if (launch.creator) wallets.push(launch.creator);
  return { known: true, launch: { t: launch.t, sameSlot: launch.same_slot, buyers: wallets.length }, crew: crewFromLinks(db, mint, wallets) };
}
