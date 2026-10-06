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
