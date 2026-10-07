import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';
import { checkOutcomes, openDb, recordLaunch } from './crews.mjs';
import { addToFeed, initFeed, metadata } from './feed.mjs';

/**
 * Bundle Index: how many of today's pump.fun launches had other buys land in the very block the coin was created in.
 * New coins come from PumpPortal's free creation stream; a sample of them is checked 30 seconds after launch with one
 * getSignaturesForAddress call, counting the coin's other transactions that share the creation slot. That is what a
 * Jito bundle looks like on chain, and also what the fastest sniper bots look like: the index reports launch-block
 * buys, not intent. The dev's own first buy comes from the creation event and is counted separately.
 */
export const BUNDLE_MIN = 3; // other transactions in the launch block that make a launch count as bundled
const STREAM = 'wss://pumpportal.fun/api/data';

export function classify(sameSlot) {
  if (sameSlot === null) return 'unknown';
  if (sameSlot >= BUNDLE_MIN) return 'bundled';
  if (sameSlot >= 1) return 'sniped';
  return 'clean';
}

/** One check: the creation slot, and how many of the coin's other transactions landed in it. */
export function launchBlock(signatures, createSig) {
  const own = signatures.find((s) => s.signature === createSig);
  if (!own) return null;
  return signatures.filter((s) => s.slot === own.slot && s.signature !== createSig && !s.err).length;
}

export function emptyDay(date) {
  return { date, seen: 0, checked: 0, counts: { clean: 0, sniped: 0, bundled: 0, unknown: 0 }, sameSlotHist: {}, devBuy: { none: 0, under5: 0, under10: 0, over10: 0 }, hours: Array.from({ length: 24 }, () => ({ checked: 0, bundled: 0 })), top: [], recent: [] };
}

export function record(day, coin) {
  const v = classify(coin.sameSlot);
  day.checked++;
  day.counts[v]++;
  if (coin.sameSlot !== null) {
    const k = coin.sameSlot >= 10 ? '10+' : String(coin.sameSlot);
    day.sameSlotHist[k] = (day.sameSlotHist[k] ?? 0) + 1;
    const h = new Date(coin.t).getUTCHours();
    day.hours[h].checked++;
    if (v === 'bundled') day.hours[h].bundled++;
  }
  const row = { mint: coin.mint, name: coin.name, symbol: coin.symbol, devBuyPct: coin.devBuyPct, sameSlot: coin.sameSlot, verdict: v, t: coin.t };
  day.recent.unshift(row);
  day.recent.length = Math.min(day.recent.length, 60);
  if (v === 'bundled') {
    day.top.push(row);
    day.top.sort((a, b) => b.sameSlot - a.sameSlot);
    day.top.length = Math.min(day.top.length, 15);
  }
}

export function summary(day) {
  const known = day.checked - day.counts.unknown;
  const pct = (n) => (known ? Math.round((n / known) * 1000) / 10 : null);
  return { date: day.date, seen: day.seen, checked: day.checked, known, bundledPct: pct(day.counts.bundled), snipedPct: pct(day.counts.sniped), cleanPct: pct(day.counts.clean), counts: day.counts, sameSlotHist: day.sameSlotHist, devBuy: day.devBuy, hours: day.hours, top: day.top, recent: day.recent, bundleMin: BUNDLE_MIN };
}

export function startIndex({ rpc = 'https://api.mainnet-beta.solana.com', dir = '/data/index', sample = 0.3, delayMs = 30_000, crewsDb = null, log = console } = {}) {
  const conn = new Connection(rpc, 'confirmed');
  // Launches with buys in their launch block also feed Bundle Crews, one at a time behind the index.
  const db = crewsDb ? openDb(crewsDb) : null;
  if (db) initFeed(db);
  const crewQueue = [];
  let crewBusy = false;
  async function crewDrain() {
    if (crewBusy || !db) return;
    crewBusy = true;
    while (crewQueue.length) {
      const { coin, sigs } = crewQueue.shift();
      await recordLaunch(db, conn, coin, sigs).catch((e) => log.error('[crews] record', coin.mint, e.message));
    }
    crewBusy = false;
  }
  if (db) {
    setInterval(crewDrain, 2_000).unref();
    setInterval(() => checkOutcomes(db).catch((e) => log.error('[crews] outcomes', e.message)), 120_000).unref();
  }
  const days = new Map();
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  const pathOf = (d) => join(dir, `${d}.json`);
  async function day(d) {
    if (!days.has(d)) {
      let loaded = null;
      try { loaded = JSON.parse(await readFile(pathOf(d), 'utf8')); } catch {}
      days.set(d, loaded ?? emptyDay(d));
      for (const k of days.keys()) if (k < d && days.size > 2) days.delete(k);
    }
    return days.get(d);
  }
  async function flush() {
    for (const [d, data] of days) { const tmp = `${pathOf(d)}.tmp`; await writeFile(tmp, JSON.stringify(summary(data))); await rename(tmp, pathOf(d)); }
  }

  // Checks run one at a time, spaced out, so the public RPC never sees a burst.
  const queue = [];
  let busy = false;
  async function drain() {
    if (busy) return;
    busy = true;
    while (queue.length && queue[0].due <= Date.now()) {
      const coin = queue.shift();
      let sameSlot = null, sigs = null;
      for (let i = 0; i < 3 && sameSlot === null; i++) {
        try {
          sigs = await conn.getSignaturesForAddress(new PublicKey(coin.mint), { limit: 200 }, 'confirmed');
          sameSlot = launchBlock(sigs, coin.sig);
          if (sameSlot === null && sigs.length < 200) break; // creation not indexed yet or dropped: leave unknown
        } catch (e) {
          await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
        }
      }
      record(await day(dayOf(coin.t)), { ...coin, sameSlot });
      if (db && sameSlot >= 1 && crewQueue.length < 500) crewQueue.push({ coin, sigs });
      if (db && sameSlot !== null) metadata(coin.uri).then((meta) => addToFeed(db, coin, sameSlot, meta)).catch((e) => log.error('[feed]', e.message));
      await new Promise((r) => setTimeout(r, 250));
    }
    busy = false;
  }
  setInterval(drain, 1_000).unref();
  setInterval(() => flush().catch((e) => log.error('[index] flush', e.message)), 15_000).unref();

  function connect() {
    const ws = new WebSocket(STREAM);
    let alive = Date.now();
    const watchdog = setInterval(() => { if (Date.now() - alive > 120_000) ws.close(); }, 30_000);
    ws.onopen = () => { ws.send(JSON.stringify({ method: 'subscribeNewToken' })); log.log('[index] stream open'); };
    ws.onmessage = async (e) => {
      alive = Date.now();
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.txType !== 'create' || !m.mint || !m.signature) return;
      const t = Date.now();
      const d = await day(dayOf(t));
      d.seen++;
      const devBuyPct = Math.round(((Number(m.initialBuy) || 0) / 1e9) * 1000) / 10;
      d.devBuy[devBuyPct === 0 ? 'none' : devBuyPct < 5 ? 'under5' : devBuyPct < 10 ? 'under10' : 'over10']++;
      if (Math.random() < sample && queue.length < 2000) queue.push({ mint: m.mint, sig: m.signature, uri: m.uri ?? null, creator: m.traderPublicKey ?? null, mcSol: Number(m.marketCapSol) || null, name: String(m.name ?? '').slice(0, 40), symbol: String(m.symbol ?? '').slice(0, 12), devBuyPct, t, due: t + delayMs });
    };
    ws.onclose = () => { clearInterval(watchdog); log.log('[index] stream closed, reconnecting'); setTimeout(connect, 5_000); };
    ws.onerror = () => {};
  }

  mkdir(dir, { recursive: true }).then(connect);
  return { flush, queue };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startIndex({ rpc: process.env.INDEX_RPC_URL ?? 'https://api.mainnet-beta.solana.com', dir: process.env.INDEX_DIR ?? '/data/index', sample: Number(process.env.INDEX_SAMPLE ?? 0.3), crewsDb: process.env.CREWS_DB ?? '/data/crews.db' });
  setInterval(() => {}, 1 << 30);
}
