import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Narrative Hunter: every three hours Grok walks X (the x_search tool) for what started moving in the last hours and
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
// A post as Grok writes it: x.com/<user>/status/<id>, x.com/i/status/<id>, x.com/i/web/status/<id>, or the bare id.
const POST_RE = /(?:x|twitter)\.com\/(?:([A-Za-z0-9_]{1,15})\/|i\/(?:web\/)?)status(?:es)?\/(\d{5,25})|^\s*()(\d{15,25})\s*$/;
const idOf = (u) => { const m = String(u ?? '').match(POST_RE); return m ? m[2] ?? m[4] : null; };
const userOf = (u) => { const m = String(u ?? '').match(POST_RE); return m?.[1] && m[1] !== 'i' ? m[1] : 'i'; };

/**
 * Post links Grok cited, matched by status id (its citations look like x.com/i/status/<id>), as
 * https://x.com/<user>/status/<id> links. With `all`, uncited links are kept too (to be checked another way).
 */
export function cleanPosts(posts, cites, { all = false } = {}) {
  const cited = new Set((cites ?? []).map(idOf).filter(Boolean));
  const out = new Map();
  for (const u of posts ?? []) {
    const id = idOf(u);
    if (id && (all || cited.size === 0 || cited.has(id)) && !out.has(id)) out.set(id, `https://x.com/${userOf(u)}/status/${id}`);
  }
  return [...out.values()].slice(0, 3);
}

/**
 * Checks a post exists with X's public oEmbed (free, no key): 200 for a real post, 404 for an invented one. Returns
 * the link with the real author, null when the post does not exist, or undefined when oEmbed could not be reached.
 */
export async function verifyPost(url, fetchFn = fetch) {
  const id = idOf(url);
  if (!id) return null;
  const res = await fetchFn(`https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(url.replace('https://x.com/', 'https://twitter.com/'))}`, { redirect: 'follow', signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) return undefined;
  if (res.status === 404) return null;
  if (!res.ok) return undefined;
  const author = String((await res.json().catch(() => ({}))).author_url ?? '').match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/)?.[1];
  return author ? `https://x.com/${author}/status/${id}` : undefined;
}

export function createNarratives({ key, db = null, dataDir, every = 3 * 3_600_000, dailyUsd = 1.5, now = () => Date.now(), fetchFn = fetch, logger = console }) {
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
      body: JSON.stringify({ model: 'grok-4.20-0309-non-reasoning', store: false, tools: [{ type: 'x_search' }], max_tool_calls: 3, max_output_tokens: 1500, text: { format: { type: 'json_schema', name: 'narratives', schema: SCHEMA, strict: true } }, input: PROMPT }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => null) : null;
    if (!res?.ok || !json) { logger.error('[narratives] grok', res?.status); return st.value; }
    const usd = (json.usage?.cost_in_usd_ticks ?? 0) / 1e10;
    st.spent += usd;
    const msg = (json.output ?? []).filter((o) => o.type === 'message').pop()?.content?.find((c) => c.type === 'output_text');
    let parsed;
    try { parsed = JSON.parse(msg?.text ?? ''); } catch { logger.error('[narratives] bad json'); return st.value; }
    const cites = (msg?.annotations ?? []).map((a) => a.url).filter(Boolean);
    // Every post link is checked with oEmbed: invented ones drop out, real ones get their real author. Where oEmbed
    // cannot be reached, only links Grok cited from its search survive.
    const citedIds = new Set(cites.map(idOf).filter(Boolean));
    const tally = { links: 0, real: 0, missing: 0, unreachable: 0 };
    const checkPosts = async (posts) => {
      const out = [];
      for (const u of cleanPosts(posts, cites, { all: true })) {
        const v = await verifyPost(u, fetchFn);
        tally.links++; tally[v ? 'real' : v === null ? 'missing' : 'unreachable']++;
        if (v) out.push(v); else if (v === undefined && citedIds.has(idOf(u))) out.push(u);
      }
      return out;
    };
    const seen = new Set(), list = [];
    for (const n of parsed.narratives ?? []) {
      const ticker = tickerOf(n.ticker) || tickerOf(n.name);
      if (!ticker || seen.has(ticker)) continue;
      const posts = await checkPosts(n.posts);
      if (!posts.length) continue;
      seen.add(ticker);
      list.push({ title: String(n.title).slice(0, 60), why: String(n.why).slice(0, 240), name: String(n.name).slice(0, 32), ticker, heat: n.heat, kind: n.kind, posts, clones24h: clones(ticker) });
    }
    logger.log?.('[narratives]', JSON.stringify({ found: parsed.narratives?.length ?? 0, kept: list.length, cites: cites.length, ...tally, usd: Math.round(usd * 1000) / 1000 }));
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
