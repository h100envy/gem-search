import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCA, isAddress, esc, formatScan, formatXray, scanKeyboard, snapshot, diffSnapshots, xrayVerdict, parseCommand, bar, money, age, TOKEN_CA } from '../bot.mjs';

const sample = {
  mint: TOKEN_CA,
  name: 'Gem <Search> & co',
  symbol: 'GEMSEARCH',
  pump: true,
  graduated: false,
  progress: 42.5,
  market: { dex: 'pumpfun', marketCap: 123456, liquidityUsd: 23000, volume24h: 4567, ageHours: 30, url: 'https://dexscreener.com/solana/x' },
  score: 85,
  unknown: 1,
  checks: [
    { id: 'mint', label: 'Mint authority', status: 'pass', detail: 'Revoked: supply is fixed' },
    { id: 'holders', label: 'Top 10 holders', status: 'warn', detail: '31.2% of supply, not counting the curve or pool' },
    { id: 'dev', label: 'Dev wallet', status: 'pass', detail: 'Dev holds 3.5%' },
    { id: 'history', label: 'Dev history', status: 'unknown', detail: 'Could not read earlier launches' },
    { id: 'stage', label: 'Stage', status: 'info', detail: 'On the pump.fun curve, 42.5% to graduation' },
    { id: 'dex', label: 'DexScreener profile', status: 'pass', detail: 'Paid and approved' },
    { id: 'freeze', label: 'Freeze authority', status: 'fail', detail: 'Active: holders can be <frozen>' },
  ],
};

test('extracts a contract address from text and links', () => {
  assert.equal(extractCA(`look at ${TOKEN_CA} now`), TOKEN_CA);
  assert.equal(extractCA(`https://pump.fun/coin/${TOKEN_CA}`), TOKEN_CA);
  assert.equal(extractCA('So11111111111111111111111111111111111111112'), 'So11111111111111111111111111111111111111112');
  assert.equal(extractCA('hello world'), null);
  assert.equal(extractCA('0OIl' + 'a'.repeat(40)), null);
  assert.equal(isAddress('abc'), false);
  assert.equal(isAddress(TOKEN_CA), true);
});

test('escapes HTML', () => {
  assert.equal(esc('<b>"a" & b</b>'), '&lt;b&gt;&quot;a&quot; &amp; b&lt;/b&gt;');
  assert.equal(esc(null), '');
});

test('parses commands for this bot only', () => {
  assert.deepEqual(parseCommand('/scan@GemBot  abc ', 'gembot'), { cmd: 'scan', arg: 'abc' });
  assert.deepEqual(parseCommand('/help', 'gembot'), { cmd: 'help', arg: '' });
  assert.equal(parseCommand('/scan@OtherBot abc', 'gembot'), null);
  assert.equal(parseCommand('hi', 'gembot'), null);
});

test('small formatters', () => {
  assert.equal(bar(85), '🟩'.repeat(9) + '⬜');
  assert.equal(bar(20), '🟥🟥' + '⬜'.repeat(8));
  assert.equal(money(1234567), '$1.23M');
  assert.equal(money(null), '—');
  assert.equal(age(0.2), '12m');
  assert.equal(age(72), '3d');
});

test('formats a scan', () => {
  const t = formatScan(sample);
  assert.match(t, /Gem &lt;Search&gt; &amp; co <b>\$GEMSEARCH<\/b>/);
  assert.match(t, /Score 85\/100/);
  assert.match(t, /on curve 42.5%/);
  assert.match(t, /DEX PAID/);
  assert.match(t, /MC \$123.5K · Liq \$23.0K · Vol 24h \$4.6K · Age 30h/);
  assert.match(t, /✅ <b>Mint authority<\/b>/);
  assert.match(t, /⚠️ <b>Top 10 holders<\/b>/);
  assert.match(t, /❔ <b>Dev history<\/b>/);
  assert.match(t, /ℹ️ <b>Stage<\/b>/);
  assert.match(t, /❌ <b>Freeze authority<\/b>: Active: holders can be &lt;frozen&gt;/);
  assert.match(t, /Not financial advice/);
  assert.ok(!/<frozen>/.test(t));
  const kb = scanKeyboard(sample).inline_keyboard.flat().map((b) => b.text);
  assert.deepEqual(kb, ['🕸️ X-ray', '🔎 Full scan', 'pump.fun', 'DexScreener', '👁 Watch']);
  assert.ok(scanKeyboard(sample).inline_keyboard.flat().every((b) => !b.callback_data || Buffer.byteLength(b.callback_data) <= 64));
});

test('formats an X-ray and its verdict', () => {
  const x = {
    mint: TOKEN_CA, dev: 'Dev1111111111111111111111111111111111111111', launch: { signature: 'sig', at: '2026-10-01T10:00:00.000Z' }, poolPct: 60,
    bundle: { sameBlockWallets: 4, sameBlockBoughtPct: 12, launchWindowWallets: 6, launchWindowBoughtPct: 15, launchBuyersHoldNowPct: 8, windowSeconds: 5 },
    clusters: [{ size: 4, holdsPct: 8, reasons: ['4 bought in the launch block'], wallets: [], funders: [] }],
  };
  const t = formatXray(x, sample);
  assert.match(t, /🚨 <b>Bundle<\/b>/);
  assert.match(t, /solscan.io\/tx\/sig/);
  assert.match(t, /4 wallets hold 8% — 4 bought in the launch block/);
  assert.match(xrayVerdict({ ...x, bundle: { ...x.bundle, launchBuyersHoldNowPct: 1 }, clusters: [{ size: 3, holdsPct: 14 }] }), /Linked wallets hold 14%/);
  assert.match(xrayVerdict({ ...x, bundle: null, clusters: [] }), /No linked wallets found/);
});

test('diffs snapshots into alerts', () => {
  const a = snapshot(sample);
  assert.equal(a.devShare, 3.5);
  assert.equal(a.top10, 31.2);
  assert.equal(a.dexPaid, true);
  assert.deepEqual(diffSnapshots(a, snapshot(sample)).alerts, []);

  const worse = structuredClone(sample);
  worse.score = 60;
  worse.graduated = true;
  worse.market.liquidityUsd = 10000;
  worse.checks.find((c) => c.id === 'dev').detail = 'Dev holds 0.5%';
  worse.checks.find((c) => c.id === 'holders').detail = '45% of supply, not counting the curve or pool';
  worse.checks.find((c) => c.id === 'holders').status = 'fail';
  const before = { ...a, dexPaid: false };
  const { alerts } = diffSnapshots(before, snapshot(worse));
  const all = alerts.join('\n');
  assert.match(all, /Score 85 → 60/);
  assert.match(all, /Top 10 holders: warn → fail/);
  assert.match(all, /Dev sold: 3.5% → 0.5%/);
  assert.match(all, /Liquidity \$23.0K → \$10.0K/);
  assert.match(all, /Graduated/);
  assert.match(all, /now paid/);
  assert.match(all, /Top 10 holders 31.2% → 45%/);

  // A slow slide adds up: small drops keep the old baseline until they cross the line.
  let snap = a;
  const step = structuredClone(sample);
  step.score = 79;
  ({ snap } = diffSnapshots(snap, snapshot(step)));
  assert.equal(snap.score, 85);
  step.score = 74;
  assert.match(diffSnapshots(snap, snapshot(step)).alerts.join(), /Score 85 → 74/);
});

// --- picture cards -------------------------------------------------------------------------------------------------
import { splitCaption, visibleLength, HELP, TOKEN_TEXT } from '../bot.mjs';
import { scanSvg, xraySvg, alertSvg, orderChecks, parseAlert, ellipsize, plain, measure } from '../bot/render.mjs';

const wellFormed = (svg) => {
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"[^>]*>[\s\S]*<\/svg>$/);
  // every opened element is closed: count opening vs closing/self-closing tags
  const tags = [...svg.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)];
  const stack = [];
  for (const [, close, name, self] of tags) {
    if (self) continue;
    if (close) assert.equal(stack.pop(), name);
    else stack.push(name);
  }
  assert.equal(stack.length, 0);
};

test('captions fit Telegram and split between lines', () => {
  assert.ok(visibleLength(HELP) <= 1024);
  assert.ok(visibleLength(TOKEN_TEXT) <= 1024);
  assert.equal(visibleLength('<b>a&amp;b</b>'), 3);
  const long = Array.from({ length: 60 }, (_, i) => `<b>line ${i}</b> ${'x'.repeat(20)}`).join('\n');
  const [cap, rest] = splitCaption(long);
  assert.ok(visibleLength(cap) <= 1024);
  assert.ok(rest.startsWith('<b>line'));
  assert.equal(cap.split('\n').length + rest.split('\n').length, 60);
  assert.deepEqual(splitCaption('short'), ['short', null]);
});

test('flags come first on the scan card', () => {
  const order = orderChecks(sample.checks).map((c) => c.status);
  assert.deepEqual(order, ['fail', 'warn', 'unknown', 'info', 'pass', 'pass', 'pass']);
  const many = { ...sample, checks: [...Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, label: `Pass ${i}`, status: 'pass', detail: 'ok' })), { id: 'bad', label: 'Bad thing', status: 'fail', detail: 'broken' }] };
  const svg = scanSvg(many);
  wellFormed(svg);
  assert.match(svg, /Bad thing/);
  assert.ok(svg.indexOf('Bad thing') < svg.indexOf('Pass 0'));
  assert.match(svg, /\+2 more on gemsearch.fun/);
});

test('scan card SVG', () => {
  const svg = scanSvg(sample, 'data:image/png;base64,AAAA');
  wellFormed(svg);
  assert.match(svg, />85<\/text>/);
  assert.match(svg, /GEM SEARCH · TOKEN SCAN/);
  assert.match(svg, /Gem &lt;Search&gt; &amp; co/);
  assert.match(svg, /\$GEMSEARCH/);
  assert.match(svg, /ON CURVE 42.5%/);
  assert.match(svg, /DEX PAID/);
  assert.match(svg, /\$123.5K/);
  assert.match(svg, /holders can be &lt;frozen&gt;/);
  assert.match(svg, /data:image\/png;base64,AAAA/);
  assert.match(svg, new RegExp(TOKEN_CA));
  wellFormed(scanSvg({ mint: TOKEN_CA, score: 0, checks: [] }));
});

test('X-ray card SVG', () => {
  const xr = {
    mint: TOKEN_CA, poolPct: 40, launch: { signature: 's' },
    bundle: { sameBlockWallets: 3, sameBlockBoughtPct: 12, launchWindowWallets: 4, launchWindowBoughtPct: 13, launchBuyersHoldNowPct: 9, windowSeconds: 5 },
    clusters: [{ wallets: ['a', 'b', 'c'], size: 3, holdsPct: 9, reasons: ['3 bought in the launch block'], funders: ['f'] }],
    nodes: [{ id: 'a', pct: 4, kind: 'dev', cluster: 0 }, { id: 'b', pct: 3, kind: 'bundle', cluster: 0 }, { id: 'c', pct: 2, kind: 'bundle', cluster: 0 }, { id: 'd', pct: 1, kind: 'holder', cluster: null }, { id: 'f', pct: 0, kind: 'funder', cluster: 0 }],
    edges: [{ from: 'f', to: 'b', kind: 'funded' }, { from: 'f', to: 'c', kind: 'funded' }],
  };
  const svg = xraySvg(xr, sample);
  wellFormed(svg);
  assert.match(svg, /BUNDLE/);
  assert.match(svg, /3 wallets/);
  assert.match(svg, />4%<\/text>/);
  assert.ok(!/>1%<\/text>/.test(svg)); // labels only from 1.5%
  assert.match(svg, /stroke-dasharray="7 6"/); // launch-block chain
  assert.match(svg, /#1fd2ff/);
  wellFormed(xraySvg({ mint: TOKEN_CA, poolPct: 0, bundle: null, clusters: [], nodes: [], edges: [] }));
  assert.match(xraySvg({ mint: TOKEN_CA, poolPct: 0, bundle: null, clusters: [], nodes: [], edges: [] }), /NO LINKED WALLETS/);
});

test('alert card SVG', () => {
  assert.deepEqual(parseAlert('📉 Score 85 → 60'), { level: 'fail', label: 'Score', from: '85', to: '60' });
  assert.deepEqual(parseAlert('❌ Top 10 holders: warn → fail'), { level: 'fail', label: 'Top 10 holders', from: 'warn', to: 'fail' });
  assert.equal(parseAlert('🎓 Graduated from the pump.fun curve').from, null);
  const svg = alertSvg(sample, ['📉 Score 85 → 60', '🎓 Graduated from the pump.fun curve']);
  wellFormed(svg);
  assert.match(svg, /WATCH ALERT/);
  assert.match(svg, />60<\/text>/);
  assert.match(svg, /Graduated from the pump.fun curve/);
  assert.ok(!/\p{Extended_Pictographic}/u.test(svg.replace(/→/g, '')));
});

test('text fitting', () => {
  assert.equal(plain('🚀 Moon  coin 🐸'), 'Moon coin');
  const e = ellipsize('A very long coin name that will not fit anywhere', 30, 200);
  assert.ok(e.endsWith('…'));
  assert.ok(measure(e, 30) <= 200);
});
