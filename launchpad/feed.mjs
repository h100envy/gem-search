/**
 * Clean Launch Feed: every launch the Bundle Index checks is stored with what a trader looks at in the first minute:
 * buys in the launch block, the dev's own first buy, links in the metadata, how many coins the same dev launched in
 * the last 24 hours, and whether the dev or its funder already shows up in the spider's crew memory. The bot matches
 * each chat's filters against new rows and sends the launches that pass.
 */
export function initFeed(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS feed (id INTEGER PRIMARY KEY, mint TEXT UNIQUE, t INTEGER, name TEXT, symbol TEXT, creator TEXT, same_slot INTEGER, dev_buy_pct REAL, mc_sol REAL, twitter TEXT, website TEXT, telegram TEXT, image TEXT, dev_24h INTEGER, crew INTEGER);
    CREATE INDEX IF NOT EXISTS feed_creator ON feed(creator, t);`);
  const cols = db.prepare('PRAGMA table_info(feed)').all().map((c) => c.name);
  if (!cols.includes('clones')) db.exec('ALTER TABLE feed ADD COLUMN clones INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS feed_symbol ON feed(symbol COLLATE NOCASE, t)');
}

const httpsUrl = (v) => (typeof v === 'string' && /^https:\/\/[^\s]{3,200}$/.test(v.trim()) ? v.trim() : null);

/** Reads the coin's metadata JSON (image, links). IPFS gateways are slow: 6 seconds, then the coin goes in without. */
export async function metadata(uri) {
  if (!httpsUrl(uri)) return {};
  const res = await fetch(uri, { signal: AbortSignal.timeout(6_000) }).catch(() => null);
  const j = res?.ok ? await res.json().catch(() => null) : null;
  if (!j || typeof j !== 'object') return {};
  return { twitter: httpsUrl(j.twitter), website: httpsUrl(j.website), telegram: httpsUrl(j.telegram), image: httpsUrl(j.image) };
}

/** Whether the dev, or the wallet that funded it, already appears in recorded launch blocks. */
function crewHit(db, creator) {
  if (!creator) return 0;
  const asBuyer = db.prepare('SELECT COUNT(*) AS n FROM buys WHERE wallet = ?').get(creator).n;
  const funder = db.prepare('SELECT funder FROM funding WHERE wallet = ?').get(creator)?.funder;
  const viaFunder = funder ? db.prepare('SELECT COUNT(*) AS n FROM buys b JOIN funding f ON f.wallet = b.wallet WHERE f.funder = ?').get(funder).n : 0;
  return asBuyer + viaFunder;
}

export function addToFeed(db, coin, sameSlot, meta) {
  const dev24h = coin.creator ? db.prepare('SELECT COUNT(*) AS n FROM feed WHERE creator = ? AND t > ?').get(coin.creator, coin.t - 86_400_000).n : 0;
  const clones = db.prepare('SELECT COUNT(*) AS n FROM feed WHERE symbol = ? COLLATE NOCASE AND t > ?').get(coin.symbol, coin.t - 86_400_000).n;
  db.prepare(`INSERT OR IGNORE INTO feed (mint, t, name, symbol, creator, same_slot, dev_buy_pct, mc_sol, twitter, website, telegram, image, dev_24h, crew, clones)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(coin.mint, coin.t, coin.name, coin.symbol, coin.creator ?? null, sameSlot, coin.devBuyPct ?? null, coin.mcSol ?? null, meta.twitter ?? null, meta.website ?? null, meta.telegram ?? null, meta.image ?? null, dev24h, crewHit(db, coin.creator), clones);
}

export const DEFAULTS = { block: 0, dev: 5, links: 1, serial: 2, crew: 0, clones: 0 };
const KEYS = { block: 'max buys in the launch block', dev: 'max dev buy, % of supply', links: 'min links (X / site / Telegram)', serial: 'max coins this dev launched in 24h', crew: 'allow devs seen in crew memory (0 = no)', clones: 'max earlier coins with the same ticker in 24h' };

/** "/feed on dev=3 block=1" → filters; unknown keys and bad numbers are reported, not guessed. */
export function parseFilters(arg, base = DEFAULTS) {
  const f = { ...base }, bad = [];
  for (const part of String(arg ?? '').trim().split(/\s+/).filter(Boolean)) {
    const m = /^([a-z]+)=(\d+(?:\.\d+)?)$/i.exec(part);
    if (!m || !(m[1].toLowerCase() in KEYS)) { bad.push(part); continue; }
    f[m[1].toLowerCase()] = Number(m[2]);
  }
  return { filters: f, bad };
}

export const describe = (f) => Object.keys(KEYS).map((k) => `${k}=${f[k]} — ${KEYS[k]}`).join('\n');

export function passes(row, f) {
  const links = [row.twitter, row.website, row.telegram].filter(Boolean).length;
  return row.same_slot !== null && row.same_slot <= f.block && (row.dev_buy_pct ?? 0) <= f.dev && links >= f.links && (row.dev_24h ?? 0) + 1 <= f.serial && (f.crew >= 1 || !row.crew) && (row.clones ?? 0) <= (f.clones ?? Infinity);
}
