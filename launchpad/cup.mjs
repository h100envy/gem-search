import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { launchBlock } from './bundle-index.mjs';

/**
 * Launch Cup: every week (Monday 00:00 UTC to the next Monday) the coins launched through gemsearch.fun/launch are
 * ranked by market cap. One coin per creator wallet counts (its best); a Solana coin with 3 or more other buys in its
 * launch block is out. The top places win the prizes; the standings freeze when the week ends.
 */
export const WEEK = 7 * 86_400_000;
export function weekOf(t) {
  const d = new Date(t);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * 86_400_000;
  return { start: monday, end: monday + WEEK, id: new Date(monday).toISOString().slice(0, 10) };
}

export function rank(rows, prizes) {
  const best = new Map();
  for (const r of rows) {
    if (!r.eligible) continue;
    const prev = best.get(r.creator);
    if (!prev || (r.marketCap ?? 0) > (prev.marketCap ?? 0)) best.set(r.creator, r);
  }
  const ranked = [...best.values()].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
  return ranked.map((r, i) => ({ ...r, place: i + 1, prize: prizes[i] ?? 0 }));
}

export function createCup({ conn, log: logPath, dir, prizes = [50, 20, 10], logger = console }) {
  const blockCache = new Map();
  let cache = { at: 0, value: null };

  const launches = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

  async function sameSlot(l) {
    if ((l.chain ?? 'solana') !== 'solana') return null;
    if (blockCache.has(l.mint)) return blockCache.get(l.mint);
    const sigs = await conn.getSignaturesForAddress(new PublicKey(l.mint), { limit: 1000 }, 'confirmed').catch(() => null);
    const v = sigs ? launchBlock(sigs, l.signature) : null;
    if (v !== null) blockCache.set(l.mint, v);
    return v;
  }

  async function marketCaps(rows) {
    const out = new Map();
    for (const chain of ['solana', 'robinhood']) {
      const mints = rows.filter((r) => (r.chain ?? 'solana') === chain).map((r) => r.mint);
      for (let i = 0; i < mints.length; i += 30) {
        const res = await fetch(`https://api.dexscreener.com/tokens/v1/${chain}/${mints.slice(i, i + 30).join(',')}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
        const pairs = res?.ok ? await res.json().catch(() => []) : [];
        for (const p of Array.isArray(pairs) ? pairs : []) {
          const m = p.baseToken?.address, v = p.marketCap ?? p.fdv ?? 0;
          const key = chain === 'robinhood' ? m?.toLowerCase() : m;
          if (key && v > (out.get(key)?.marketCap ?? -1)) out.set(key, { marketCap: v, volume24h: p.volume?.h24 ?? null, url: p.url });
        }
      }
    }
    return out;
  }

  async function standings(week) {
    const rows = launches().filter((l) => { const t = Date.parse(l.at); return t >= week.start && t < week.end; });
    const mc = await marketCaps(rows);
    const enriched = [];
    for (const l of rows) {
      const ss = await sameSlot(l);
      const m = mc.get((l.chain ?? 'solana') === 'robinhood' ? l.mint.toLowerCase() : l.mint) ?? {};
      enriched.push({ mint: l.mint, chain: l.chain ?? 'solana', name: l.name, symbol: l.symbol, image: l.image, creator: l.creator, at: l.at, sameSlot: ss, eligible: ss === null || ss < 3, marketCap: m.marketCap ?? 0, volume24h: m.volume24h ?? null, url: m.url ?? null });
    }
    return { entries: enriched.length, standings: rank(enriched, prizes), out: enriched.filter((r) => !r.eligible).map((r) => ({ mint: r.mint, symbol: r.symbol, sameSlot: r.sameSlot })) };
  }

  /** Last week's final table is computed once, right after the week ends, and kept. */
  async function finalOf(week) {
    const path = `${dir}/cup-${week.id}.json`;
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
    const s = await standings(week);
    const value = { week: week.id, start: week.start, end: week.end, frozenAt: Date.now(), ...s };
    writeFileSync(path, JSON.stringify(value));
    return value;
  }

  return async function cup() {
    if (cache.value && Date.now() - cache.at < 60_000) return cache.value;
    const now = Date.now(), week = weekOf(now), prev = weekOf(week.start - 1);
    const [cur, last] = await Promise.all([standings(week), finalOf(prev).catch((e) => { logger.error('[cup] final', e.message); return null; })]);
    const value = { prizes, week: { id: week.id, start: week.start, end: week.end }, ...cur, last, at: now };
    cache = { at: now, value };
    return value;
  };
}
