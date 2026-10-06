import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

/**
 * Picture cards for the bot, in the site's look: deep purple night, a rainbow bar top and bottom, purple cards.
 * Each builder returns an SVG string (pure, testable); render() turns one into a PNG with resvg. Fonts: DejaVu in the
 * container (apk font-dejavu); anything else on a laptop. Emoji never go into a card: no colour emoji font there.
 */

export const RAINBOW = ['#ff2e7e', '#ff8a1f', '#ffe81f', '#4dff6a', '#1fd2ff', '#5b6bff', '#b84dff'];
export const CL = ['#ff2e7e', '#1fffc0', '#ffe81f', '#5b6bff', '#ff8a1f', '#4dff6a', '#b84dff', '#1fd2ff', '#ff5ea8', '#a8ff3d', '#ffb86b', '#7af0ff'];
export const KIND = { dev: '#ff5ea8', bundle: '#ff8a1f', sniper: '#ffe81f', holder: '#b48cff', funder: '#1fd2ff' };
const SANS = "DejaVu Sans, Helvetica Neue, Arial, sans-serif";
const MONO = "DejaVu Sans Mono, Menlo, monospace";
const CARD = '#130f38';
const EDGE = '#2a2560';
const DIM = '#b9b0ff';
const STATUS = {
  fail: { color: '#ff5e8e', glyph: 'x' },
  warn: { color: '#ffe81f', glyph: '!' },
  unknown: { color: '#8f89b8', glyph: '?' },
  info: { color: '#1fd2ff', glyph: 'i' },
  pass: { color: '#4dff6a', glyph: 'v' },
};
const ORDER = { fail: 0, warn: 1, unknown: 2, info: 3, pass: 4 };

export const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (n) => Math.round(n * 10) / 10;
/** Card text: no emoji (no font for them), no control characters, single spaces. */
export const plain = (s) => String(s ?? '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();

/** Rough advance width of DejaVu Sans (bold) / Mono, good enough to ellipsize and wrap. */
export function measure(text, size, { bold = false, mono = false } = {}) {
  let w = 0;
  for (const ch of String(text)) {
    if (mono) w += 0.602;
    else if (' '.includes(ch)) w += 0.33;
    else if ('il.,:;\'|!ijtf()[]'.includes(ch)) w += 0.34;
    else if ('mwMW%@'.includes(ch)) w += 0.98;
    else if (/[A-Z0-9$#&]/.test(ch)) w += 0.72;
    else if (/[a-z]/.test(ch)) w += 0.62;
    else w += 0.8;
  }
  return w * size * (bold && !mono ? 1.1 : 1);
}

export function ellipsize(text, size, max, opts) {
  const t = plain(text);
  if (measure(t, size, opts) <= max) return t;
  const chars = [...t];
  while (chars.length && measure(chars.join('') + '…', size, opts) > max) chars.pop();
  return chars.join('').trimEnd() + '…';
}

/** The largest size (down to min) at which the text fits, then ellipsized at that size. */
export function fit(text, max, size, min, opts) {
  let z = size;
  while (z > min && measure(plain(text), z, opts) > max) z -= 1;
  return { size: z, text: ellipsize(text, z, max, opts) };
}

export function wrap(text, size, max, lines = 3, opts) {
  const words = plain(text).split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (measure(next, size, opts) <= max || !cur) cur = next;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = ellipsize(`${kept[lines - 1]} ${out.slice(lines).join(' ')}`, size, max, opts);
    return kept;
  }
  return out.map((l) => ellipsize(l, size, max, opts));
}

const money = (v) => {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  const a = Math.abs(n);
  return a >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : a >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;
};
const age = (h) => (h === null || h === undefined ? '—' : h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-6)}` : '');

/** Flags first, so a card that has to cut checks never hides what went wrong. */
export function orderChecks(checks) {
  return (checks ?? []).map((c, i) => ({ c, i })).sort((a, b) => (ORDER[a.c.status] ?? 5) - (ORDER[b.c.status] ?? 5) || a.i - b.i).map(({ c }) => c);
}

function frame(w, h, inner, { extraDefs = '', glow = '50% 30%' } = {}) {
  const [gx, gy] = glow.split(' ');
  const stops = RAINBOW.map((c, i) => `<stop offset="${r1(i / (RAINBOW.length - 1))}" stop-color="${c}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<defs><radialGradient id="bg" cx="${gx}" cy="${gy}" r="85%"><stop offset="0" stop-color="#2b1170"/><stop offset="1" stop-color="#06041a"/></radialGradient>`
    + `<linearGradient id="rb" x1="0" y1="0" x2="1" y2="0">${stops}</linearGradient>`
    + `<linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#ff2e7e"/><stop offset=".35" stop-color="#ffe81f"/><stop offset=".65" stop-color="#4dff6a"/><stop offset="1" stop-color="#5b6bff"/></linearGradient>`
    + `<filter id="gl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>${extraDefs}</defs>`
    + `<rect width="${w}" height="${h}" fill="url(#bg)"/>${inner}`
    + `<rect width="${w}" height="6" fill="url(#rb)"/><rect y="${h - 6}" width="${w}" height="6" fill="url(#rb)"/></svg>`;
}

const text = (tx, ty, s, { size = 20, fill = '#fff', weight = 400, mono = false, anchor = 'start', spacing = 0, opacity = 1 } = {}) =>
  `<text x="${r1(tx)}" y="${r1(ty)}" font-family="${mono ? MONO : SANS}" font-size="${size}" font-weight="${weight}" fill="${fill}"${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${spacing ? ` letter-spacing="${spacing}"` : ''}${opacity !== 1 ? ` fill-opacity="${opacity}"` : ''}>${x(s)}</text>`;
const card = (cx, cy, w, h, { fill = CARD, stroke = EDGE, radius = 18, width = 2 } = {}) => `<rect x="${cx}" y="${cy}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${width}"/>`;

/** A round status badge drawn with shapes, not font glyphs. */
export function badge(cx, cy, status, rad = 15) {
  const st = STATUS[status] ?? STATUS.unknown;
  let g = `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="${st.color}" fill-opacity=".16" stroke="${st.color}" stroke-width="2.5"/>`;
  const k = rad / 15;
  if (st.glyph === 'v') g += `<path d="M${r1(cx - 7 * k)} ${r1(cy + 0.5 * k)}l${r1(4.5 * k)} ${r1(4.5 * k)}l${r1(9 * k)} ${r1(-10 * k)}" fill="none" stroke="${st.color}" stroke-width="${r1(3.4 * k)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  else if (st.glyph === 'x') g += `<path d="M${r1(cx - 5.5 * k)} ${r1(cy - 5.5 * k)}l${r1(11 * k)} ${r1(11 * k)}M${r1(cx + 5.5 * k)} ${r1(cy - 5.5 * k)}l${r1(-11 * k)} ${r1(11 * k)}" stroke="${st.color}" stroke-width="${r1(3.4 * k)}" stroke-linecap="round"/>`;
  else g += text(cx, cy + 7 * k, st.glyph, { size: r1(20 * k), weight: 700, fill: st.color, anchor: 'middle' });
  return g;
}

function spiderGlyph(cx, cy, size = 1) {
  const legs = [-62, -30, 30, 62].flatMap((d) => [d, 180 - d]).map((deg, i) => {
    const t = (deg * Math.PI) / 180;
    const kx = cx + Math.cos(t) * 26 * size, ky = cy + Math.sin(t) * 18 * size - 6 * size;
    const ex = cx + Math.cos(t) * 46 * size, ey = cy + Math.sin(t) * 40 * size + 10 * size;
    return `<path d="M${r1(cx)} ${r1(cy)}L${r1(kx)} ${r1(ky)}L${r1(ex)} ${r1(ey)}" fill="none" stroke="${RAINBOW[i % RAINBOW.length]}" stroke-width="${r1(4 * size)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  return `<g filter="url(#gl)">${legs}<circle cx="${r1(cx)}" cy="${r1(cy + 6 * size)}" r="${r1(15 * size)}" fill="#ff4fd8"/><circle cx="${r1(cx)}" cy="${r1(cy - 12 * size)}" r="${r1(9 * size)}" fill="#ffffff"/></g>`;
}

function coinAvatar(cx, cy, rad, image, id) {
  const clip = `<clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${rad - 4}"/></clipPath>`;
  const inner = image
    ? `<image href="${image}" xlink:href="${image}" x="${cx - rad + 4}" y="${cy - rad + 4}" width="${(rad - 4) * 2}" height="${(rad - 4) * 2}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>`
    : spiderGlyph(cx, cy, rad / 64);
  return { defs: clip, svg: `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="#0a0822" stroke="url(#rg)" stroke-width="5"/>${inner}` };
}

function pill(px, py, label, color) {
  const w = measure(label, 17, { bold: true }) + 30;
  return { w, svg: `<rect x="${r1(px)}" y="${py}" width="${r1(w)}" height="34" rx="17" fill="${color}" fill-opacity=".14" stroke="${color}" stroke-width="2"/>${text(px + w / 2, py + 23, label, { size: 17, weight: 700, fill: color, anchor: 'middle' })}` };
}

// --- scan card -------------------------------------------------------------------------------------------------------

export function scanSvg(s, image = null) {
  const W = 1200, H = 675;
  let g = text(48, 52, 'GEM SEARCH · TOKEN SCAN', { size: 18, weight: 700, fill: DIM, spacing: 4 });
  g += `<rect x="48" y="64" width="120" height="4" rx="2" fill="url(#rb)"/>`;

  // coin
  const av = coinAvatar(108, 148, 58, image, 'ci');
  g += av.svg;
  const nm = fit(s.name ?? 'Unknown coin', 266, 32, 22, { bold: true });
  g += text(184, 140, nm.text, { size: nm.size, weight: 700 });
  if (s.symbol) g += text(184, 176, ellipsize(`$${s.symbol}`, 24, 266, { mono: true }), { size: 24, weight: 700, fill: '#ffe81f', mono: true });

  // score ring
  const cx = 230, cy = 365, R = 104, L = 2 * Math.PI * R;
  const score = Math.max(0, Math.min(100, Number(s.score) || 0));
  g += `<circle cx="${cx}" cy="${cy}" r="${R + 34}" fill="#ff4fd8" fill-opacity=".06"/>`;
  g += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#1d1850" stroke-width="20"/>`;
  g += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="url(#rg)" stroke-width="20" stroke-linecap="round" stroke-dasharray="${r1((L * score) / 100)} ${r1(L)}" transform="rotate(-90 ${cx} ${cy})" filter="url(#gl)"/>`;
  g += text(cx, cy + 22, String(score), { size: 72, weight: 700, anchor: 'middle' });
  g += text(cx, cy + 56, '/ 100', { size: 20, fill: DIM, anchor: 'middle', mono: true });

  // tags
  const tags = [];
  if (s.pump) tags.push(s.graduated ? ['GRADUATED', '#4dff6a'] : [`ON CURVE${s.progress !== null && s.progress !== undefined ? ` ${s.progress}%` : ''}`, '#ffe81f']);
  if ((s.checks ?? []).some((c) => c.id === 'dex' && c.status === 'pass')) tags.push(['DEX PAID', '#1fd2ff']);
  if (s.unknown) tags.push([`${s.unknown} UNKNOWN`, '#8f89b8']);
  const pills = tags.map(([l, c]) => pill(0, 0, l, c));
  const total = pills.reduce((a, p) => a + p.w, 0) + 10 * Math.max(0, pills.length - 1);
  let px = Math.max(24, cx - total / 2);
  for (const [i, [l, c]] of tags.entries()) {
    const p = pill(px, 500, l, c);
    g += p.svg;
    px += pills[i].w + 10;
  }

  // checks
  const all = orderChecks(s.checks);
  const shown = all.slice(0, 8);
  const top = 86, left = 470, cw = 682, row = 52;
  const ch = Math.max(row * shown.length + 24, 120);
  g += card(left, top, cw, ch);
  shown.forEach((c, i) => {
    const y = top + 12 + row * i + row / 2;
    if (i) g += `<line x1="${left + 20}" y1="${top + 12 + row * i}" x2="${left + cw - 20}" y2="${top + 12 + row * i}" stroke="${EDGE}" stroke-width="1"/>`;
    g += badge(left + 36, y, c.status, 14);
    const lb = fit(c.label, 228, 19, 15, { bold: true });
    g += text(left + 64, y + 7, lb.text, { size: lb.size, weight: 700 });
    g += text(left + 300, y + 7, ellipsize(c.detail, 17, cw - 300 - 20), { size: 17, fill: c.status === 'fail' ? '#ff9fb9' : c.status === 'warn' ? '#fff3a0' : DIM });
  });
  if (!shown.length) g += text(left + cw / 2, top + 66, 'No checks', { size: 20, fill: DIM, anchor: 'middle' });
  if (all.length > shown.length) g += text(left + cw - 16, top + ch + 24, `+${all.length - shown.length} more on gemsearch.fun`, { size: 15, fill: DIM, anchor: 'end' });

  // market row
  const m = s.market;
  const cells = [['MARKET CAP', money(m?.marketCap)], ['LIQUIDITY', money(m?.liquidityUsd)], ['VOLUME 24H', money(m?.volume24h)], ['AGE', age(m?.ageHours)]];
  const mw = (W - 96 - 3 * 16) / 4;
  cells.forEach(([k, v], i) => {
    const mx = 48 + i * (mw + 16);
    g += card(mx, 560, mw, 72, { radius: 14 });
    g += text(mx + 20, 588, k, { size: 14, weight: 700, fill: DIM, spacing: 2 });
    g += text(mx + 20, 620, v, { size: 26, weight: 700, mono: true });
  });

  g += text(48, 658, s.mint ?? '', { size: 14, mono: true, fill: DIM, opacity: 0.8 });
  g += text(W - 48, 658, 'gemsearch.fun/scan', { size: 16, weight: 700, anchor: 'end', fill: '#fff' });
  return frame(W, H, g, { extraDefs: av.defs, glow: '20% 50%' });
}

// --- X-ray card ------------------------------------------------------------------------------------------------------

/** Positions of the web, the same way the site lays it out (function drawXray in scan.html). */
export function layoutXray(xr, C = 450) {
  const clusters = xr.clusters ?? [];
  const nodes = (xr.nodes ?? []).filter((n) => n.kind !== 'funder' || n.cluster !== null);
  const byId = new Map();
  const inCl = nodes.filter((n) => n.cluster !== null && n.kind !== 'funder');
  const loose = nodes.filter((n) => n.cluster === null);
  const total = inCl.length + loose.length || 1;
  let a = -Math.PI / 2;
  clusters.forEach((c, ci) => {
    const members = inCl.filter((n) => n.cluster === ci);
    const span = Math.max(0.5, (members.length / total) * Math.PI * 2);
    members.forEach((n, i) => { const ang = a + (span * (i + 0.5)) / members.length; const rad = 250 + (i % 2) * 70; byId.set(n.id, { ...n, x: C + rad * Math.cos(ang), y: C + rad * Math.sin(ang) }); });
    nodes.filter((n) => n.kind === 'funder' && n.cluster === ci).forEach((n, i) => { const ang = a + span / 2 + i * 0.12; byId.set(n.id, { ...n, x: C + 150 * Math.cos(ang), y: C + 150 * Math.sin(ang) }); });
    a += span;
  });
  const rest = Math.PI * 2 - (a + Math.PI / 2);
  loose.forEach((n, i) => { const ang = a + (rest * (i + 0.5)) / loose.length; const rad = 330 + (i % 3) * 30; byId.set(n.id, { ...n, x: C + rad * Math.cos(ang), y: C + rad * Math.sin(ang) }); });
  const pairs = new Map();
  for (const e of xr.edges ?? []) { const k = [e.from, e.to].sort().join('|') + e.kind; if (!pairs.has(k)) pairs.set(k, e); }
  const block = nodes.filter((n) => (n.kind === 'dev' || n.kind === 'bundle') && xr.bundle && xr.bundle.sameBlockWallets >= 2);
  for (let i = 1; i < block.length; i++) pairs.set(`blk${i}`, { from: block[i - 1].id, to: block[i].id, kind: 'block' });
  return { byId, edges: [...pairs.values()] };
}

export function xrayVerdictCard(xr) {
  const b = xr.bundle;
  const topc = xr.clusters?.[0];
  if (b && (b.sameBlockWallets >= 3 || b.sameBlockBoughtPct >= 10) && b.launchBuyersHoldNowPct > 5) return { level: 'fail', title: 'BUNDLE', body: `${b.sameBlockWallets} wallets bought ${b.sameBlockBoughtPct}% in the launch block; launch buyers still hold ${b.launchBuyersHoldNowPct}%.` };
  if (topc && topc.holdsPct > 10) return { level: 'warn', title: `LINKED WALLETS HOLD ${topc.holdsPct}%`, body: `${topc.size} wallets in one cluster.` };
  if (!xr.clusters?.length) return { level: 'pass', title: 'NO LINKED WALLETS', body: 'None of the top holders or launch buyers share a funder or sent to each other.' };
  return { level: 'pass', title: 'NO BIG CLUSTER', body: `The largest linked group holds ${topc.holdsPct}%.` };
}

export function xraySvg(xr, s = null, image = null) {
  const W = 1200, H = 900, C = 450;
  const { byId, edges } = layoutXray(xr, C);
  let g = '';
  // the web
  let w = '';
  for (let i = 0; i < 24; i++) { const t = (i / 24) * Math.PI * 2; w += `<line x1="${C}" y1="${C}" x2="${r1(C + 440 * Math.cos(t))}" y2="${r1(C + 440 * Math.sin(t))}"/>`; }
  for (const rr of [110, 190, 270, 350, 430]) {
    let d = '';
    for (let i = 0; i <= 23; i++) {
      const t0 = (i / 24) * Math.PI * 2, t1 = ((i + 1) / 24) * Math.PI * 2, tm = (t0 + t1) / 2;
      d += (i ? '' : `M${r1(C + rr * Math.cos(t0))} ${r1(C + rr * Math.sin(t0))}`) + `Q${r1(C + rr * 0.92 * Math.cos(tm))} ${r1(C + rr * 0.92 * Math.sin(tm))} ${r1(C + rr * Math.cos(t1))} ${r1(C + rr * Math.sin(t1))}`;
    }
    w += `<path d="${d}"/>`;
  }
  g += `<g stroke="#8a7bff" stroke-opacity=".18" stroke-width="1.3" fill="none">${w}</g>`;
  for (const n of byId.values()) if (n.kind !== 'funder') g += `<line x1="${C}" y1="${C}" x2="${r1(n.x)}" y2="${r1(n.y)}" stroke="#ffffff" stroke-opacity=".06"/>`;
  // threads
  for (const e of edges) {
    const p = byId.get(e.from), q = byId.get(e.to);
    if (!p || !q) continue;
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, qx = mx + (C - mx) * 0.25, qy = my + (C - my) * 0.25;
    const col = e.kind === 'funded' ? '#1fd2ff' : e.kind === 'coins' ? '#ffe81f' : e.kind === 'block' ? '#ff8a1f' : '#4dff6a';
    g += `<path d="M${r1(p.x)} ${r1(p.y)}Q${r1(qx)} ${r1(qy)} ${r1(q.x)} ${r1(q.y)}" fill="none" stroke="${col}" stroke-width="2.4" stroke-opacity=".8"${e.kind === 'block' ? ' stroke-dasharray="7 6"' : ''}/>`;
  }
  // cluster halos
  (xr.clusters ?? []).forEach((c, ci) => (c.wallets ?? []).forEach((wid) => {
    const n = byId.get(wid);
    if (n && n.kind !== 'funder') g += `<circle cx="${r1(n.x)}" cy="${r1(n.y)}" r="${r1(Math.max(9, 5 + Math.sqrt(n.pct) * 7) + 7)}" fill="none" stroke="${CL[ci % CL.length]}" stroke-width="2.5" stroke-dasharray="4 4"/>`;
  }));
  // nodes
  let labels = '';
  for (const n of byId.values()) {
    const rad = n.kind === 'funder' ? 8 : Math.max(7, 5 + Math.sqrt(n.pct || 0) * 7);
    const col = KIND[n.kind] ?? '#b48cff';
    g += n.kind === 'funder'
      ? `<rect x="${r1(n.x - rad)}" y="${r1(n.y - rad)}" width="${rad * 2}" height="${rad * 2}" transform="rotate(45 ${r1(n.x)} ${r1(n.y)})" fill="${col}" filter="url(#gl)"/>`
      : `<circle cx="${r1(n.x)}" cy="${r1(n.y)}" r="${r1(rad)}" fill="${col}" fill-opacity=".92" stroke="#fff" stroke-opacity=".6" stroke-width="1.5" filter="url(#gl)"/>`;
    if (n.pct >= 1.5) labels += text(n.x, n.y + rad + 17, `${n.pct}%`, { size: 14, mono: true, fill: '#e9e5ff', anchor: 'middle', weight: 700 });
  }
  g += labels;
  // the coin
  g += `<circle cx="${C}" cy="${C}" r="110" fill="url(#cg)"/>`;
  const av = coinAvatar(C, C, 66, image, 'xc');
  g += av.svg;
  if (xr.poolPct) g += text(C, C + 96, `pool / curve ${xr.poolPct}%`, { size: 14, mono: true, fill: '#9fe9ff', anchor: 'middle' });

  // panel
  const P = 900, pw = 276;
  g += `<rect x="${P}" y="0" width="${W - P}" height="${H}" fill="#06041a" fill-opacity=".55"/><line x1="${P}" y1="0" x2="${P}" y2="${H}" stroke="${EDGE}" stroke-width="2"/>`;
  let y = 48;
  const px = P + 12;
  g += text(px, y, 'GEM SEARCH · WEB X-RAY', { size: 14, weight: 700, fill: DIM, spacing: 2 });
  y += 38;
  const nm = fit(s?.name ?? short(xr.mint), pw, 24, 16, { bold: true });
  g += text(px, y, nm.text, { size: nm.size, weight: 700 });
  if (s?.symbol) { y += 28; g += text(px, y, ellipsize(`$${s.symbol}`, 18, pw, { mono: true }), { size: 18, mono: true, weight: 700, fill: '#ffe81f' }); }
  y += 22;

  const v = xrayVerdictCard(xr);
  const vc = STATUS[v.level].color;
  const body = wrap(v.body, 15, pw - 32, 4);
  const vh = 62 + body.length * 20;
  g += card(px, y, pw, vh, { fill: vc, stroke: vc, radius: 14 }).replace(`fill="${vc}"`, `fill="${vc}" fill-opacity=".12"`);
  g += badge(px + 26, y + 30, v.level, 13);
  g += text(px + 48, y + 36, ellipsize(v.title, 17, pw - 60, { bold: true }), { size: 17, weight: 700, fill: vc });
  body.forEach((l, i) => { g += text(px + 16, y + 64 + i * 20, l, { size: 15, fill: '#ece8ff' }); });
  y += vh + 18;

  const b = xr.bundle;
  const facts = b
    ? [['Launch block', `${b.sameBlockWallets} wallets · ${b.sameBlockBoughtPct}%`], [`First ${b.windowSeconds}s`, `${b.launchWindowWallets} wallets · ${b.launchWindowBoughtPct}%`], ['Launch buyers hold', `${b.launchBuyersHoldNowPct}%`], ['Curve / pool', `${xr.poolPct ?? 0}%`]]
    : [['Launch', 'not reached'], ['Curve / pool', `${xr.poolPct ?? 0}%`]];
  g += card(px, y, pw, 18 + facts.length * 28, { radius: 14 });
  facts.forEach(([k, val], i) => {
    g += text(px + 14, y + 32 + i * 28, k, { size: 14, fill: DIM });
    g += text(px + pw - 14, y + 32 + i * 28, val, { size: 14, mono: true, weight: 700, anchor: 'end' });
  });
  y += 18 + facts.length * 28 + 26;

  const clusters = (xr.clusters ?? []).slice(0, 5);
  g += text(px, y, clusters.length ? 'LINKED CLUSTERS' : 'NO LINKED WALLETS', { size: 13, weight: 700, fill: DIM, spacing: 2 });
  y += 14;
  for (const [ci, c] of clusters.entries()) {
    const reasons = wrap((c.reasons ?? []).join(' · '), 13, pw - 28, 2);
    const ch = 40 + reasons.length * 17;
    if (y + ch > H - 100) break;
    g += card(px, y, pw, ch, { radius: 12 });
    g += `<circle cx="${px + 18}" cy="${y + 21}" r="7" fill="${CL[ci % CL.length]}"/>`;
    g += text(px + 34, y + 27, `${c.size} wallets`, { size: 16, weight: 700 });
    g += text(px + pw - 14, y + 27, `${c.holdsPct}%`, { size: 16, mono: true, weight: 700, anchor: 'end', fill: CL[ci % CL.length] });
    reasons.forEach((l, i) => { g += text(px + 14, y + 47 + i * 17, l, { size: 13, fill: DIM }); });
    y += ch + 8;
  }

  // legend
  const leg = [['dev', 'dev'], ['bundle', 'launch block'], ['sniper', 'first seconds'], ['holder', 'holder'], ['funder', 'shared funder']];
  let ly = H - 84;
  leg.forEach(([k, label], i) => {
    const lx = px + (i % 2) * 140, yy = ly + Math.floor(i / 2) * 22;
    g += k === 'funder' ? `<rect x="${lx}" y="${yy - 10}" width="10" height="10" transform="rotate(45 ${lx + 5} ${yy - 5})" fill="${KIND[k]}"/>` : `<circle cx="${lx + 5}" cy="${yy - 5}" r="6" fill="${KIND[k]}"/>`;
    g += text(lx + 18, yy, label, { size: 13, fill: DIM });
  });
  g += text(24, H - 22, 'gemsearch.fun/scan', { size: 16, weight: 700 });
  g += text(P - 24, H - 22, short(xr.mint), { size: 14, mono: true, fill: DIM, anchor: 'end' });
  return frame(W, H, g, { extraDefs: `<radialGradient id="cg"><stop stop-color="#ff4fd8" stop-opacity=".5"/><stop offset="1" stop-color="#ff4fd8" stop-opacity="0"/></radialGradient>${av.defs}`, glow: '38% 50%' });
}

// --- alert card ------------------------------------------------------------------------------------------------------

/** One alert line ("📉 Score 85 → 60") as a level plus the label, old and new values. */
export function parseAlert(line) {
  const t = plain(line);
  const level = /^(❌|📉|🔻|💧|🐋)/u.test(line) ? 'fail' : /^(🎓|💎)/u.test(line) ? 'pass' : 'warn';
  const m = /^(.*?)[:\s]\s*(\S+)\s*→\s*(.+)$/.exec(t);
  if (!m) return { level, label: t, from: null, to: null };
  const [, head, from, to] = m;
  return { level, label: head.trim(), from, to };
}

export function alertSvg(s, alerts, image = null) {
  const W = 1200, H = 630;
  let g = text(48, 52, 'GEM SEARCH · WATCH ALERT', { size: 18, weight: 700, fill: DIM, spacing: 4 });
  g += `<rect x="48" y="64" width="120" height="4" rx="2" fill="url(#rb)"/>`;
  const av = coinAvatar(1080, 92, 60, image, 'ai');
  g += av.svg;
  const nm = fit(s?.name ?? 'Watched coin', 900, 40, 28, { bold: true });
  g += text(48, 124, nm.text, { size: nm.size, weight: 700 });
  if (s?.symbol) g += text(48, 160, ellipsize(`$${s.symbol}`, 24, 600, { mono: true }), { size: 24, mono: true, weight: 700, fill: '#ffe81f' });
  const rows = alerts.slice(0, 5).map(parseAlert);
  const rh = Math.min(72, Math.floor((H - 196 - 70) / Math.max(1, rows.length)) - 10);
  rows.forEach((a, i) => {
    const y = 196 + i * (rh + 10);
    const col = STATUS[a.level].color;
    g += card(48, y, W - 96, rh, { radius: 16 });
    g += `<rect x="48" y="${y}" width="8" height="${rh}" rx="4" fill="${col}"/>`;
    g += badge(92, y + rh / 2, a.level, 16);
    const mid = y + rh / 2 + 9;
    if (a.from !== null) {
      g += text(124, mid, ellipsize(a.label, 26, 520, { bold: true }), { size: 26, weight: 700 });
      const toW = measure(a.to, 28, { mono: true });
      g += text(W - 76, mid, a.to, { size: 28, mono: true, weight: 700, anchor: 'end', fill: col });
      g += text(W - 76 - toW - 14, mid, '→', { size: 28, anchor: 'end', fill: '#ff8a1f', weight: 700 });
      g += text(W - 76 - toW - 56, mid, a.from, { size: 28, mono: true, anchor: 'end', fill: DIM });
    } else g += text(124, mid, ellipsize(a.label, 26, W - 220, { bold: true }), { size: 26, weight: 700 });
  });
  if (alerts.length > rows.length) g += text(W - 48, H - 64, `+${alerts.length - rows.length} more`, { size: 16, fill: DIM, anchor: 'end' });
  g += text(48, H - 30, s?.mint ?? '', { size: 14, mono: true, fill: DIM });
  g += text(W - 48, H - 30, 'gemsearch.fun/scan', { size: 16, weight: 700, anchor: 'end' });
  return frame(W, H, g, { extraDefs: av.defs, glow: '85% 15%' });
}

// --- raster ----------------------------------------------------------------------------------------------------------

const FONT_DIRS = ['/usr/share/fonts'].filter((d) => existsSync(d));
let Resvg = null;
export function render(svg) {
  if (!Resvg) Resvg = createRequire(import.meta.url)('@resvg/resvg-js').Resvg;
  return new Resvg(svg, { font: { loadSystemFonts: true, fontDirs: FONT_DIRS, defaultFontFamily: 'DejaVu Sans', sansSerifFamily: 'DejaVu Sans', monospaceFamily: 'DejaVu Sans Mono' }, imageRendering: 0, shapeRendering: 2, textRendering: 1 }).render().asPng();
}

/** A coin image as a data URI (PNG, JPEG, GIF or WebP up to 3 MB), or null. */
export async function fetchImage(url, ms = 5_000) {
  if (!url || !/^https?:\/\//.test(url)) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'gemsearch-bot' } });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 3_000_000) return null;
    const type = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : buf.slice(0, 3).toString() === 'GIF' ? 'image/gif' : buf.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
    return type ? `data:${type};base64,${buf.toString('base64')}` : null;
  } catch {
    return null;
  }
}
