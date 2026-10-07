/**
 * The council's track record: every verdict is stored with the coin's market cap at that moment, and checked an hour
 * and a day later against DexScreener. A seat counts as right when its vote matches what the coin did over 24 hours:
 * down 30% or more → AVOID was right, up 30% or more → APE was right, anything between → WATCH was right.
 * Coins DexScreener no longer lists are recorded as worth 0.
 */
export const BAND = 0.3;

export function initRecord(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS verdicts (id INTEGER PRIMARY KEY, mint TEXT, symbol TEXT, t INTEGER, verdict TEXT, votes TEXT, mc0 REAL, mc1h REAL, mc24h REAL, source TEXT);
    CREATE INDEX IF NOT EXISTS verdicts_mint ON verdicts(mint, t);`);
}

/** Stores a verdict, at most one per coin every 6 hours, and only when the coin had a market cap to measure from. */
export function recordVerdict(db, d, facts, source) {
  const mc0 = facts?.market?.marketCap ?? null;
  if (!mc0) return false;
  const recent = db.prepare('SELECT 1 FROM verdicts WHERE mint = ? AND t > ?').get(d.mint, Date.now() - 6 * 3_600_000);
  if (recent) return false;
  db.prepare('INSERT INTO verdicts (mint, symbol, t, verdict, votes, mc0, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(d.mint, facts.coin?.symbol ?? null, Date.now(), d.verdict, JSON.stringify(d.votes.map((v) => [v.seat, v.vote])), mc0, source);
  return true;
}

export async function checkVerdicts(db, now = Date.now()) {
  for (const [col, age] of [['mc1h', 3_600_000], ['mc24h', 86_400_000]]) {
    const due = db.prepare(`SELECT DISTINCT mint FROM verdicts WHERE ${col} IS NULL AND t < ? LIMIT 30`).all(now - age).map((r) => r.mint);
    if (!due.length) continue;
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${due.join(',')}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const pairs = res?.ok ? await res.json().catch(() => null) : null;
    if (!Array.isArray(pairs)) continue;
    const mc = new Map();
    for (const p of pairs) { const m = p.baseToken?.address, v = p.marketCap ?? p.fdv ?? 0; if (m && v > (mc.get(m) ?? -1)) mc.set(m, v); }
    const up = db.prepare(`UPDATE verdicts SET ${col} = ? WHERE mint = ? AND ${col} IS NULL AND t < ?`);
    for (const m of due) up.run(mc.get(m) ?? 0, m, now - age);
  }
}

export const outcomeOf = (mc0, mc) => (mc <= mc0 * (1 - BAND) ? 'AVOID' : mc >= mc0 * (1 + BAND) ? 'APE' : 'WATCH');

export function trackRecord(db) {
  const all = db.prepare('SELECT * FROM verdicts ORDER BY t DESC').all();
  const judged = all.filter((r) => r.mc24h !== null && r.mc0 > 0);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const change = (r) => Math.round(((r.mc24h - r.mc0) / r.mc0) * 1000) / 10;
  const byVerdict = {};
  for (const v of ['APE', 'WATCH', 'AVOID']) {
    const rows = judged.filter((r) => r.verdict === v);
    const ch = rows.map(change).sort((a, b) => a - b);
    byVerdict[v] = { n: rows.length, right: pct(rows.filter((r) => outcomeOf(r.mc0, r.mc24h) === v).length, rows.length), medianChange24h: ch.length ? ch[Math.floor(ch.length / 2)] : null, down50: pct(rows.filter((r) => r.mc24h <= r.mc0 * 0.5).length, rows.length) };
  }
  const seats = {};
  for (const r of judged) {
    const truth = outcomeOf(r.mc0, r.mc24h);
    for (const [seat, vote] of JSON.parse(r.votes)) { seats[seat] ??= { n: 0, right: 0 }; seats[seat].n++; if (vote === truth) seats[seat].right++; }
  }
  for (const s of Object.values(seats)) s.pct = pct(s.right, s.n);
  const council = { n: judged.length, right: pct(judged.filter((r) => outcomeOf(r.mc0, r.mc24h) === r.verdict).length, judged.length) };
  const rows = judged.map((r) => ({ mint: r.mint, symbol: r.symbol, verdict: r.verdict, change24h: change(r), right: outcomeOf(r.mc0, r.mc24h) === r.verdict, t: r.t }));
  return {
    total: all.length, judged: judged.length, pending: all.length - judged.length, band: BAND * 100, council, byVerdict, seats,
    bestCalls: rows.filter((r) => r.right).sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h)).slice(0, 5),
    worstCalls: rows.filter((r) => !r.right).sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h)).slice(0, 5),
    recent: all.slice(0, 15).map((r) => ({ mint: r.mint, symbol: r.symbol, verdict: r.verdict, t: r.t, change1h: r.mc1h === null ? null : Math.round(((r.mc1h - r.mc0) / r.mc0) * 1000) / 10, change24h: r.mc24h === null ? null : change(r) })),
    since: all.length ? all[all.length - 1].t : null,
  };
}
