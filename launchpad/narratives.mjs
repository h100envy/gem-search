import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Narrative Hunter: every so often Grok walks X (the x_search tool) for what started moving in the last hours and
 * could carry a new coin: a meme, a viral animal, a new AI product, an internet moment. Each narrative comes back with
 * the posts it was found in (only links Grok actually cited are kept), a suggested name and ticker, and how hot it is.
 * The spider then checks its own launch feed: how many pump.fun coins with that ticker already launched today, so a
 * fresh narrative and a squeezed one look different. Results are cached; Grok spend is capped per day.
 */
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['narratives'],
  properties: {
    narratives: {
      type: 'array', minItems: 0, maxItems: 8,
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'why', 'name', 'ticker', 'heat', 'kind', 'posts'],
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
          name: { type: 'string' },
          ticker: { type: 'string' },
          heat: { type: 'string', enum: ['early', 'rising', 'hot'] },
          kind: { type: 'string', enum: ['meme', 'ai', 'animal', 'tech', 'culture', 'crypto', 'other'] },
          posts: { type: 'array', maxItems: 3, items: { type: 'string' } },
        },
      },
    },
  },
};

const PROMPT = `You are the Gem Search spider hunting X for narratives a memecoin could launch on right now.
Search X for what started spreading in the last 6 hours: new memes and catchphrases, viral animals, new AI models or products, funny tech or internet moments, crypto culture jokes. Prefer things that are rising now over things that peaked days ago.
For each narrative (up to 8): title (max 6 words), why (one sentence: what is happening and why people care), a fitting coin name (max 24 chars) and ticker (2-10 letters, A-Z/0-9, no $), heat (early = a few posts, rising = spreading fast, hot = everywhere), kind, and up to 3 links to the X posts where you saw it (x.com/<user>/status/<id> only, links you actually found).
Skip: tragedies, deaths, disasters, wars, politics, hate, sexual content, anything about minors, and anything that would impersonate a real person, brand or company as if they launched the coin. No price predictions, no promises.`;

export const tickerOf = (s) => String(s ?? '').toUpperCase().replace(/^\$/, '').replace(/[^A-Z0-9]/g, '').slice(0, 10);
const POST_RE = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{5,25}/;

/** Keeps only post links Grok cited (or that match a cited link), normalized to x.com. */
export function cleanPosts(posts, cites) {
  const norm = (u) => (u.match(POST_RE)?.[0] ?? '').replace(/^https?:\/\/(?:www\.)?twitter\.com/, 'https://x.com').replace(/^https?:\/\/(?:www\.)?x\.com/, 'https://x.com');
  const cited = new Set((cites ?? []).map(norm).filter(Boolean));
  return [...new Set((posts ?? []).map(norm).filter((u) => u && (cited.size === 0 || cited.has(u))))].slice(0, 3);
}

export function createNarratives({ key, db = null, dataDir, every = 90 * 60_000, dailyUsd = 1, now = () => Date.now(), fetchFn = fetch, logger = console }) {
  const file = `${dataDir}/narratives.json`;
  let st = { day: null, spent: 0, value: null };
  if (existsSync(file)) try { st = { ...st, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch {}
  let running = null;

  const clones = (ticker) => {
    if (!db || !ticker) return null;
    try { return db.prepare('SELECT COUNT(*) n FROM feed WHERE t > ? AND upper(symbol) = ?').get(now() - 86_400_000, ticker).n; } catch { return null; }
  };

  async function hunt() {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (st.day !== today) { st.day = today; st.spent = 0; }
    if (!key) throw new Error('no xAI key');
    if (st.spent >= dailyUsd) return st.value;
    const res = await fetchFn('https://api.x.ai/v1/responses', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(150_000),
      body: JSON.stringify({ model: 'grok-4.20-0309-non-reasoning', store: false, tools: [{ type: 'x_search' }], max_tool_calls: 6, max_output_tokens: 1500, text: { format: { type: 'json_schema', name: 'narratives', schema: SCHEMA, strict: true } }, input: PROMPT }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => null) : null;
    if (!res?.ok || !json) { logger.error('[narratives] grok', res?.status); return st.value; }
    const usd = (json.usage?.cost_in_usd_ticks ?? 0) / 1e10;
    st.spent += usd;
    const msg = (json.output ?? []).filter((o) => o.type === 'message').pop()?.content?.find((c) => c.type === 'output_text');
    let parsed;
    try { parsed = JSON.parse(msg?.text ?? ''); } catch { logger.error('[narratives] bad json'); return st.value; }
    const cites = (msg?.annotations ?? []).map((a) => a.url).filter(Boolean);
    const seen = new Set();
    const list = (parsed.narratives ?? []).map((n) => {
      const ticker = tickerOf(n.ticker) || tickerOf(n.name);
      return { title: String(n.title).slice(0, 60), why: String(n.why).slice(0, 240), name: String(n.name).slice(0, 32), ticker, heat: n.heat, kind: n.kind, posts: cleanPosts(n.posts, cites), clones24h: clones(ticker) };
    }).filter((n) => n.ticker && n.posts.length && !seen.has(n.ticker) && seen.add(n.ticker));
    st.value = { at: now(), narratives: list, usd: Math.round(usd * 1000) / 1000 };
    writeFileSync(file, JSON.stringify(st));
    return st.value;
  }

  return {
    async get() {
      const stale = !st.value || now() - st.value.at > every;
      if (stale) {
        running ??= hunt().catch((e) => { logger.error('[narratives]', e.message); return st.value; }).finally(() => { running = null; });
        if (!st.value) await running;
      }
      // the clone counts move all day: refresh them from the feed on every read
      return st.value && { ...st.value, narratives: st.value.narratives.map((n) => ({ ...n, clones24h: clones(n.ticker) ?? n.clones24h })) };
    },
    hunt,
  };
}
