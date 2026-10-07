import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createRadar, TRACK_MAX } from './bot/radar.mjs';
import { crewFromLinks, crewOf, linksFromXray, openDb } from './crews.mjs';
import { createCouncil, factsOf, SEATS } from './council.mjs';
import { initRecord, recordVerdict } from './record.mjs';
import { DEFAULTS as FEED_DEFAULTS, describe as describeFeed, initFeed, parseFilters, passes } from './feed.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';
import { scanToken } from './scan.mjs';
import { xrayToken } from './xray.mjs';
import { LaunchError } from './launch.mjs';
import { scanSvg, xraySvg, alertSvg, render, fetchImage } from './bot/render.mjs';

/**
 * Gem Search on Telegram: scans a coin, X-rays who holds it, and watches it for changes. Talks to the Bot API with
 * plain fetch and long polling; the update offset and the watch list live in DATA_DIR so a restart picks up where it
 * left off. Everything a user can see is escaped before it goes into an HTML message.
 */

export const SITE = 'https://gemsearch.fun';
export const TOKEN_CA = 'GQCGitfVw5LYnj4L4zrNUMYeK9dNxEJi9ZjMwMfQpump';
export const MAX_WATCHES = 5;
const WATCH_EVERY_MS = 10 * 60_000;
const WATCH_GAP_MS = 3_000;
const SCAN_TTL_MS = 60_000;
const XRAY_TTL_MS = 5 * 60_000;
const LIMITS = { scan: 8, xray: 3 }; // per user per minute

// --- pure helpers ----------------------------------------------------------------------------------------------------

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Is this text a Solana public key (base58, 32 bytes)? */
export function isAddress(text) {
  if (typeof text !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return false;
  try {
    return new PublicKey(text).toBytes().length === 32;
  } catch {
    return false;
  }
}

/** The first Solana address in a message, or null. pump.fun / DexScreener / gemsearch links work too. */
export function extractCA(text) {
  for (const m of String(text ?? '').matchAll(/(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g)) if (isAddress(m[0])) return m[0];
  return null;
}

export function money(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return '—';
  const n = Number(x);
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function age(hours) {
  if (hours === null || hours === undefined) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function bar(score) {
  const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
  const cell = score >= 70 ? '🟩' : score >= 40 ? '🟨' : '🟥';
  return cell.repeat(filled) + '⬜'.repeat(10 - filled);
}

const ICON = { pass: '✅', warn: '⚠️', fail: '❌', unknown: '❔', info: 'ℹ️' };
export const DISCLAIMER = '<i>Not financial advice. A high score means a clean launch, not that the coin goes up. Unknown checks never count as a pass.</i>';
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '?');
const coinName = (s) => `${esc(s.name ?? 'Unknown')}${s.symbol ? ` <b>$${esc(s.symbol)}</b>` : ''}`;

export function formatScan(s) {
  const tags = [];
  if (s.pump) tags.push(s.graduated ? '🎓 graduated' : `📈 on curve${s.progress !== null && s.progress !== undefined ? ` ${s.progress}%` : ''}`);
  if (s.checks?.some((c) => c.id === 'dex' && c.status === 'pass')) tags.push('💎 DEX PAID');
  const m = s.market;
  const lines = [
    `🕷️ ${coinName(s)}`,
    `<code>${esc(s.mint)}</code>`,
    '',
    `<b>Score ${s.score}/100</b>  ${bar(s.score)}${s.unknown ? `  (${s.unknown} unknown)` : ''}`,
  ];
  if (tags.length) lines.push(tags.join(' · '));
  if (m) lines.push(`MC ${money(m.marketCap)} · Liq ${money(m.liquidityUsd)} · Vol 24h ${money(m.volume24h)} · Age ${age(m.ageHours)}`);
  else lines.push('No DEX market yet');
  lines.push('');
  for (const c of s.checks ?? []) lines.push(`${ICON[c.status] ?? '•'} <b>${esc(c.label)}</b>: ${esc(c.detail)}`);
  lines.push('', DISCLAIMER);
  return lines.join('\n');
}

export function scanKeyboard(s) {
  const row1 = [{ text: '🕸️ X-ray', callback_data: `x:${s.mint}` }, { text: '🔎 Full scan', url: `${SITE}/scan?ca=${s.mint}` }];
  const row2 = [];
  if (s.pump) row2.push({ text: 'pump.fun', url: `https://pump.fun/coin/${s.mint}` });
  if (s.market?.url) row2.push({ text: 'DexScreener', url: s.market.url });
  row2.push({ text: '👁 Watch', callback_data: `w:${s.mint}` });
  return { inline_keyboard: [row1, row2] };
}

export function xrayVerdict(x) {
  const b = x.bundle;
  const top = x.clusters?.[0];
  if (b && (b.sameBlockWallets >= 3 || b.sameBlockBoughtPct >= 10) && b.launchBuyersHoldNowPct > 5) return `🚨 <b>Bundle</b>: ${b.sameBlockWallets} wallets bought ${b.sameBlockBoughtPct}% in the launch block, launch buyers still hold ${b.launchBuyersHoldNowPct}%`;
  if (top && top.holdsPct > 10) return `⚠️ <b>Linked wallets hold ${top.holdsPct}%</b> (${top.size} wallets in one cluster)`;
  if (!x.clusters?.length) return '✅ <b>No linked wallets found</b> among the top holders and launch buyers';
  return `✅ <b>No big cluster</b>: the largest linked group holds ${top.holdsPct}%`;
}

export function formatXray(x, s = null) {
  const lines = [`🕸️ <b>Web X-ray</b>${s ? ` · ${coinName(s)}` : ''}`, `<code>${esc(x.mint)}</code>`, ''];
  const b = x.bundle;
  if (b && x.launch) {
    lines.push('<b>Launch</b>');
    lines.push(`• Launch block: ${b.sameBlockWallets} wallet${b.sameBlockWallets === 1 ? '' : 's'} bought ${b.sameBlockBoughtPct}%`);
    lines.push(`• First ${b.windowSeconds}s: ${b.launchWindowWallets} wallet${b.launchWindowWallets === 1 ? '' : 's'} bought ${b.launchWindowBoughtPct}%`);
    lines.push(`• Launch buyers hold now: ${b.launchBuyersHoldNowPct}%`);
    lines.push(`• <a href="https://solscan.io/tx/${esc(x.launch.signature)}">Launch tx</a>${x.launch.at ? ` · ${esc(x.launch.at.slice(0, 16).replace('T', ' '))} UTC` : ''}`);
  } else lines.push('<b>Launch</b>: could not reach the first transactions (too much history)');
  lines.push(`• Curve / pool holds: ${x.poolPct}%`);
  if (x.dev) lines.push(`• Dev: <code>${esc(x.dev)}</code>`);
  lines.push('');
  const clusters = (x.clusters ?? []).slice(0, 5);
  if (clusters.length) {
    lines.push('<b>Linked wallets</b>');
    clusters.forEach((c, i) => lines.push(`${i + 1}. ${c.size} wallets hold ${c.holdsPct}%${c.reasons?.length ? ` — ${esc(c.reasons.join(', '))}` : ''}`));
    if ((x.clusters?.length ?? 0) > 5) lines.push(`…and ${x.clusters.length - 5} more`);
    lines.push('');
  }
  lines.push(xrayVerdict(x));
  lines.push('', `<a href="${SITE}/scan?ca=${esc(x.mint)}">See the web on gemsearch.fun</a>`);
  lines.push(DISCLAIMER);
  return lines.join('\n');
}

const num = (re, text) => {
  const m = re.exec(String(text ?? ''));
  return m ? Number(m[1]) : null;
};

/** What the watcher remembers about a coin between scans. */
export function snapshot(s) {
  const check = (id) => s.checks?.find((c) => c.id === id);
  return {
    symbol: s.symbol ?? null,
    score: s.score,
    statuses: Object.fromEntries((s.checks ?? []).map((c) => [c.id, c.status])),
    labels: Object.fromEntries((s.checks ?? []).map((c) => [c.id, c.label])),
    devShare: check('dev')?.status !== 'unknown' ? num(/holds ([\d.]+)%/, check('dev')?.detail) : null,
    top10: check('holders')?.status !== 'unknown' ? num(/^([\d.]+)%/, check('holders')?.detail) : null,
    liquidity: s.market?.liquidityUsd ?? null,
    graduated: Boolean(s.graduated),
    dexPaid: check('dex')?.status === 'pass',
    at: s.at ?? new Date().toISOString(),
  };
}

/**
 * Compares the remembered snapshot with a fresh one. Returns the alert lines and the snapshot to remember next:
 * levels that only alert one way (score, liquidity, top 10) keep the best value seen since the last alert, so a slow
 * slide still adds up to an alert; the dev share keeps its level until it has moved 2 points either way.
 */
export function diffSnapshots(prev, next) {
  const alerts = [];
  const keep = { ...next };
  if (!prev) return { alerts, snap: keep };
  if (prev.score - next.score >= 10) alerts.push(`📉 Score ${prev.score} → ${next.score}`);
  else keep.score = Math.max(prev.score, next.score);
  for (const [id, status] of Object.entries(next.statuses ?? {})) {
    if (status === 'fail' && prev.statuses?.[id] && prev.statuses[id] !== 'fail') alerts.push(`❌ ${next.labels?.[id] ?? id}: ${prev.statuses[id]} → fail`);
  }
  if (prev.devShare !== null && next.devShare !== null && prev.devShare !== undefined) {
    const d = next.devShare - prev.devShare;
    if (Math.abs(d) >= 2) alerts.push(`${d < 0 ? '🔻 Dev sold' : '🔺 Dev bought'}: ${prev.devShare}% → ${next.devShare}%`);
    else keep.devShare = prev.devShare;
  } else if (next.devShare === null) keep.devShare = prev.devShare ?? null;
  if (prev.liquidity > 0 && next.liquidity !== null) {
    if (next.liquidity <= prev.liquidity * 0.7) alerts.push(`💧 Liquidity ${money(prev.liquidity)} → ${money(next.liquidity)} (−${Math.round((1 - next.liquidity / prev.liquidity) * 100)}%)`);
    else keep.liquidity = Math.max(prev.liquidity, next.liquidity);
  } else if (next.liquidity === null) keep.liquidity = prev.liquidity ?? null;
  if (!prev.graduated && next.graduated) alerts.push('🎓 Graduated from the pump.fun curve');
  if (!prev.dexPaid && next.dexPaid) alerts.push('💎 DexScreener profile is now paid');
  if (prev.top10 !== null && next.top10 !== null && prev.top10 !== undefined) {
    if (next.top10 - prev.top10 >= 10) alerts.push(`🐋 Top 10 holders ${prev.top10}% → ${next.top10}%`);
    else keep.top10 = Math.min(prev.top10, next.top10);
  } else if (next.top10 === null) keep.top10 = prev.top10 ?? null;
  return { alerts, snap: keep };
}

export function formatAlert(mint, s, alerts) {
  return [`👁 ${coinName(s)} changed`, `<code>${esc(mint)}</code>`, '', ...alerts.map(esc), '', `<a href="${SITE}/scan?ca=${esc(mint)}">Full scan</a> · /unwatch ${esc(mint)}`].join('\n');
}

export const HELP = [
  '🕷️ <b>Gem Search</b> — the rainbow spider for the X feed, now in Telegram.',
  '',
  'Send me a Solana contract address and I scan the coin: mint and freeze authority, top holders, dev wallet and history, liquidity, DexScreener profile, ticker clones.',
  '',
  '<b>Commands</b>',
  '/scan &lt;CA&gt; — safety scan with a score',
  '/xray &lt;CA&gt; — Web X-ray: bundles, snipers, linked wallets',
  '/watch &lt;CA&gt; — alert me when the coin changes (up to 5)',
  '/unwatch &lt;CA&gt; · /watches — manage alerts',
  '/launch — launch a coin on pump.fun from your own wallet',
  '/token — $GEMSEARCH',
  '',
  `🌐 <a href="${SITE}">gemsearch.fun</a> · 𝕏 <a href="https://x.com/gemsearchfun">@gemsearchfun</a> · <a href="https://github.com/h100envy/gem-search">open source</a>`,
  '',
  DISCLAIMER,
].join('\n');

export const LAUNCH_TEXT = [
  '🚀 <b>Gem Search Launchpad</b>',
  '',
  '• Launches a pump.fun coin signed by your own wallet: we never hold a key.',
  '• 0% fee on top of pump.fun, optional dev buy in the same transaction.',
  '• Creator fees can go to a GitHub account; Pay Dex right from the page.',
  '',
  `👉 <a href="${SITE}/launch">gemsearch.fun/launch</a>`,
].join('\n');

export const TOKEN_TEXT = [
  '🕷️ <b>$GEMSEARCH</b>',
  '',
  `CA: <code>${TOKEN_CA}</code>`,
  '',
  `🔎 <a href="${SITE}/scan?ca=${TOKEN_CA}">Scan it</a> · <a href="https://pump.fun/coin/${TOKEN_CA}">pump.fun</a> · <a href="https://dexscreener.com/solana/${TOKEN_CA}">DexScreener</a>`,
  `🌐 <a href="${SITE}">gemsearch.fun</a> · 𝕏 <a href="https://x.com/gemsearchfun">@gemsearchfun</a>`,
].join('\n');

/** Visible length of an HTML message, as Telegram counts a caption. */
export const visibleLength = (html) => String(html).replace(/<[^>]+>/g, '').replace(/&(lt|gt|amp|quot);/g, '_').length;

/** A caption that fits (≤ max visible characters, cut between lines) and the rest for a follow-up message. */
/** One or two lines about the coin's crew, for the X-ray caption. */
export function formatCrew(c) {
  if (!c) return '';
  if (!c.crew) return '\n\n🧠 <b>Bundle Crew:</b> no known crew in the spider\'s memory yet.';
  const k = c.crew;
  return `\n\n🧠 <b>Bundle Crew: seen before.</b> ${k.walletsHere} wallet${k.walletsHere === 1 ? '' : 's'} here ${k.walletsHere === 1 ? 'shares' : 'share'} funders with wallets from <b>${k.launches}</b> other launch${k.launches === 1 ? '' : 'es'}. 1h later: ${k.under10kAt1h} went nowhere, ${k.over50kAt1h} took off${k.launches - k.judged ? `, ${k.launches - k.judged} pending` : ''}. <i>A funding pattern, not a proven identity.</i>`;
}

export function splitCaption(html, max = 1024) {
  if (visibleLength(html) <= max) return [html, null];
  const lines = String(html).split('\n');
  const head = [];
  while (lines.length && visibleLength([...head, lines[0]].join('\n')) <= max) head.push(lines.shift());
  if (!head.length) return ['', html];
  return [head.join('\n').trimEnd(), lines.join('\n').trim() || null];
}

/** Splits "/scan@bot arg" into its parts; null when it is not a command or is meant for another bot. */
export function parseCommand(text, botName) {
  const m = /^\/([a-zA-Z_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  if (m[2] && botName && m[2].toLowerCase() !== botName.toLowerCase()) return null;
  return { cmd: m[1].toLowerCase(), arg: (m[3] ?? '').trim() };
}

// --- runtime ---------------------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createBot({ token, rpc, dataDir = '/data', conn = null, log = console, radar: radarConfig = null, xaiKey = null } = {}) {
  const API = `https://api.telegram.org/bot${token}`;
  const clean = (e) => String(e?.stack ?? e).split(token).join('<token>');
  const connection = conn ?? new Connection(rpc, 'confirmed');
  const statePath = join(dataDir, 'bot-state.json');
  const watchPath = join(dataDir, 'bot-watches.json');
  let me = null;
  let state = { offset: 0 };
  let watches = {}; // chatId -> { mint: { added, snap } }
  let crewDb = null;

  async function tg(method, params = {}, tries = 4) {
    for (let i = 0; ; i++) {
      let res;
      try {
        const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(method === 'getUpdates' ? 60_000 : 20_000) });
        res = await r.json();
      } catch (e) {
        if (i + 1 >= tries) throw new Error(`${method}: ${e.message}`);
        await sleep(1_000 * (i + 1));
        continue;
      }
      if (res.ok) return res.result;
      if (res.error_code === 429 && i + 1 < tries) {
        await sleep(((res.parameters?.retry_after ?? 1) + 0.5) * 1000);
        continue;
      }
      const err = new Error(`${method}: ${res.error_code} ${res.description}`);
      err.code = res.error_code;
      err.description = res.description;
      throw err;
    }
  }

  async function saveJson(path, data) {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, path);
  }
  const loadJson = async (path, fallback) => {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return fallback;
    }
  };

  // Shared cache: repeated coins cost nothing for a while, and two people asking at once share one scan.
  const cache = new Map();
  function cached(kind, mint, ttl, run) {
    const key = `${kind}:${mint}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.promise;
    const promise = run();
    cache.set(key, { at: Date.now(), promise });
    promise.catch(() => cache.delete(key));
    if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at > XRAY_TTL_MS) cache.delete(k);
    return promise;
  }
  const scan = (mint) => cached('scan', mint, SCAN_TTL_MS, () => scanToken(connection, rpc, mint));
  const xray = (mint) => cached('xray', mint, XRAY_TTL_MS, () => xrayToken(connection, rpc, mint));

  const hits = new Map();
  function allowed(kind, userId) {
    const key = `${kind}:${userId}`;
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= LIMITS[kind]) {
      hits.set(key, list);
      return false;
    }
    list.push(now);
    hits.set(key, list);
    return true;
  }

  // Pictures: one PNG per data result (a WeakMap keyed by the cached object lives exactly as long as the data
  // cache keeps it); coin images are fetched once per 10 minutes; fixed artwork goes up once, then by file_id.
  const pictures = new WeakMap();
  const images = new Map();
  const uploaded = new Map();
  function coinImage(url) {
    if (!url) return Promise.resolve(null);
    const hit = images.get(url);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.promise;
    const promise = fetchImage(url);
    images.set(url, { at: Date.now(), promise });
    if (images.size > 300) for (const [k, v] of images) if (Date.now() - v.at > 10 * 60_000) images.delete(k);
    return promise;
  }
  function picture(obj, build) {
    if (!obj || typeof obj !== 'object') return build();
    if (!pictures.has(obj)) {
      const p = build();
      pictures.set(obj, p);
      p.catch(() => pictures.delete(obj));
    }
    return pictures.get(obj);
  }
  const scanPng = (s) => picture(s, async () => render(scanSvg(s, await coinImage(s.image))));
  const xrayPng = (x, s) => picture(x, async () => render(xraySvg(x, s, await coinImage(s?.image))));

  async function tgForm(method, fields, file) {
    for (let i = 0; ; i++) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      form.append(file.field, new Blob([file.data], { type: file.type }), file.name);
      let res;
      try {
        res = await (await fetch(`${API}/${method}`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) })).json();
      } catch (e) {
        if (i >= 2) throw new Error(`${method}: ${e.message}`);
        await sleep(1_000 * (i + 1));
        continue;
      }
      if (res.ok) return res.result;
      if (res.error_code === 429 && i < 3) {
        await sleep(((res.parameters?.retry_after ?? 1) + 0.5) * 1000);
        continue;
      }
      const err = new Error(`${method}: ${res.error_code} ${res.description}`);
      err.code = res.error_code;
      err.description = res.description;
      throw err;
    }
  }

  /**
   * A photo (PNG buffer, or a cached file_id under `key`) with the HTML text as its caption; text past 1024
   * characters follows as a message. The keyboard goes on the last message so it sits under everything.
   */
  async function sendPhoto(chatId, photo, html, { reply_markup, reply_to_message_id, key, name = 'card.png', type = 'image/png' } = {}) {
    const [caption, rest] = splitCaption(html);
    const fields = { chat_id: chatId, caption, parse_mode: 'HTML', reply_to_message_id, allow_sending_without_reply: reply_to_message_id ? true : undefined, reply_markup: rest ? undefined : reply_markup };
    let sent;
    const id = key && uploaded.get(key);
    if (id) sent = await tg('sendPhoto', { ...fields, photo: id }).catch(() => null);
    if (!sent) {
      const data = typeof photo === 'function' ? await photo() : photo;
      sent = await tgForm('sendPhoto', fields, { field: 'photo', data, name, type });
      const fid = sent.photo?.[sent.photo.length - 1]?.file_id;
      if (key && fid) uploaded.set(key, fid);
    }
    if (rest) await send(chatId, rest, { reply_markup }).catch((e) => log.error('[bot] follow-up', clean(e)));
    return sent;
  }
  const asset = (file) => () => readFile(new URL(`./bot/assets/${file}`, import.meta.url));

  const send = (chatId, text, extra = {}) => tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  // Shill Radar: team-only, switched on per chat with a code from the server's environment; not in the public menu.
  const radar = radarConfig?.bearer ? createRadar({ ...radarConfig, dataDir, send, log, onCA: (chatId, mint, handle) => sentinel(chatId, mint, handle) }) : null;
  async function onRadar(chatId, arg) {
    if (!radar) return send(chatId, '🕷️ The radar is not set up on this server.');
    const [word, code] = String(arg ?? '').trim().split(/\s+/);
    if (word === 'off') { await radar.unsubscribe(chatId); return send(chatId, '📴 Radar off for this chat.'); }
    if (word === 'status') {
      const st = radar.status();
      if (!st.chats.includes(chatId)) return null;
      return send(chatId, `📡 Radar ${st.stopped ? 'paused' : 'on'} · ${st.chats.length} chat(s)\nPosts read ${st.reads}, authors ${st.users}, alerts ${st.hits}\nSpent ≈ $${st.spentUsd.toFixed(2)} of $${radar.budgetUsd}`);
    }
    if (word === 'on' && code && code === radarConfig.code) {
      const st = await radar.subscribe(chatId);
      return send(chatId, `📡 Radar on. Fresh "shill me your ticker" posts from accounts with ${radarConfig.minFollowers ?? 1000}+ followers will land here every few minutes, with a draft reply. You post by hand.\nSpent so far ≈ $${st.spentUsd.toFixed(2)} of $${radar.budgetUsd}. /radar status · /radar off`);
    }
    return null; // wrong or missing code: stay quiet
  }

  // X accounts a chat follows: their posts land here, with a scan button when they carry a contract address.
  async function onTrack(chatId, cmd, arg, replyTo) {
    const opts = { reply_to_message_id: replyTo, allow_sending_without_reply: true };
    if (!radar) return send(chatId, '🕷️ Tracking is not set up on this server.', opts);
    const handles = [...new Set(String(arg ?? '').split(/[\s,]+/).map((h) => h.replace(/^@/, '').replace(/^https?:\/\/(x|twitter)\.com\//i, '').split(/[/?]/)[0].toLowerCase()).filter(Boolean))];
    const bad = handles.filter((h) => !/^[a-z0-9_]{1,15}$/.test(h));
    const good = handles.filter((h) => !bad.includes(h));
    if (cmd === 'tracks') {
      const list = radar.tracks(chatId);
      return send(chatId, list.length ? `👁 Tracking in this chat (${list.length}/${TRACK_MAX}):\n${list.map((h) => `• @${h}`).join('\n')}\n\n/untrack @name to stop.` : `👁 Nothing tracked here yet. <code>/track @name</code> — up to ${TRACK_MAX} X accounts. I post their new tweets here and add a scan button when they drop a contract address.`, opts);
    }
    if (!good.length) return send(chatId, `🕷️ Send X usernames: <code>/${cmd} @name @other</code>`, opts);
    if (cmd === 'untrack') { const list = await radar.untrack(chatId, good); return send(chatId, `👁 Stopped tracking ${good.map((h) => '@' + h).join(', ')}. ${list.length} left.`, opts); }
    const r = await radar.track(chatId, good);
    return send(chatId, [
      r.added.length ? `👁 Tracking ${r.added.map((h) => '@' + h).join(', ')}. New posts land here within a few minutes; contract addresses get a 🔎 Scan button.` : '',
      r.refused.length ? `Not added: ${r.refused.map((h) => '@' + h).join(', ')} (up to ${TRACK_MAX} per chat).` : '',
      bad.length ? `Not X usernames: ${bad.map(esc).join(', ')}` : '',
      `Now: ${r.list.length}/${TRACK_MAX}. /tracks to see them.`,
    ].filter(Boolean).join('\n'), opts);
  }
  const edit = (chatId, messageId, text, extra = {}) => tg('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  const errorText = (e) => {
    if (e instanceof LaunchError) return `🕷️ ${esc(e.message.charAt(0).toUpperCase() + e.message.slice(1))}.`;
    log.error('[bot] unexpected', clean(e));
    return '🕷️ Something went wrong reading the chain. Try again in a minute.';
  };

  async function runScan(chatId, userId, mint, replyTo) {
    if (!allowed('scan', userId)) return send(chatId, '🕷️ Easy there: 8 scans a minute. Try again in a few seconds.', { reply_to_message_id: replyTo, allow_sending_without_reply: true });
    const msg = await send(chatId, '🕷️ scanning…', { reply_to_message_id: replyTo, allow_sending_without_reply: true });
    try {
      const s = await scan(mint);
      try {
        await sendPhoto(chatId, await scanPng(s), formatScan(s), { reply_markup: scanKeyboard(s), reply_to_message_id: replyTo });
        await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      } catch (e) {
        log.error('[bot] scan card', clean(e));
        await edit(chatId, msg.message_id, formatScan(s), { reply_markup: scanKeyboard(s) });
      }
    } catch (e) {
      await edit(chatId, msg.message_id, errorText(e)).catch(() => {});
    }
  }

  async function runXray(chatId, userId, mint, replyTo) {
    if (!allowed('xray', userId)) return send(chatId, '🕷️ X-rays are heavy: 3 a minute. Try again shortly.', { reply_to_message_id: replyTo, allow_sending_without_reply: true });
    const msg = await send(chatId, '🕸️ X-raying… (following the money takes up to a minute)', { reply_to_message_id: replyTo, allow_sending_without_reply: true });
    try {
      const [x, s] = await Promise.all([xray(mint), scan(mint).catch(() => null)]);
      const kb = { inline_keyboard: [[{ text: '🔎 See the web', url: `${SITE}/scan?ca=${mint}` }]] };
      let crewLine = '';
      try {
        crewDb ??= openDb(join(dataDir, 'crews.db'));
        const rec = crewOf(crewDb, mint);
        crewLine = formatCrew(rec.known ? rec : (() => { const l = linksFromXray(x); return { crew: crewFromLinks(crewDb, mint, l.wallets, l.funders) }; })());
      } catch (e) { log.error('[bot] crew', clean(e)); }
      try {
        await sendPhoto(chatId, await xrayPng(x, s), formatXray(x, s) + crewLine, { reply_markup: kb, reply_to_message_id: replyTo });
        await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      } catch (e) {
        log.error('[bot] xray card', clean(e));
        await edit(chatId, msg.message_id, formatXray(x, s) + crewLine, { reply_markup: kb });
      }
    } catch (e) {
      await edit(chatId, msg.message_id, errorText(e)).catch(() => {});
    }
  }

  // Grok Council: four Grok seats debate the coin from live X posts and the spider's facts, then vote.
  const council = xaiKey ? createCouncil({ key: xaiKey, dataDir, file: 'council-bot.json', dailyUsd: Number(process.env.COUNCIL_BOT_DAILY_USD ?? 0.75), log }) : null;
  const councilHits = new Map();
  async function councilFactsFor(mint) {
    const [s, x] = await Promise.all([scan(mint), xray(mint).catch(() => null)]);
    let c = null;
    try { crewDb ??= openDb(join(dataDir, 'crews.db')); const rec = crewOf(crewDb, mint); c = rec.known ? rec : x ? (() => { const l = linksFromXray(x); return { crew: crewFromLinks(crewDb, mint, l.wallets, l.funders) }; })() : null; } catch {}
    return { s, facts: factsOf(s, x, c) };
  }

  async function runRoast(chatId, userId, mint, replyTo) {
    const opts = { reply_to_message_id: replyTo, allow_sending_without_reply: true };
    if (!council) return send(chatId, '🔥 The roaster is not set up on this server.', opts);
    const now = Date.now(), hits = (councilHits.get('r' + userId) ?? []).filter((t) => now - t < 600_000);
    if (hits.length >= 4) return send(chatId, '🔥 Four roasts per 10 minutes per person. Let the grill cool down.', opts);
    councilHits.set('r' + userId, [...hits, now]);
    const msg = await send(chatId, '🔥 Heating the grill…', opts);
    try {
      const { s, facts } = await councilFactsFor(mint);
      const r = await council.roast(facts);
      const caption = `🔥 <b>The Roaster</b> on ${esc(s.name ?? '')} ${s.symbol ? '<b>$' + esc(s.symbol) + '</b>' : ''}\n\n${esc(r.roast)}\n\n<i>Grok in fun mode, roasting on-chain facts. Not financial advice.</i>`;
      await sendPhoto(chatId, asset('roaster.jpg'), caption, { key: 'roaster', name: 'roaster.jpg', type: 'image/jpeg', reply_markup: { inline_keyboard: [[{ text: '🔎 Full scan', url: `${SITE}/scan?ca=${mint}` }, { text: '🤖 Council', callback_data: `c:${mint}` }]] } });
      await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
    } catch (e) {
      await edit(chatId, msg.message_id, errorText(e)).catch(() => {});
    }
  }

  async function runCouncil(chatId, userId, mint, replyTo) {
    const opts = { reply_to_message_id: replyTo, allow_sending_without_reply: true };
    if (!council) return send(chatId, '🤖 The council is not set up on this server.', opts);
    const now = Date.now(), hits = (councilHits.get(userId) ?? []).filter((t) => now - t < 600_000);
    if (hits.length >= 2) return send(chatId, '🤖 The council meets twice per 10 minutes per person. Try again shortly.', opts);
    councilHits.set(userId, [...hits, now]);
    const msg = await send(chatId, '🤖 Convening the Grok Council… the Lookout is reading X (about 20 seconds)', opts);
    try {
      const { s, facts } = await councilFactsFor(mint);
      const d = await council.convene(facts);
      try { initRecord(crewDb); recordVerdict(crewDb, d, facts, 'bot'); } catch {}
      const md = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[\[(\d+)\]\]\([^)]+\)/g, '');
      const head = `🤖 <b>Grok Council</b> on ${esc(s.name ?? '')} ${s.symbol ? '<b>$' + esc(s.symbol) + '</b>' : ''}\n\n🔭 <b>What X says</b>\n${md(d.x.summary || 'almost nothing yet').slice(0, 900)}`;
      const talk = d.turns.map((t) => `${SEATS[t.seat]?.emoji ?? '🕷️'} <b>${SEATS[t.seat]?.name ?? t.seat}:</b> ${md(t.text)}`).join('\n\n');
      const votes = d.votes.map((v) => `${SEATS[v.seat]?.emoji ?? ''} ${SEATS[v.seat]?.name ?? v.seat}: <b>${v.vote}</b> — ${md(v.why)}`).join('\n');
      const end = `${votes}\n\n🏛 <b>Verdict: ${d.verdict}</b> (APE ${d.tally.APE} · WATCH ${d.tally.WATCH} · AVOID ${d.tally.AVOID})\n<i>${md(d.summary)}</i>\n\n<i>Grok reads X claims as opinions and checks them against the spider's data. Not financial advice.</i>`;
      await edit(chatId, msg.message_id, head);
      await send(chatId, talk);
      await send(chatId, end, { reply_markup: { inline_keyboard: [[{ text: '🔎 Full scan + council on the site', url: `${SITE}/scan?ca=${mint}` }]] } });
    } catch (e) {
      await edit(chatId, msg.message_id, errorText(e)).catch(() => {});
    }
  }

  // Council sentinel: when a tracked account drops a contract address, the council convenes by itself, a few times a
  // day per chat, and posts a short verdict under the tracked post.
  const SENTINEL_PER_DAY = Number(process.env.SENTINEL_PER_DAY ?? 6);
  const sentinelDone = new Map();
  async function sentinel(chatId, mint, handle) {
    if (!council) return;
    const day = new Date().toISOString().slice(0, 10), key = `${chatId}:${day}`;
    const n = sentinelDone.get(key) ?? 0;
    if (n >= SENTINEL_PER_DAY) return;
    sentinelDone.set(key, n + 1);
    try {
      const { s, facts } = await councilFactsFor(mint);
      const d = await council.convene(facts);
      try { initRecord(crewDb); recordVerdict(crewDb, d, facts, 'sentinel'); } catch {}
      const skeptic = d.turns.find((t) => t.seat === 'skeptic')?.text ?? '';
      const votes = d.votes.map((v) => `${SEATS[v.seat]?.emoji ?? ''}${v.vote}`).join(' ');
      await send(chatId, `🤖 <b>Council on @${esc(handle)}'s call</b> ${s.symbol ? '<b>$' + esc(s.symbol) + '</b>' : ''}\n\n🧐 <b>Skeptic:</b> ${esc(skeptic)}\n\n🏛 <b>Verdict: ${d.verdict}</b> · ${votes}\n<i>${esc(d.summary)}</i>\n\n<i>Auto-council ${n + 1}/${SENTINEL_PER_DAY} today. Not financial advice.</i>`, { reply_markup: { inline_keyboard: [[{ text: '🔎 Full scan + debate', url: `${SITE}/scan?ca=${mint}` }, { text: '🔥 Roast', callback_data: `r:${mint}` }]] } });
    } catch (e) { log.error('[sentinel]', clean(e)); }
  }

  // Clean Launch Feed: new pump.fun launches that pass this chat's filters, about a minute after mint.
  const feedPath = join(dataDir, 'feed-subs.json');
  let feedSubs = null, feedLast = null;
  const FEED_PER_HOUR = 20;
  async function onFeed(chatId, arg, replyTo) {
    feedSubs ??= await loadJson(feedPath, {});
    const opts = { reply_to_message_id: replyTo, allow_sending_without_reply: true };
    const [word, ...rest] = String(arg ?? '').trim().split(/\s+/);
    if (word === 'off') { delete feedSubs[chatId]; await saveJson(feedPath, feedSubs); return send(chatId, '📴 Clean Launch Feed off for this chat.', opts); }
    if (word === 'on' || word === 'set') {
      const { filters, bad } = parseFilters(rest.join(' '), feedSubs[chatId]?.filters ?? FEED_DEFAULTS);
      feedSubs[chatId] = { filters, sent: feedSubs[chatId]?.sent ?? [] };
      await saveJson(feedPath, feedSubs);
      return send(chatId, `🟢 <b>Clean Launch Feed on.</b> New pump.fun launches that pass these filters land here about a minute after mint (up to ${FEED_PER_HOUR} an hour):\n\n<code>${esc(describeFeed(filters))}</code>${bad.length ? `\n\nIgnored: ${esc(bad.join(' '))}` : ''}\n\nChange any: <code>/feed set dev=3 block=1</code> · stop: <code>/feed off</code>`, opts);
    }
    const cur = feedSubs[chatId];
    return send(chatId, `🟢 <b>Clean Launch Feed</b>: the spider checks every pump.fun launch about 30 seconds after mint and sends you the ones that pass your filters: no buys in the launch block, a small dev buy, real links, not a serial launcher, not a dev the spider has seen in bundle crews, not a copy of a ticker launched earlier today.\n\n${cur ? `On, with:\n<code>${esc(describeFeed(cur.filters))}</code>` : `Off. Start with the defaults: <code>/feed on</code>\nor your own: <code>/feed on dev=3 block=0 links=2</code>`}\n\nA clean launch is not a good trade: most coins still go nowhere. The feed removes the obvious traps, the rest is yours.`, opts);
  }
  async function feedPass() {
    feedSubs ??= await loadJson(feedPath, {});
    const chats = Object.keys(feedSubs);
    if (!chats.length) return;
    try { crewDb ??= openDb(join(dataDir, 'crews.db')); initFeed(crewDb); } catch (e) { return log.error('[feed] db', clean(e)); }
    if (feedLast === null) feedLast = crewDb.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM feed').get().id;
    const rows = crewDb.prepare('SELECT * FROM feed WHERE id > ? ORDER BY id LIMIT 200').all(feedLast);
    if (!rows.length) return;
    feedLast = rows[rows.length - 1].id;
    const now = Date.now();
    for (const row of rows) {
      for (const chatId of chats) {
        const sub = feedSubs[chatId];
        if (!sub || !passes(row, sub.filters)) continue;
        sub.sent = (sub.sent ?? []).filter((t) => now - t < 3_600_000);
        if (sub.sent.length >= FEED_PER_HOUR) continue;
        sub.sent.push(now);
        const links = [['X', row.twitter], ['site', row.website], ['TG', row.telegram]].filter(([, u]) => u).map(([n, u]) => `<a href="${esc(u)}">${n}</a>`).join(' · ');
        const age = Math.max(1, Math.round((now - row.t) / 1000));
        const text = `🟢 <b>Clean launch</b> · ${esc(row.name)} <b>$${esc(row.symbol)}</b> · ${age < 120 ? age + 's' : Math.round(age / 60) + 'm'} old\n\n` +
          `Launch block: <b>${row.same_slot} other buys</b>\nDev buy: <b>${row.dev_buy_pct ?? 0}%</b>\nDev's coins in 24h: <b>${(row.dev_24h ?? 0) + 1}</b>\nCrew memory: <b>${row.crew ? 'seen before' : 'not seen'}</b>\nTicker: <b>${row.clones ? row.clones + ' earlier copies today' : 'first today'}</b>\nLinks: ${links || 'none'}\n\n<code>${esc(row.mint)}</code>\n<i>Clean ≠ good. Not financial advice.</i>`;
        await send(chatId, text, { reply_markup: { inline_keyboard: [[{ text: 'pump.fun', url: `https://pump.fun/coin/${row.mint}` }, { text: '🔎 Scan', url: `${SITE}/scan?ca=${row.mint}` }, { text: '🔥 Roast', callback_data: `r:${row.mint}` }]] } }).catch((e) => {
          if (e.code === 403) delete feedSubs[chatId]; // the bot was blocked or removed
          log.error('[feed] send', clean(e));
        });
      }
    }
    await saveJson(feedPath, feedSubs).catch(() => {});
  }

  async function addWatch(chatId, mint) {
    const list = (watches[chatId] ??= {});
    if (list[mint]) return '👁 Already watching this coin.';
    if (Object.keys(list).length >= MAX_WATCHES) return `👁 This chat already watches ${MAX_WATCHES} coins. /unwatch one first.`;
    let s;
    try {
      s = await scan(mint);
    } catch (e) {
      return errorText(e);
    }
    list[mint] = { added: new Date().toISOString(), snap: snapshot(s) };
    await saveJson(watchPath, watches);
    return `👁 Watching ${coinName(s)}. I re-scan every 10 minutes and write here when the score drops, a check fails, the dev sells or buys, liquidity drains, the top 10 grow, it graduates or the Dex profile gets paid.`;
  }

  async function removeWatch(chatId, mint) {
    if (!watches[chatId]?.[mint]) return '👁 This chat does not watch that coin. /watches lists what it does.';
    delete watches[chatId][mint];
    if (!Object.keys(watches[chatId]).length) delete watches[chatId];
    await saveJson(watchPath, watches);
    return '👁 Stopped watching.';
  }

  function listWatches(chatId) {
    const list = Object.entries(watches[chatId] ?? {});
    if (!list.length) return '👁 No coins watched here. Send /watch &lt;CA&gt; or tap 👁 Watch under a scan.';
    return ['👁 <b>Watched here</b>', '', ...list.map(([m, w]) => `• ${w.snap?.symbol ? `$${esc(w.snap.symbol)} ` : ''}score ${w.snap?.score ?? '?'}\n  <code>${esc(m)}</code>`), '', `${list.length}/${MAX_WATCHES} · /unwatch &lt;CA&gt; to stop`].join('\n');
  }

  let watching = false;
  async function watchPass() {
    if (watching) return;
    watching = true;
    try {
      for (const chatId of Object.keys(watches)) {
        for (const mint of Object.keys(watches[chatId] ?? {})) {
          const w = watches[chatId]?.[mint];
          if (!w) continue;
          try {
            const s = await scan(mint);
            const { alerts, snap } = diffSnapshots(w.snap, snapshot(s));
            w.snap = snap;
            if (alerts.length) {
              try {
                try {
                  await sendPhoto(chatId, render(alertSvg(s, alerts, await coinImage(s.image))), formatAlert(mint, s, alerts), { reply_markup: scanKeyboard(s) });
                } catch (e) {
                  if (e.code === 403 || /chat not found/i.test(e.description ?? '')) throw e;
                  log.error('[bot] alert card', clean(e));
                  await send(chatId, formatAlert(mint, s, alerts), { reply_markup: scanKeyboard(s) });
                }
              } catch (e) {
                if (e.code === 403 || /chat not found/i.test(e.description ?? '')) {
                  log.log(`[bot] chat ${chatId} gone, dropping its watches`);
                  delete watches[chatId];
                  break;
                }
                throw e;
              }
            }
          } catch (e) {
            if (!(e instanceof LaunchError)) log.error('[bot] watch', mint, clean(e));
          }
          await sleep(WATCH_GAP_MS);
        }
      }
      await saveJson(watchPath, watches);
    } catch (e) {
      log.error('[bot] watch pass', clean(e));
    } finally {
      watching = false;
    }
  }

  async function onMessage(m) {
    const text = m.text ?? m.caption ?? '';
    if (!text || m.from?.is_bot) return;
    const chatId = m.chat.id;
    const userId = m.from?.id ?? chatId;
    const priv = m.chat.type === 'private';
    const replyCA = () => extractCA(m.reply_to_message?.text ?? m.reply_to_message?.caption ?? '');
    const cmd = parseCommand(text, me?.username);
    if (cmd) {
      const ca = () => extractCA(cmd.arg) ?? replyCA();
      const need = async (what) => {
        await send(chatId, `🕷️ Send it with a contract address: <code>/${what} &lt;CA&gt;</code>`, { reply_to_message_id: m.message_id, allow_sending_without_reply: true });
        return null;
      };
      switch (cmd.cmd) {
        case 'start':
        case 'help':
          return sendPhoto(chatId, asset('banner.jpg'), HELP, { key: 'banner', name: 'gemsearch.jpg', type: 'image/jpeg' }).catch((e) => {
            log.error('[bot] banner', clean(e));
            return send(chatId, HELP);
          });
        case 'scan': {
          const mint = ca();
          return mint ? runScan(chatId, userId, mint, m.message_id) : need('scan');
        }
        case 'xray': {
          const mint = ca();
          return mint ? runXray(chatId, userId, mint, m.message_id) : need('xray');
        }
        case 'watch': {
          const mint = ca();
          return mint ? send(chatId, await addWatch(chatId, mint), { reply_to_message_id: m.message_id, allow_sending_without_reply: true }) : need('watch');
        }
        case 'unwatch': {
          const mint = ca();
          return mint ? send(chatId, await removeWatch(chatId, mint), { reply_to_message_id: m.message_id, allow_sending_without_reply: true }) : need('unwatch');
        }
        case 'watches':
          return send(chatId, listWatches(chatId));
        case 'launch':
          return send(chatId, LAUNCH_TEXT);
        case 'radar':
          return onRadar(chatId, cmd.arg);
        case 'roast': {
          const mint = ca();
          return mint ? runRoast(chatId, userId, mint, m.message_id) : need('roast');
        }
        case 'council': {
          const mint = ca();
          return mint ? runCouncil(chatId, userId, mint, m.message_id) : need('council');
        }
        case 'feed':
          return onFeed(chatId, cmd.arg, m.message_id);
        case 'track':
        case 'untrack':
        case 'tracks':
          return onTrack(chatId, cmd.cmd, cmd.arg, m.message_id);
        case 'token':
          return sendPhoto(chatId, asset('avatar.jpg'), TOKEN_TEXT, { key: 'avatar', name: 'gemsearch.jpg', type: 'image/jpeg' }).catch((e) => {
            log.error('[bot] avatar', clean(e));
            return send(chatId, TOKEN_TEXT);
          });
        default:
          return priv ? send(chatId, '🕷️ I do not know that one. /help lists what I can do.') : null;
      }
    }
    // Plain text: any address in a private chat; in groups only when someone mentions or answers the bot.
    const mentioned = me && (text.toLowerCase().includes(`@${me.username.toLowerCase()}`) || m.reply_to_message?.from?.id === me.id);
    if (!priv && !mentioned) return;
    const mint = extractCA(text) ?? (priv ? null : replyCA());
    if (mint) {
      // "@gemsearchfunbot council" / "roast" / "xray" in reply to a message with an address, or with the address.
      const words = text.toLowerCase();
      if (/\bcouncil\b|\bdebate\b/.test(words)) return runCouncil(chatId, userId, mint, m.message_id);
      if (/\broast\b/.test(words)) return runRoast(chatId, userId, mint, m.message_id);
      if (/x-?ray\b/.test(words)) return runXray(chatId, userId, mint, m.message_id);
      return runScan(chatId, userId, mint, m.message_id);
    }
    if (priv) return send(chatId, '🕷️ Send me a Solana contract address and I will scan it. /help for everything else.');
  }

  async function onCallback(q) {
    const [kind, mint] = String(q.data ?? '').split(':');
    const chatId = q.message?.chat?.id;
    if (!chatId || !isAddress(mint)) return tg('answerCallbackQuery', { callback_query_id: q.id });
    if (kind === 'x') {
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'X-raying…' }).catch(() => {});
      return runXray(chatId, q.from.id, mint, q.message.message_id);
    }
    if (kind === 'r') {
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Heating the grill…' }).catch(() => {});
      return runRoast(chatId, q.from.id, mint, q.message.message_id);
    }
    if (kind === 'c') {
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Convening the council…' }).catch(() => {});
      return runCouncil(chatId, q.from.id, mint, q.message.message_id);
    }
    if (kind === 'w') {
      const text = await addWatch(chatId, mint);
      const plain = text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      return tg('answerCallbackQuery', { callback_query_id: q.id, text: plain.slice(0, 190), show_alert: plain.length > 60 });
    }
    return tg('answerCallbackQuery', { callback_query_id: q.id });
  }

  async function handle(u) {
    try {
      if (u.message) await onMessage(u.message);
      else if (u.callback_query) await onCallback(u.callback_query);
    } catch (e) {
      log.error('[bot] update', u.update_id, clean(e));
    }
  }

  async function setup() {
    await mkdir(dataDir, { recursive: true }).catch(() => {});
    state = await loadJson(statePath, { offset: 0 });
    watches = await loadJson(watchPath, {});
    me = await tg('getMe');
    await tg('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
    await tg('setMyCommands', {
      commands: [
        { command: 'scan', description: 'Safety scan of a coin: /scan <CA>' },
        { command: 'xray', description: 'Web X-ray: bundles and linked wallets' },
        { command: 'watch', description: 'Alert me when a coin changes' },
        { command: 'unwatch', description: 'Stop watching a coin' },
        { command: 'watches', description: 'Coins watched in this chat' },
        { command: 'council', description: 'Grok Council: four Grok minds debate a coin' },
        { command: 'roast', description: 'Grok roasts a coin from its on-chain facts' },
        { command: 'feed', description: 'Clean Launch Feed: new pump.fun launches that pass your filters' },
        { command: 'track', description: 'Follow X accounts: their posts land here' },
        { command: 'tracks', description: 'X accounts tracked in this chat' },
        { command: 'launch', description: 'Launch a pump.fun coin from your wallet' },
        { command: 'token', description: '$GEMSEARCH contract address' },
        { command: 'help', description: 'What the spider can do' },
      ],
    }).catch((e) => log.error('[bot] setMyCommands', clean(e)));
    await tg('setMyDescription', { description: '🕷️ Gem Search — the rainbow spider for the X feed. Send a Solana contract address: I check mint and freeze authority, holders, the dev wallet, liquidity and the Dex profile, X-ray bundles and linked wallets, and watch coins for you. Open source · gemsearch.fun. Not financial advice.' }).catch((e) => log.error('[bot] setMyDescription', clean(e)));
    await tg('setMyShortDescription', { short_description: '🕷️ Scan any Solana coin: score, holders, dev, bundles. gemsearch.fun' }).catch((e) => log.error('[bot] setMyShortDescription', clean(e)));
    log.log(`[bot] @${me.username} up, offset ${state.offset}, ${Object.keys(watches).length} chats watching`);
  }

  async function poll() {
    for (;;) {
      try {
        const updates = await tg('getUpdates', { offset: state.offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }, 1);
        if (updates.length) {
          state.offset = updates[updates.length - 1].update_id + 1;
          await saveJson(statePath, state).catch((e) => log.error('[bot] state', clean(e)));
          for (const u of updates) handle(u); // not awaited: a slow X-ray must not hold up everyone else
        }
      } catch (e) {
        log.error('[bot] poll', clean(e));
        await sleep(e.code === 409 ? 10_000 : 3_000);
      }
    }
  }

  async function start() {
    for (;;) {
      try {
        await setup();
        break;
      } catch (e) {
        log.error('[bot] setup', clean(e));
        await sleep(10_000);
      }
    }
    setInterval(watchPass, WATCH_EVERY_MS).unref?.();
    setInterval(() => feedPass().catch((e) => log.error('[feed]', clean(e))), 20_000).unref?.();
    if (radar) await radar.start().then(() => log.log('[bot] radar ready'), (e) => log.error('[bot] radar', clean(e)));
    log.log('[bot] polling');
    await poll();
  }

  return { start, tg, scan, xray, watchPass, diffSnapshots };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const rpc = process.env.SOLANA_RPC_URL;
  if (!token || !rpc) {
    console.error('TELEGRAM_BOT_TOKEN and SOLANA_RPC_URL are required');
    process.exit(1);
  }
  process.on('unhandledRejection', (e) => console.error('[bot] unhandled', String(e?.stack ?? e).split(token).join('<token>')));
  const radar = process.env.X_BEARER_TOKEN && process.env.RADAR_CODE
    ? { bearer: process.env.X_BEARER_TOKEN, code: process.env.RADAR_CODE, budgetUsd: Number(process.env.RADAR_BUDGET_USD ?? 9), minFollowers: Number(process.env.RADAR_MIN_FOLLOWERS ?? 1000), intervalMs: Number(process.env.RADAR_EVERY_S ?? 180) * 1000 }
    : null;
  createBot({ token, rpc, dataDir: process.env.BOT_DATA_DIR ?? '/data', radar, xaiKey: process.env.XAI_API_KEY ?? null }).start();
}
