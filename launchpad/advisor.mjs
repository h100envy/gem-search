import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { client as ponsClient, FACTORY_ABI, PONS } from './pons.mjs';

/**
 * Chain advisor: which chain is the better place to launch right now, Solana (pump.fun) or Robinhood Chain (pons).
 * Two numbers per chain, both from the last 24 hours: how many coins launched (the crowd you compete with) and what share
 * of them graduated from the curve to a DEX pool. Robinhood counts come straight from the pons factory's TokenLaunched
 * and PoolGraduated events; Solana launches come from the spider's own launch feed, and its graduation share from a
 * sample of launches 3 to 24 hours old checked on DexScreener (graduated = traded on PumpSwap, off the curve).
 * The pick itself comes from the numbers (pickByData). Grok only adds a headline and the mood on X for each chain, with no
 * numbers of its own: every figure on the page comes from the data, so Grok cannot misquote one.
 */
const DAY = 86_400_000;
const BLOCK_MS = 102.5; // Robinhood Chain: ~10 blocks a second
const CHUNK = 100_000n;

/**
 * The data-only pick. A clearly higher graduation share wins; "clearly" means more than two standard errors apart
 * (Solana's share is a sample, Robinhood's a full count). Otherwise the shares are a tie and the less crowded chain wins.
 */
export function pickByData(sol, rh) {
  const a = sol.gradPct, b = rh.gradPct;
  if (a == null && b == null) return { pick: null, reason: null };
  if (a == null || b == null) return { pick: a == null ? 'robinhood' : 'solana', reason: 'only one chain has enough data' };
  const pa = a / 100, pb = b / 100, na = sol.sampled || sol.launches24h || 1, nb = rh.launches24h || 1;
  const se = Math.sqrt((pa * (1 - pa)) / na + (pb * (1 - pb)) / nb);
  if (Math.abs(pa - pb) > 2 * se) {
    const pick = pa > pb ? 'solana' : 'robinhood';
    return { pick, reason: `a clearly higher share of coins reaches a DEX on ${pick === 'solana' ? 'Solana' : 'Robinhood Chain'}` };
  }
  const pick = (sol.launches24h ?? 0) <= (rh.launches24h ?? 0) ? 'solana' : 'robinhood';
  return { pick, reason: `the share of coins reaching a DEX is about the same on both chains, and ${pick === 'solana' ? 'Solana' : 'Robinhood Chain'} has far fewer coins competing for attention` };
}

/** Keeps a rolling 24h list of pons launches and graduations, reading only new blocks after the first fill. */
export function createPonsCounter({ pc = ponsClient(), file, now = () => Date.now(), pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let st = { last: null, launched: [], graduated: [] };
  if (file && existsSync(file)) try { st = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  // viem drops the event filter for a name missing from the ABI and returns every log, so check up front.
  for (const e of ['TokenLaunched', 'PoolGraduated']) if (!FACTORY_ABI.some((x) => x.type === 'event' && x.name === e)) throw new Error(`pons ABI has no ${e} event`);
  let running = null;
  async function step() {
    const head = await pc.getBlockNumber();
    const back = BigInt(Math.ceil(DAY / BLOCK_MS));
    let from = st.last ? BigInt(st.last) + 1n : head - back;
    if (head - from > back) from = head - back;
    const t = (b) => now() - Number(head - b) * BLOCK_MS;
    while (from <= head) {
      const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
      for (const [eventName, list] of [['TokenLaunched', 'launched'], ['PoolGraduated', 'graduated']]) {
        const logs = await pc.getContractEvents({ address: PONS.factory, abi: FACTORY_ABI, eventName, fromBlock: from, toBlock: to });
        for (const l of logs) st[list].push(Math.round(t(l.blockNumber)));
        await pause(250); // the public RPC rate-limits bursts
      }
      st.last = String(to);
      from = to + 1n;
    }
    const cut = now() - DAY;
    st.launched = st.launched.filter((x) => x > cut);
    st.graduated = st.graduated.filter((x) => x > cut);
    if (file) writeFileSync(file, JSON.stringify(st));
  }
  return {
    refresh: () => (running ??= step().finally(() => { running = null; })),
    stats() {
      const cut = now() - DAY, hour = now() - 3_600_000;
      const launches24h = st.launched.filter((x) => x > cut).length, graduated24h = st.graduated.filter((x) => x > cut).length;
      return { launches24h, launchesLastHour: st.launched.filter((x) => x > hour).length, graduated24h, gradPct: launches24h >= 50 ? Math.round((graduated24h / launches24h) * 1000) / 10 : null, ready: !!st.last };
    },
  };
}

/** Solana: launches from the spider's feed table; graduation share from a DexScreener sample of 3-24h old launches. */
export async function solanaStats(db, { sample = 900, fetchFn = fetch, now = Date.now() } = {}) {
  const launches24h = db.prepare('SELECT COUNT(*) n FROM feed WHERE t > ?').get(now - DAY).n;
  const launchesLastHour = db.prepare('SELECT COUNT(*) n FROM feed WHERE t > ?').get(now - 3_600_000).n;
  const mints = db.prepare('SELECT mint FROM feed WHERE t BETWEEN ? AND ? ORDER BY random() LIMIT ?').all(now - DAY, now - 3 * 3_600_000, sample).map((r) => r.mint);
  let seen = 0, grad = 0;
  for (let i = 0; i < mints.length; i += 30) {
    const res = await fetchFn(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const pairs = res?.ok ? await res.json().catch(() => []) : [];
    const byMint = new Map();
    for (const p of Array.isArray(pairs) ? pairs : []) {
      const m = p.baseToken?.address;
      if (m) byMint.set(m, (byMint.get(m) ?? false) || p.dexId !== 'pumpfun');
    }
    for (const m of mints.slice(i, i + 30)) { seen++; if (byMint.get(m)) grad++; }
  }
  return { launches24h, launchesLastHour, sampled: seen, gradPct: seen >= 300 ? Math.round((grad / seen) * 1000) / 10 : null };
}

const PICK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['headline', 'xSolana', 'xRobinhood'],
  properties: {
    headline: { type: 'string' },
    xSolana: { type: 'string' },
    xRobinhood: { type: 'string' },
  },
};

export function createAdvisor({ db, key, pons, dataDir, dailyUsd = 0.5, every = 2 * 3_600_000, logger = console }) {
  const file = `${dataDir}/advisor.json`;
  let st = existsSync(file) ? (() => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } })() : {};
  let running = null;

  async function grok(sol, rh, dataPick, reason) {
    const today = new Date().toISOString().slice(0, 10);
    if (st.day !== today) { st.day = today; st.spent = 0; }
    if (!key || st.spent >= dailyUsd) return null;
    const res = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        model: 'grok-4.20-0309-non-reasoning', store: false, tools: [{ type: 'x_search' }], max_tool_calls: 3, max_output_tokens: 700,
        text: { format: { type: 'json_schema', name: 'chain_pick', schema: PICK_SCHEMA, strict: true } },
        input: [
          { role: 'system', content: 'You are the Gem Search spider. The data already picked where a memecoin creator should launch today: Solana via pump.fun or Robinhood Chain via pons. Search X for the last 24 hours of talk about launching or trading memecoins on each (pump.fun; Robinhood Chain / pons). headline: one punchy line (max 12 words) that sells the PICK for exactly the REASON given; never argue for the other chain. xSolana / xRobinhood: one short line each on the mood on X (max 16 words), or "quiet" if little. Write NO digits or numbers anywhere: the page shows the numbers itself. No price predictions, no promises, no financial advice, no hashtags.' },
          { role: 'user', content: `PICK: ${dataPick}\nREASON: ${reason}\nDATA (last 24h): ${JSON.stringify({ solana: sol, robinhood: rh })}` },
        ],
      }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => null) : null;
    if (!res?.ok || !json) { logger.error('[advisor] grok', res?.status); return null; }
    st.spent += (json.usage?.cost_in_usd_ticks ?? 0) / 1e10;
    const text = (json.output ?? []).filter((o) => o.type === 'message').pop()?.content?.find((c) => c.type === 'output_text')?.text;
    try { return JSON.parse(text); } catch { return null; }
  }

  async function compute() {
    await pons.refresh().catch((e) => logger.error('[advisor] pons', e.shortMessage ?? e.message));
    const rh = pons.stats();
    const sol = await solanaStats(db);
    const { pick: dataPick, reason } = pickByData(sol, rh);
    let g = dataPick ? await grok(sol, rh, dataPick, reason).catch((e) => { logger.error('[advisor]', e.message); return null; }) : null;
    if (g && /\d/.test(g.headline)) g = { ...g, headline: null };
    const clean = (x) => (x && !/\d/.test(x) ? x : null);
    const headline = g?.headline || (dataPick === 'robinhood' ? 'Smaller crowd, so your coin gets seen.' : dataPick === 'solana' ? 'The biggest crowd of buyers, and they graduate more.' : null);
    st.value = { at: Date.now(), pick: dataPick, reason, headline, solana: { ...sol, x: clean(g?.xSolana) }, robinhood: { ...rh, x: clean(g?.xRobinhood) }, by: g ? 'grok' : 'data' };
    writeFileSync(file, JSON.stringify(st));
    return st.value;
  }

  return {
    async get() {
      if (!st.value || Date.now() - st.value.at > every) {
        running ??= compute().finally(() => { running = null; });
        if (!st.value) await running; else running.catch(() => {});
      }
      return st.value;
    },
  };
}
