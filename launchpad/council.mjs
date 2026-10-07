import { readFile, rename, writeFile } from 'node:fs/promises';
import { LaunchError } from './launch.mjs';

/**
 * Grok Council: four Grok characters debate one coin. The Lookout reads what X says right now (one x_search call);
 * everyone argues from the spider's own facts (scan, Web X-ray, Bundle Crew) and votes APE / WATCH / AVOID. Facts and
 * the X summary are handed to the model as data; it is told to cite them, say "unknown" when they are missing, and
 * treat numbers in X posts as opinions unless the spider's data agrees. Every call is priced and capped per day.
 */
const API = 'https://api.x.ai/v1/responses';
const MODEL = 'grok-4.20-0309-non-reasoning';
const TICKS = 1e10; // xAI reports cost in 1e-10 USD

export const SEATS = {
  lookout: { name: 'Lookout', emoji: '🔭', role: 'reads what X is saying about the coin right now' },
  skeptic: { name: 'Skeptic', emoji: '🧐', role: 'hunts for red flags: bundles, linked wallets, the dev, known crews, open authorities' },
  builder: { name: 'Builder', emoji: '🛠', role: 'asks whether anything real stands behind it: site, links, socials, a product' },
  timing: { name: 'Timing', emoji: '⏱', role: 'reads the market: curve or pool, liquidity, volume, age' },
};

/** The spider's facts for one coin, trimmed to what the council needs. */
export function factsOf(scan, xray, crew) {
  const f = { coin: { name: scan?.name ?? null, symbol: scan?.symbol ?? null, mint: scan?.mint ?? xray?.mint }, score: scan?.score ?? null, checks: (scan?.checks ?? []).map((c) => `${c.status.toUpperCase()} · ${c.label}: ${c.detail}`), market: scan?.market ?? null, graduated: scan?.graduated ?? null, curveProgress: scan?.progress ?? null };
  if (xray) {
    f.launchBlock = xray.bundle ?? 'launch not reached';
    f.poolOrCurveHoldsPct = xray.poolPct;
    f.linkedClusters = (xray.clusters ?? []).slice(0, 4).map((c) => ({ wallets: c.size, holdsPct: c.holdsPct, why: c.reasons }));
  } else f.launchBlock = 'not X-rayed';
  f.bundleCrew = crew?.crew ? { walletsHere: crew.crew.walletsHere, otherLaunches: crew.crew.launches, wentNowhereIn1h: crew.crew.under10kAt1h, tookOffIn1h: crew.crew.over50kAt1h, pending: crew.crew.launches - crew.crew.judged } : crew ? 'no known crew in the spider\'s memory' : 'not checked';
  return f;
}

const RULES = `Rules:
- Use only the FACTS and the X SUMMARY given. Never invent numbers, wallets, people or events.
- If something is missing, say it is unknown.
- Posts on X are opinions. Do not repeat a statistic from X as fact unless the FACTS agree; if they disagree, say so.
- A bundle, cluster or crew is a funding pattern on chain, not a proven identity. Never call anyone a scammer.
- No price predictions, no promises, no "financial advice". Short, punchy, crypto-native, no hashtags.`;

export function createCouncil({ key, dataDir = '/data', file = 'council.json', dailyUsd = 1.5, log = console } = {}) {
  const path = `${dataDir}/${file}`;
  let state = { day: null, spentToday: 0, spentTotal: 0, debates: 0, asks: 0 };
  const load = async () => { try { state = { ...state, ...JSON.parse(await readFile(path, 'utf8')) }; } catch {} };
  const save = async () => { const tmp = `${path}.tmp`; await writeFile(tmp, JSON.stringify(state)); await rename(tmp, path); };
  const loaded = load();

  async function call(body) {
    await loaded;
    const today = new Date().toISOString().slice(0, 10);
    if (state.day !== today) { state.day = today; state.spentToday = 0; }
    if (state.spentToday >= dailyUsd) throw new LaunchError(503, 'the council has used today\'s Grok budget; it meets again tomorrow');
    const res = await fetch(API, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, store: false, ...body }), signal: AbortSignal.timeout(60_000) }).catch(() => null);
    const json = res ? await res.json().catch(() => null) : null;
    if (!res?.ok || !json) { log.error('[council]', res?.status, JSON.stringify(json)?.slice(0, 300)); throw new LaunchError(502, 'Grok did not answer; try again in a minute'); }
    const usd = (json.usage?.cost_in_usd_ticks ?? 0) / TICKS;
    state.spentToday += usd; state.spentTotal += usd;
    save().catch(() => {});
    const msg = (json.output ?? []).filter((o) => o.type === 'message').pop()?.content?.find((c) => c.type === 'output_text');
    return { text: msg?.text ?? '', cites: [...new Set((msg?.annotations ?? []).map((a) => a.url).filter(Boolean))], usd };
  }

  /** What X says about the coin, in a few cited lines. One x_search call, at most two searches. */
  async function lookout(facts) {
    const c = facts.coin;
    const r = await call({
      tools: [{ type: 'x_search' }], max_tool_calls: 2, max_output_tokens: 300,
      input: `Search X for posts from the last 3 days about the Solana token ${c.symbol ? '$' + c.symbol : ''} (contract ${c.mint}). Reply with at most 4 short bullet points: what people claim, who is pushing it (handles), the mood. Mark claims as claims. If there is almost nothing, say so.`,
    });
    return r;
  }

  /** The debate: eight short turns between the four seats, then a vote each. One call, structured output. */
  async function debate(facts, x) {
    const schema = {
      type: 'object', additionalProperties: false, required: ['turns', 'votes', 'summary'],
      properties: {
        turns: { type: 'array', minItems: 6, maxItems: 9, items: { type: 'object', additionalProperties: false, required: ['seat', 'text'], properties: { seat: { type: 'string', enum: Object.keys(SEATS) }, text: { type: 'string' } } } },
        votes: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['seat', 'vote', 'why'], properties: { seat: { type: 'string', enum: Object.keys(SEATS) }, vote: { type: 'string', enum: ['APE', 'WATCH', 'AVOID'] }, why: { type: 'string' } } } },
        summary: { type: 'string' },
      },
    };
    const r = await call({
      max_output_tokens: 1200,
      text: { format: { type: 'json_schema', name: 'council', schema, strict: true } },
      input: [
        { role: 'system', content: `You voice the Gem Search Grok Council, four characters debating one memecoin:\n${Object.entries(SEATS).map(([k, s]) => `- ${k} (${s.name}): ${s.role}`).join('\n')}\nThey talk to each other, disagree, and reference concrete facts (the score, a check, the launch block, a cluster %, the crew, an X claim). Each turn is one or two sentences. The Lookout speaks first, from the X SUMMARY. Then each votes APE, WATCH or AVOID with a one-line reason, and you write a one-sentence summary.\n${RULES}` },
        { role: 'user', content: `FACTS (from the Gem Search spider, on chain):\n${JSON.stringify(facts)}\n\nX SUMMARY (from the Lookout's search; opinions, not facts):\n${x.text || 'nothing found'}` },
      ],
    });
    let out;
    try { out = JSON.parse(r.text); } catch { throw new LaunchError(502, 'the council could not agree on a format; try again'); }
    return { ...out, usd: r.usd };
  }

  return {
    async convene(facts) {
      const x = await lookout(facts);
      const d = await debate(facts, x);
      state.debates++;
      save().catch(() => {});
      const tally = { APE: 0, WATCH: 0, AVOID: 0 };
      for (const v of d.votes) tally[v.vote]++;
      const verdict = Object.entries(tally).sort((a, b) => b[1] - a[1] || ['AVOID', 'WATCH', 'APE'].indexOf(a[0]) - ['AVOID', 'WATCH', 'APE'].indexOf(b[0]))[0][0];
      return { mint: facts.coin.mint, x: { summary: x.text, cites: x.cites }, turns: d.turns, votes: d.votes, tally, verdict, summary: d.summary, usd: Math.round((x.usd + d.usd) * 1000) / 1000, at: new Date().toISOString() };
    },
    async ask(facts, debateResult, question) {
      const q = String(question ?? '').trim().slice(0, 300);
      if (q.length < 3) throw new LaunchError(400, 'ask the council a question');
      const r = await call({
        max_output_tokens: 350,
        input: [
          { role: 'system', content: `You are the Gem Search Grok Council (${Object.values(SEATS).map((s) => s.name).join(', ')}). Answer the user's question in 2-4 short sentences; you may let one or two seats speak, prefixed like "Skeptic:". Off-topic questions get a one-line nudge back to the coin.\n${RULES}` },
          { role: 'user', content: `FACTS:\n${JSON.stringify(facts)}\n\nX SUMMARY:\n${debateResult?.x?.summary ?? 'not searched'}\n\nTHE DEBATE SO FAR:\n${(debateResult?.turns ?? []).map((t) => `${t.seat}: ${t.text}`).join('\n')}\n\nQUESTION: ${q}` },
        ],
      });
      state.asks++;
      save().catch(() => {});
      return { answer: r.text, usd: Math.round(r.usd * 1000) / 1000 };
    },
    status: () => ({ ...state, dailyUsd }),
  };
}
