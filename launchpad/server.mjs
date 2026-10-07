import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import bs58 from 'bs58';
import { Connection, PublicKey } from '@solana/web3.js';
import { buildLaunch, checkSigned, LaunchError, parseLaunch } from './launch.mjs';
import { scanToken } from './scan.mjs';
import { xrayToken } from './xray.mjs';
import { crewFromLinks, crewOf, linksFromXray, openDb } from './crews.mjs';

/**
 * gemsearch.fun's launchpad API. The page makes the coin's mint key and the creator's wallet signs; this server only
 * stores the picture and metadata on IPFS, builds the pump.fun transaction, and sends it once both have signed it
 * unchanged. It holds no key, takes no fee, and keeps nothing but a public log of launches that went live.
 */
const env = (k, d) => process.env[k] ?? d;
const PORT = Number(env('PORT', 8790));
const RPC = env('SOLANA_RPC_URL', '');
const PINATA = env('PINATA_JWT', '');
const ORIGINS = env('ALLOWED_ORIGINS', 'https://gemsearch.fun,https://www.gemsearch.fun').split(',').map((s) => s.trim());
const LOG = env('LAUNCH_LOG', './data/launches.jsonl');
const PER_IP_HOUR = Number(env('LAUNCHES_PER_IP_HOUR', 6));
const PER_DAY = Number(env('LAUNCHES_PER_DAY', 150));
const PAUSED = env('LAUNCHPAD_PAUSED', '') === '1';
const TRUST_PROXY = env('TRUST_PROXY', '') === '1';
const GITHUB_TOKEN = env('GITHUB_TOKEN', '');
const SCANS_PER_IP_MINUTE = Number(env('SCANS_PER_IP_MINUTE', 20)); // optional: lifts GitHub's 60 lookups an hour
const TABLE = env('LAUNCH_TABLE', ''); // optional address lookup table: keeps the priority fee on launches with a dev buy
const BUILT_TTL = 150_000; // a blockhash lives ~60-90 s; a little longer covers a slow wallet prompt

if (!RPC || !PINATA) console.warn('launchpad: SOLANA_RPC_URL and PINATA_JWT are required for launches; serving status only');
const conn = RPC ? new Connection(RPC, 'confirmed') : null;
mkdirSync(dirname(LOG), { recursive: true });

// --- limits -------------------------------------------------------------------------------------------------------
const hits = new Map();
function limit(key, max, windowMs, message = 'too many launches from here right now; try again later') {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) throw new LaunchError(429, message);
  list.push(now);
  hits.set(key, list);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) if (!list.some((t) => now - t < 86_400_000)) hits.delete(k);
  for (const [k, b] of built) if (now - b.at > BUILT_TTL) built.delete(k);
}, 60_000).unref();

// --- IPFS -----------------------------------------------------------------------------------------------------------
async function pin(name, body, contentType) {
  const form = new FormData();
  form.append('network', 'public');
  form.append('file', new Blob([body], { type: contentType }), name);
  const res = await fetch('https://uploads.pinata.cloud/v3/files', { method: 'POST', headers: { authorization: `Bearer ${PINATA}` }, body: form, signal: AbortSignal.timeout(30_000) }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
  if (!res.ok) throw new LaunchError(502, `could not store the picture right now (${res.status}); try again`);
  const cid = (await res.json())?.data?.cid;
  if (!cid) throw new LaunchError(502, 'could not store the picture right now; try again');
  return `https://ipfs.io/ipfs/${cid}`;
}

// --- lookup table -----------------------------------------------------------------------------------------------
let table = { at: 0, account: null };
async function lookupTable() {
  if (!TABLE) return null;
  if (Date.now() - table.at < 600_000) return table.account;
  const account = (await conn.getAddressLookupTable(new PublicKey(TABLE)).catch(() => null))?.value ?? null;
  table = { at: Date.now(), account };
  return account;
}

// --- launches -------------------------------------------------------------------------------------------------------
/** Launches built and waiting for signatures, by id: the exact message, who must sign it, and the token. */
const built = new Map();

function recent(n = 24) {
  if (!existsSync(LOG)) return [];
  const lines = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-n).reverse().map((l) => JSON.parse(l));
}

/** A GitHub username to the numeric id pump.fun keys fees by; the name is checked here, not trusted from the page. */
async function githubAccount(login) {
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: { 'user-agent': 'gemsearch-launchpad', accept: 'application/vnd.github+json', ...(GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {}) },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (res?.status === 404) throw new LaunchError(400, `GitHub: there is no account called ${login}`);
  const json = res?.ok ? await res.json().catch(() => null) : null;
  if (!Number.isSafeInteger(json?.id)) throw new LaunchError(502, 'could not reach GitHub to look up that account; try again in a minute');
  return { id: json.id, login: json.login };
}

async function prepare(req, body) {
  if (PAUSED) throw new LaunchError(503, 'launches are paused for a moment');
  if (!conn || !PINATA) throw new LaunchError(503, 'launches are not switched on yet');
  const f = parseLaunch(body);
  const table = await lookupTable();
  if (f.github && !table) throw new LaunchError(503, 'sending fees to GitHub switches on shortly; launch without it for now');
  limit(`ip:${req.ip}`, PER_IP_HOUR, 3_600_000);
  limit('all', PER_DAY, 86_400_000);
  const github = f.github ? await githubAccount(f.github) : null;
  const ext = f.image.contentType.split('/')[1];
  const image = await pin(`${f.symbol}.${ext}`, f.image.bytes, f.image.contentType);
  const metadata = { name: f.name, symbol: f.symbol, description: f.description, image, showName: true, createdOn: 'https://gemsearch.fun', ...f.links };
  const uri = await pin(`${f.symbol}.json`, JSON.stringify(metadata), 'application/json');
  const share = github ? { githubId: github.id, bps: f.githubShare * 100 } : null;
  const b = await buildLaunch(conn, { creator: f.creator, mint: f.mint, meta: { name: f.name, symbol: f.symbol, uri }, devBuySol: f.devBuySol, table, share });
  const id = randomBytes(12).toString('hex');
  built.set(id, {
    at: Date.now(), message: b.message, pre: b.pre?.message ?? null, creator: f.creator.toBase58(), mint: f.mint.toBase58(), lastValidBlockHeight: b.lastValidBlockHeight,
    name: f.name, symbol: f.symbol, image, devBuySol: f.devBuySol, github: github && { login: github.login, share: f.githubShare },
  });
  return { id, tx: Buffer.from(b.tx.serialize()).toString('base64'), pre: b.pre ? Buffer.from(b.pre.tx.serialize()).toString('base64') : null, uri, image, github: github && { login: github.login, id: github.id } };
}

/** Sends a signed transaction; a refusal before broadcast comes back as a reason a person can act on. */
async function broadcast(tx) {
  try {
    await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
    return null;
  } catch (err) {
    // web3.js puts the reason on the lines after "Simulation failed."; read all of it.
    const full = String(err.message).replace(/\s+/g, ' ');
    const msg = (/Message: (.*?)(?: Logs:|$)/.exec(full)?.[1] ?? full).slice(0, 200);
    if (/already in use/i.test(full)) return 'exists';
    if (/blockhash not found/i.test(full)) throw new LaunchError(400, 'the signature took too long and the launch expired; start again');
    if (/insufficient|no record of a prior credit|0x1\b/i.test(full)) throw new LaunchError(400, 'not enough SOL in your wallet: a launch needs about 0.03 SOL plus the dev buy');
    if (/simulat|preflight|custom program error/i.test(full)) throw new LaunchError(400, `the network refused the launch: ${msg}`);
    return 'unsure';
  }
}

async function submit(body) {
  if (!conn) throw new LaunchError(503, 'launches are not switched on yet');
  const b = built.get(String(body?.id ?? ''));
  if (!b) throw new LaunchError(400, 'that launch expired; start again');
  const tx = checkSigned(String(body?.signed ?? ''), b);
  const pre = b.pre ? checkSigned(String(body?.signedPre ?? ''), { message: b.pre, creator: b.creator }) : null;
  built.delete(body.id);
  // The GitHub account's fee address goes first; if someone made it a moment ago, the launch still stands.
  if (pre) {
    const sent = await broadcast(pre);
    if (sent !== 'exists') {
      const r = await conn.confirmTransaction({ signature: bs58.encode(pre.signatures[0]), blockhash: pre.message.recentBlockhash, lastValidBlockHeight: b.lastValidBlockHeight }, 'confirmed').catch(() => null);
      if (!r || r.value.err) throw new LaunchError(400, 'setting up the GitHub fee address did not go through; nothing was launched, start again');
    }
  }
  const signature = bs58.encode(tx.signatures[0]);
  if ((await broadcast(tx)) === 'unsure') return { status: 'pending', signature, mint: b.mint };
  const res = await conn.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: b.lastValidBlockHeight }, 'confirmed').catch(() => null);
  if (res?.value?.err) throw new LaunchError(400, `the launch failed on chain: ${JSON.stringify(res.value.err).slice(0, 200)}`);
  if (!res) return { status: 'pending', signature, mint: b.mint };
  appendFileSync(LOG, JSON.stringify({ mint: b.mint, name: b.name, symbol: b.symbol, image: b.image, creator: b.creator, devBuySol: b.devBuySol, github: b.github, signature, at: new Date().toISOString() }) + '\n');
  return { status: 'live', signature, mint: b.mint };
}

// --- scanner ---------------------------------------------------------------------------------------------------------
/** Readings are kept a minute: a coin everyone is checking costs one read, not one per visitor. */
const scans = new Map();
async function scan(req, mint) {
  if (!conn) throw new LaunchError(503, 'the scanner is not switched on yet');
  const hit = scans.get(mint);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  limit(`scan:${req.ip}`, SCANS_PER_IP_MINUTE, 60_000, 'too many scans from here; wait a minute');
  const pending = hit?.pending ?? scanToken(conn, RPC, mint);
  scans.set(mint, { at: 0, pending });
  try {
    const value = await pending;
    scans.set(mint, { at: Date.now(), value });
    if (scans.size > 2000) scans.delete(scans.keys().next().value);
    return value;
  } catch (err) {
    scans.delete(mint);
    throw err;
  }
}

/** X-rays read a few dozen wallets each, so they are kept five minutes and rationed harder than scans. */
const xrays = new Map();
async function xray(req, mint) {
  if (!conn) throw new LaunchError(503, 'the X-ray is not switched on yet');
  const hit = xrays.get(mint);
  if (hit?.value && Date.now() - hit.at < 300_000) return hit.value;
  if (hit?.pending) return hit.pending;
  limit(`xray:${req.ip}`, 6, 60_000, 'too many X-rays from here; wait a minute');
  limit('xray:all', 120, 3_600_000, 'the X-ray is busy; try again in a few minutes');
  const pending = xrayToken(conn, RPC, mint);
  xrays.set(mint, { pending });
  try {
    const value = await pending;
    xrays.set(mint, { at: Date.now(), value });
    if (xrays.size > 500) xrays.delete(xrays.keys().next().value);
    return value;
  } catch (err) {
    xrays.delete(mint);
    throw err;
  }
}

// --- Bundle Index: written by the gem-index worker, read here -----------------------------------------------------
const INDEX_DIR = env('INDEX_DIR', '/data/index');
let indexCache = { at: 0, value: null };
async function bundleIndex() {
  if (indexCache.value && Date.now() - indexCache.at < 10_000) return indexCache.value;
  const { readFile } = await import('node:fs/promises');
  const read = (d) => readFile(`${INDEX_DIR}/${d}.json`, 'utf8').then(JSON.parse).catch(() => null);
  const today = new Date().toISOString().slice(0, 10), yday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const [t, y] = await Promise.all([read(today), read(yday)]);
  const value = { today: t, yesterday: y && { ...y, recent: undefined }, at: new Date().toISOString() };
  indexCache = { at: Date.now(), value };
  return value;
}

// --- Bundle Crews: the database the gem-index worker fills, read here ---------------------------------------------
let crewDb = null;
function crew(mint) {
  try { new PublicKey(mint); } catch { throw new LaunchError(400, 'that is not a Solana address'); }
  crewDb ??= openDb(env('CREWS_DB', '/data/crews.db'));
  const since = crewDb.prepare('SELECT MIN(t) AS t FROM launches').get().t ?? null;
  const recorded = { since, ...crewOf(crewDb, mint) };
  if (recorded.known) return { ...recorded, source: 'recorded' };
  // Not in the database: start from the wallets and funders this coin's X-ray found, if it was X-rayed.
  const x = xrays.get(mint)?.value;
  if (!x) return { since, known: false, needsXray: true };
  const { wallets, funders } = linksFromXray(x);
  return { since, known: true, source: 'xray', crew: crewFromLinks(crewDb, mint, wallets, funders) };
}

async function status(signature) {
  if (!conn) throw new LaunchError(503, 'launches are not switched on yet');
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw new LaunchError(400, 'not a signature');
  const st = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  if (!st) return { status: 'unknown' };
  if (st.err) return { status: 'failed' };
  return { status: st.confirmationStatus === 'processed' ? 'pending' : 'live' };
}

// --- http -----------------------------------------------------------------------------------------------------------
function readJson(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new LaunchError(413, 'that is too big'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new LaunchError(400, 'send the launch as JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', vary: 'origin' };
  if (origin && ORIGINS.includes(origin)) Object.assign(headers, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' });
  const send = (code, body) => {
    res.writeHead(code, headers);
    res.end(JSON.stringify(body));
  };
  // Behind a reverse proxy (TRUST_PROXY=1): the client is the last address the proxy appended, the one part of
  // X-Forwarded-For a visitor cannot write themselves.
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  req.ip = TRUST_PROXY && xff.length ? xff[xff.length - 1] : req.socket.remoteAddress;
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') return send(204, {});
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, launches: Boolean(conn && PINATA) && !PAUSED, github: Boolean(conn && (await lookupTable())) });
    if (req.method === 'GET' && url.pathname === '/v1/recent') return send(200, recent());
    if (req.method === 'GET' && url.pathname.startsWith('/v1/status/')) return send(200, await status(url.pathname.slice(11)));
    if (req.method === 'GET' && url.pathname.startsWith('/v1/crew/')) return send(200, crew(decodeURIComponent(url.pathname.slice(9)).trim()));
    if (req.method === 'GET' && url.pathname === '/v1/index') return send(200, await bundleIndex());
    if (req.method === 'GET' && url.pathname.startsWith('/v1/xray/')) return send(200, await xray(req, decodeURIComponent(url.pathname.slice(9)).trim()));
    if (req.method === 'GET' && url.pathname.startsWith('/v1/scan/')) return send(200, await scan(req, decodeURIComponent(url.pathname.slice(9)).trim()));
    if (req.method === 'POST' && url.pathname === '/v1/prepare') return send(200, await prepare(req, await readJson(req, 3_000_000)));
    if (req.method === 'POST' && url.pathname === '/v1/submit') return send(200, await submit(await readJson(req, 40_000)));
    send(404, { error: 'not found' });
  } catch (err) {
    if (err instanceof LaunchError) return send(err.status, { error: err.message });
    console.error(err);
    send(500, { error: 'something broke on our side; try again' });
  }
});

server.listen(PORT, env('HOST', '127.0.0.1'), () => console.log(`launchpad on :${PORT}, launches ${conn && PINATA && !PAUSED ? 'on' : 'off'}`));
