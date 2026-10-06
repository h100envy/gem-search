import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import bs58 from 'bs58';
import { Connection, PublicKey } from '@solana/web3.js';
import { buildLaunch, checkSigned, LaunchError, parseLaunch } from './launch.mjs';

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
const TABLE = env('LAUNCH_TABLE', ''); // optional address lookup table: keeps the priority fee on launches with a dev buy
const BUILT_TTL = 150_000; // a blockhash lives ~60-90 s; a little longer covers a slow wallet prompt

if (!RPC || !PINATA) console.warn('launchpad: SOLANA_RPC_URL and PINATA_JWT are required for launches; serving status only');
const conn = RPC ? new Connection(RPC, 'confirmed') : null;
mkdirSync(dirname(LOG), { recursive: true });

// --- limits -------------------------------------------------------------------------------------------------------
const hits = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) throw new LaunchError(429, 'too many launches from here right now; try again later');
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

async function prepare(req, body) {
  if (PAUSED) throw new LaunchError(503, 'launches are paused for a moment');
  if (!conn || !PINATA) throw new LaunchError(503, 'launches are not switched on yet');
  const f = parseLaunch(body);
  limit(`ip:${req.ip}`, PER_IP_HOUR, 3_600_000);
  limit('all', PER_DAY, 86_400_000);
  const ext = f.image.contentType.split('/')[1];
  const image = await pin(`${f.symbol}.${ext}`, f.image.bytes, f.image.contentType);
  const metadata = { name: f.name, symbol: f.symbol, description: f.description, image, showName: true, createdOn: 'https://gemsearch.fun', ...f.links };
  const uri = await pin(`${f.symbol}.json`, JSON.stringify(metadata), 'application/json');
  const b = await buildLaunch(conn, { creator: f.creator, mint: f.mint, meta: { name: f.name, symbol: f.symbol, uri }, devBuySol: f.devBuySol, table: await lookupTable() });
  const id = randomBytes(12).toString('hex');
  built.set(id, { at: Date.now(), message: b.message, creator: f.creator.toBase58(), mint: f.mint.toBase58(), lastValidBlockHeight: b.lastValidBlockHeight, name: f.name, symbol: f.symbol, image, devBuySol: f.devBuySol });
  return { id, tx: Buffer.from(b.tx.serialize()).toString('base64'), uri, image };
}

async function submit(body) {
  if (!conn) throw new LaunchError(503, 'launches are not switched on yet');
  const b = built.get(String(body?.id ?? ''));
  if (!b) throw new LaunchError(400, 'that launch expired; start again');
  const tx = checkSigned(String(body?.signed ?? ''), b);
  built.delete(body.id);
  const signature = bs58.encode(tx.signatures[0]);
  try {
    await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
  } catch (err) {
    const msg = String(err.message).split('\n')[0].slice(0, 200);
    if (/blockhash not found/i.test(msg)) throw new LaunchError(400, 'the signature took too long and the launch expired; start again');
    if (/insufficient|no record of a prior credit|0x1\b/i.test(msg)) throw new LaunchError(400, 'not enough SOL in your wallet: a launch needs about 0.03 SOL plus the dev buy');
    if (/simulat|preflight|custom program error/i.test(msg)) throw new LaunchError(400, `the network refused the launch: ${msg}`);
    return { status: 'pending', signature, mint: b.mint };
  }
  const res = await conn.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: b.lastValidBlockHeight }, 'confirmed').catch(() => null);
  if (res?.value?.err) throw new LaunchError(400, `the launch failed on chain: ${JSON.stringify(res.value.err).slice(0, 200)}`);
  if (!res) return { status: 'pending', signature, mint: b.mint };
  appendFileSync(LOG, JSON.stringify({ mint: b.mint, name: b.name, symbol: b.symbol, image: b.image, creator: b.creator, devBuySol: b.devBuySol, signature, at: new Date().toISOString() }) + '\n');
  return { status: 'live', signature, mint: b.mint };
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
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, launches: Boolean(conn && PINATA) && !PAUSED });
    if (req.method === 'GET' && url.pathname === '/v1/recent') return send(200, recent());
    if (req.method === 'GET' && url.pathname.startsWith('/v1/status/')) return send(200, await status(url.pathname.slice(11)));
    if (req.method === 'POST' && url.pathname === '/v1/prepare') return send(200, await prepare(req, await readJson(req, 3_000_000)));
    if (req.method === 'POST' && url.pathname === '/v1/submit') return send(200, await submit(await readJson(req, 20_000)));
    send(404, { error: 'not found' });
  } catch (err) {
    if (err instanceof LaunchError) return send(err.status, { error: err.message });
    console.error(err);
    send(500, { error: 'something broke on our side; try again' });
  }
});

server.listen(PORT, env('HOST', '127.0.0.1'), () => console.log(`launchpad on :${PORT}, launches ${conn && PINATA && !PAUSED ? 'on' : 'off'}`));
