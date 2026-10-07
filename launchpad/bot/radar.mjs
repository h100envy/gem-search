import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Shill Radar: finds fresh public posts that ask for token picks ("shill me your ticker", "need a 1000x") with X's
 * recent search, and sends them to the team's Telegram chats with a ready reply. It only reads: a person opens the post
 * and replies by hand. Every read is paid (X pay-per-use), so the radar keeps a running estimate of what it spent and
 * stops itself at the budget.
 */
export const QUERY = '("shill me" OR "shill your" OR "drop your ticker" OR "drop your tickers" OR "drop your bags" OR "drop your gem" OR "drop your gems" OR "drop your CA" OR "need a 100x" OR "need a 1000x" OR "next 100x gem" OR "1000x gem") -art -artwork -NFT -NFTs -drawing -painting -is:retweet -is:reply lang:en';
const PRICE = { post: 0.005, user: 0.01 }; // USD per resource read, X pay-per-use

const REPLIES = [
  '$GEMSEARCH 🕷️ an open-source spider that X-rays memecoins for bundles, dev dumps and clones before you ape',
  'Not a promise, a filter 🕸️ $GEMSEARCH scans any CA for bundles and linked wallets. Run the tickers in this thread through it',
  '$GEMSEARCH 🕷️ the spider that checks who really holds a coin. Free scanner on our site, no wallet needed',
  'Before you ape any of these: $GEMSEARCH X-rays the holders and shows the bundle 🕸️',
];

export const pickReply = (n) => REPLIES[n % REPLIES.length];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n));

/** One alert for one post: who, how fresh, how crowded, the text, and buttons to open it or reply with a draft. */
export function formatHit(post, user, n, now = Date.now()) {
  const m = post.public_metrics ?? {};
  const mins = Math.max(0, Math.round((now - Date.parse(post.created_at)) / 60_000));
  const url = `https://x.com/${user.username}/status/${post.id}`;
  const reply = pickReply(n);
  const text = `🎯 <b>@${esc(user.username)}</b>${user.verified ? ' ✓' : ''} · ${k(user.public_metrics?.followers_count ?? 0)} followers\n` +
    `⏱ ${mins} min ago · 💬 ${m.reply_count ?? 0} replies · ❤️ ${m.like_count ?? 0}\n\n` +
    `<i>${esc(String(post.text).slice(0, 400))}</i>\n\n` +
    `Draft reply (edit before posting):\n<code>${esc(reply)}</code>`;
  const keyboard = { inline_keyboard: [[{ text: '↗ Open post', url }, { text: '✍️ Reply on X', url: `https://x.com/intent/post?in_reply_to=${post.id}&text=${encodeURIComponent(reply)}` }]] };
  return { text, keyboard };
}

/** A Solana contract address in a post, if there is one. */
export function findCA(text) {
  const m = String(text ?? '').match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) ?? [];
  return m.find((x) => /pump$/.test(x)) ?? m[0] ?? null;
}

/** An alert for a post from an account a chat tracks: the post, and a scan button when it carries a contract address. */
export function formatTracked(post, user, now = Date.now()) {
  const m = post.public_metrics ?? {};
  const mins = Math.max(0, Math.round((now - Date.parse(post.created_at)) / 60_000));
  const url = `https://x.com/${user.username}/status/${post.id}`;
  const ca = findCA(post.text);
  const tickers = [...new Set((String(post.text).match(/\$[A-Za-z][A-Za-z0-9]{1,9}\b/g) ?? []).map((t) => t.toUpperCase()))].slice(0, 5);
  const text = `👁 <b>@${esc(user.username)}</b>${user.verified ? ' ✓' : ''} posted · ${k(user.public_metrics?.followers_count ?? 0)} followers\n` +
    `⏱ ${mins} min ago · 💬 ${m.reply_count ?? 0} · ❤️ ${m.like_count ?? 0}\n\n` +
    `<i>${esc(String(post.text).slice(0, 500))}</i>` +
    (ca ? `\n\n🪙 Contract in the post: <code>${esc(ca)}</code>` : tickers.length ? `\n\n🪙 Tickers: ${esc(tickers.join(' '))}` : '');
  const row = [{ text: '↗ Open post', url }];
  if (ca) row.push({ text: '🔎 Scan it', url: `https://gemsearch.fun/scan?ca=${ca}` });
  return { text, keyboard: { inline_keyboard: [row] } };
}

export const TRACK_MAX = 5; // accounts per chat
const TRACK_TOTAL = 300; // accounts across all chats

export function createRadar({ bearer, dataDir = '/data', send, log = console, intervalMs = 180_000, budgetUsd = 9, minFollowers = 1000, maxAgeMin = 30, maxReplies = 150 }) {
  const path = join(dataDir, 'radar.json');
  let state = { chats: [], sinceId: null, spentUsd: 0, reads: 0, users: 0, hits: 0, stopped: false, seen: [], tracks: {}, trackFrom: null, tracked: 0 };
  let timer = null;

  const save = async () => { const tmp = `${path}.tmp`; await writeFile(tmp, JSON.stringify(state)); await rename(tmp, path); };
  const load = async () => { try { state = { ...state, ...JSON.parse(await readFile(path, 'utf8')) }; } catch {} };

  const trackChats = () => Object.keys(state.tracks).filter((c) => state.tracks[c]?.length);
  async function overBudget() {
    if (state.spentUsd < budgetUsd) return false;
    if (!state.stopped) {
      state.stopped = true;
      await save();
      for (const c of new Set([...state.chats, ...trackChats()])) await send(c, `🛑 Radar and tracking paused: the X reading budget for this test is used up. They resume when it is topped up.`).catch(() => {});
    }
    return true;
  }

  /** Posts from the accounts chats track: one search for all of them, every few minutes, new posts only. */
  async function tickTracks() {
    const handles = [...new Set(Object.values(state.tracks).flat())];
    if (!handles.length || (await overBudget())) return;
    const from = state.trackFrom ?? new Date(Date.now() - 10 * 60_000).toISOString();
    const started = new Date(Date.now() - 20_000).toISOString(); // X indexes with a small delay
    const chunks = [];
    let cur = [];
    for (const h of handles) { if ((cur.concat(h).map((x) => `from:${x}`).join(' OR ').length) > 480) { chunks.push(cur); cur = []; } cur.push(h); }
    if (cur.length) chunks.push(cur);
    const seen = new Set(state.seen);
    for (const chunk of chunks) {
      const q = new URLSearchParams({ query: `(${chunk.map((x) => `from:${x}`).join(' OR ')}) -is:retweet`, max_results: '50', start_time: from, 'tweet.fields': 'created_at,public_metrics,author_id', expansions: 'author_id', 'user.fields': 'public_metrics,username,verified' });
      const res = await fetch(`https://api.x.com/2/tweets/search/recent?${q}`, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
      if (!res?.ok) { log.error('[track] search', res?.status); continue; }
      const body = await res.json().catch(() => ({}));
      const posts = body.data ?? [], users = body.includes?.users ?? [];
      state.reads += posts.length; state.users += users.length; state.tracked += posts.length;
      state.spentUsd += posts.length * PRICE.post + users.length * PRICE.user;
      const byId = new Map(users.map((u) => [u.id, u]));
      for (const p of posts.reverse()) {
        const u = byId.get(p.author_id);
        if (!u || seen.has(p.id)) continue;
        seen.add(p.id); state.seen.push(p.id);
        const alert = formatTracked(p, u);
        for (const c of trackChats()) if (state.tracks[c].includes(u.username.toLowerCase())) await send(c, alert.text, { reply_markup: alert.keyboard, link_preview_options: { is_disabled: true } }).catch((e) => log.error('[track] send', e.message));
      }
    }
    state.trackFrom = started;
    state.seen = state.seen.slice(-3000);
    await save();
  }

  async function tick() {
    await tickTracks().catch((e) => log.error('[track] tick', e.message));
    if (!state.chats.length || state.stopped) return;
    if (await overBudget()) return;
    const q = new URLSearchParams({ query: QUERY, max_results: '25', 'tweet.fields': 'created_at,public_metrics,author_id', expansions: 'author_id', 'user.fields': 'public_metrics,username,verified' });
    if (state.sinceId) q.set('since_id', state.sinceId);
    else q.set('start_time', new Date(Date.now() - 15 * 60_000).toISOString());
    const res = await fetch(`https://api.x.com/2/tweets/search/recent?${q}`, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) return log.log('[radar] rate limited, next round');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      log.error('[radar] search', res.status, JSON.stringify(body).slice(0, 300));
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        state.stopped = true;
        await save();
        for (const c of state.chats) await send(c, `🛑 Radar stopped: X answered ${res.status} (${esc(body.title ?? body.detail ?? 'error')}). Check the key and credits.`).catch(() => {});
      }
      return;
    }
    const posts = body.data ?? [], users = body.includes?.users ?? [];
    state.reads += posts.length;
    state.users += users.length;
    state.spentUsd += posts.length * PRICE.post + users.length * PRICE.user;
    if (body.meta?.newest_id) state.sinceId = body.meta.newest_id;
    const byId = new Map(users.map((u) => [u.id, u]));
    const seen = new Set(state.seen);
    const fresh = posts
      .map((p) => ({ p, u: byId.get(p.author_id) }))
      .filter(({ p, u }) => u && !seen.has(p.id) && (u.public_metrics?.followers_count ?? 0) >= minFollowers && (p.public_metrics?.reply_count ?? 0) <= maxReplies && Date.now() - Date.parse(p.created_at) <= maxAgeMin * 60_000)
      .sort((a, b) => (b.u.public_metrics?.followers_count ?? 0) - (a.u.public_metrics?.followers_count ?? 0));
    for (const { p, u } of fresh) {
      const hit = formatHit(p, u, state.hits++);
      for (const c of state.chats) await send(c, hit.text, { reply_markup: hit.keyboard, link_preview_options: { is_disabled: true } }).catch((e) => log.error('[radar] send', e.message));
      state.seen.push(p.id);
    }
    state.seen = state.seen.slice(-2000);
    await save();
    log.log(`[radar] ${posts.length} posts, ${users.length} users, ${fresh.length} sent, ~$${state.spentUsd.toFixed(3)} spent`);
  }

  return {
    async start() {
      await load();
      const loop = async () => { await tick().catch((e) => log.error('[radar] tick', e.message)); timer = setTimeout(loop, intervalMs); };
      timer = setTimeout(loop, 5_000);
    },
    stop: () => clearTimeout(timer),
    async subscribe(chatId) { await load(); if (!state.chats.includes(chatId)) state.chats.push(chatId); state.stopped = state.spentUsd >= budgetUsd; await save(); return state; },
    async track(chatId, handles) {
      await load();
      const list = (state.tracks[chatId] ??= []);
      const total = new Set(Object.values(state.tracks).flat()).size;
      const added = [], refused = [];
      for (const h of handles) {
        if (list.includes(h)) continue;
        if (list.length >= TRACK_MAX || total + added.length >= TRACK_TOTAL) { refused.push(h); continue; }
        list.push(h); added.push(h);
      }
      if (added.length && !state.trackFrom) state.trackFrom = new Date(Date.now() - 60_000).toISOString();
      await save();
      return { added, refused, list: [...list] };
    },
    async untrack(chatId, handles) { await load(); state.tracks[chatId] = (state.tracks[chatId] ?? []).filter((h) => !handles.includes(h)); await save(); return state.tracks[chatId]; },
    tracks: (chatId) => state.tracks[chatId] ?? [],
    async unsubscribe(chatId) { await load(); state.chats = state.chats.filter((c) => c !== chatId); await save(); return state; },
    status: () => state,
    budgetUsd,
  };
}
