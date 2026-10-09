import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import bs58 from 'bs58';
import { Connection, PublicKey } from '@solana/web3.js';
import { buildLaunch, checkSigned, LaunchError, parseLaunch, parseSources, placeSources } from './launch.mjs';
import { scanToken } from './scan.mjs';
import { buildLaunchTx, client as ponsClient, parseLaunchReceipt, quoteMinTokensOut, readTerms } from './pons.mjs';
import { imageMatches } from './launch.mjs';
import { walletHoldings } from './wallet.mjs';
import { createCup } from './cup.mjs';
import { createAdvisor, createPonsCounter } from './advisor.mjs';
import { createNarratives } from './narratives.mjs';
import { createCouncil, factsOf } from './council.mjs';
import { checkVerdicts, initRecord, recordVerdict, trackRecord } from './record.mjs';
import { xrayToken } from './xray.mjs';
import { crewFromLinks, crewOf, linksFromXray, openDb } from './crews.mjs';
import { burnStats } from './burns.mjs';
import { solanaConnection, solanaPool } from './rpc-pool.mjs';

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

if (!PINATA) console.warn('launchpad: PINATA_JWT is required for launches');
// Solana reads and sends go through our pool of free public RPCs; SOLANA_RPC_URL, when set, is only a backup.
const conn = solanaConnection('confirmed');
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
  const placed = placeSources({ description: f.description, twitter: f.links.twitter ?? '', website: f.links.website ?? '' }, f.sources);
  const metadata = { name: f.name, symbol: f.symbol, description: placed.description, image, showName: true, createdOn: 'https://gemsearch.fun', ...f.links, ...(placed.twitter ? { twitter: placed.twitter } : {}), ...(placed.website ? { website: placed.website } : {}), ...(f.sources.repo ? { github: f.sources.repo } : {}), ...(f.sources.post ? { sourcePost: f.sources.post } : {}) };
  const uri = await pin(`${f.symbol}.json`, JSON.stringify(metadata), 'application/json');
  const share = github ? { githubId: github.id, bps: f.githubShare * 100 } : null;
  const b = await buildLaunch(conn, { creator: f.creator, mint: f.mint, meta: { name: f.name, symbol: f.symbol, uri }, devBuySol: f.devBuySol, table, share });
  const id = randomBytes(12).toString('hex');
  built.set(id, {
    at: Date.now(), message: b.message, pre: b.pre?.message ?? null, creator: f.creator.toBase58(), mint: f.mint.toBase58(), lastValidBlockHeight: b.lastValidBlockHeight,
    name: f.name, symbol: f.symbol, image, devBuySol: f.devBuySol, github: github && { login: github.login, share: f.githubShare }, repo: f.sources.repo, post: f.sources.post,
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
  appendFileSync(LOG, JSON.stringify({ mint: b.mint, name: b.name, symbol: b.symbol, image: b.image, creator: b.creator, devBuySol: b.devBuySol, github: b.github, repo: b.repo ?? null, post: b.post ?? null, signature, at: new Date().toISOString() }) + '\n');
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
  limit(`xray:${req.ip}`, 10, 60_000, 'too many X-rays from here; wait a minute');
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

// --- Am I exit liquidity: a wallet's coins, valued; the page scans and X-rays each ------------------------------------
const wallets = new Map();
async function wallet(req, address) {
  if (!conn) throw new LaunchError(503, 'not switched on yet');
  const hit = wallets.get(address);
  if (hit && Date.now() - hit.at < 120_000) return hit.value;
  limit(`wallet:${req.ip}`, 6, 60_000, 'too many wallet checks from here; wait a minute');
  const value = await walletHoldings(conn, address);
  wallets.set(address, { at: Date.now(), value });
  if (wallets.size > 500) wallets.delete(wallets.keys().next().value);
  return value;
}

// --- Grok Council ------------------------------------------------------------------------------------------------
const council = env('XAI_API_KEY', '') ? createCouncil({ key: env('XAI_API_KEY', ''), dataDir: dirname(LOG), dailyUsd: Number(env('COUNCIL_DAILY_USD', 1.5)) }) : null;
const councils = new Map();
async function councilFacts(req, mint) {
  const [s, x] = await Promise.all([scan(req, mint), xray(req, mint).catch(() => null)]);
  let c = null;
  try { c = crew(mint); } catch {}
  return factsOf(s, x, c);
}
async function convene(req, mint) {
  if (!council) throw new LaunchError(503, 'the council is not set up on this server');
  try { new PublicKey(mint); } catch { throw new LaunchError(400, 'that is not a Solana address'); }
  const hit = councils.get(mint);
  if (hit?.value && Date.now() - hit.at < 900_000) return hit.value;
  if (hit?.pending) return hit.pending;
  limit(`council:${req.ip}`, 3, 300_000, 'the council meets 3 times per 5 minutes per visitor; try again shortly');
  const pending = councilFacts(req, mint).then((f) => council.convene(f).then((d) => {
    try { crewDb ??= openDb(env('CREWS_DB', '/data/crews.db')); initRecord(crewDb); recordVerdict(crewDb, d, f, 'web'); } catch (e) { console.error('[record]', e.message); }
    return { ...d, facts: f };
  }));
  councils.set(mint, { pending });
  try {
    const value = await pending;
    councils.set(mint, { at: Date.now(), value });
    if (councils.size > 300) councils.delete(councils.keys().next().value);
    return value;
  } catch (err) { councils.delete(mint); throw err; }
}
const roasts = new Map();
async function roastCoin(req, mint) {
  if (!council) throw new LaunchError(503, 'the roaster is not set up on this server');
  try { new PublicKey(mint); } catch { throw new LaunchError(400, 'that is not a Solana address'); }
  const hit = roasts.get(mint);
  if (hit && Date.now() - hit.at < 300_000) return hit.value;
  limit(`roast:${req.ip}`, 5, 300_000, 'five roasts per 5 minutes; let the grill cool down');
  const facts = councils.get(mint)?.value?.facts ?? (await councilFacts(req, mint));
  const value = await council.roast(facts, councils.get(mint)?.value?.x?.summary ?? null);
  roasts.set(mint, { at: Date.now(), value });
  if (roasts.size > 300) roasts.delete(roasts.keys().next().value);
  return value;
}
async function roastBag(req, body) {
  if (!council) throw new LaunchError(503, 'the roaster is not set up on this server');
  limit(`roastbag:${req.ip}`, 3, 300_000, 'three bag roasts per 5 minutes');
  return council.roastBag(body);
}

// The track record: verdicts checked against what the coins did, every few minutes, in this process only.
let recordCache = { at: 0, value: null };
function councilRecord() {
  crewDb ??= openDb(env('CREWS_DB', '/data/crews.db')); initRecord(crewDb);
  if (!recordCache.value || Date.now() - recordCache.at > 30_000) recordCache = { at: Date.now(), value: trackRecord(crewDb) };
  return recordCache.value;
}
setInterval(() => { try { crewDb ??= openDb(env('CREWS_DB', '/data/crews.db')); initRecord(crewDb); checkVerdicts(crewDb).catch((e) => console.error('[record] check', e.message)); } catch {} }, 180_000).unref();

async function askCouncil(req, mint, body) {
  if (!council) throw new LaunchError(503, 'the council is not set up on this server');
  const d = councils.get(mint)?.value;
  if (!d) throw new LaunchError(400, 'convene the council on this coin first');
  limit(`ask:${req.ip}`, 6, 300_000, 'six questions per 5 minutes; give the council a breather');
  return council.ask(d.facts, d, body?.q);
}

// --- pons V2 on Robinhood Chain: the creator's EVM wallet sends; we pin the logo and build the calldata --------------
const pons = ponsClient(env('ROBINHOOD_RPC_URL', 'https://rpc.mainnet.chain.robinhood.com'));
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
async function ponsPrepare(req, body) {
  if (PAUSED) throw new LaunchError(503, 'launches are paused for a moment');
  if (!PINATA) throw new LaunchError(503, 'launches are not switched on yet');
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const name = str(body?.name), symbol = str(body?.symbol).replace(/^\$/, '').toUpperCase(), creator = str(body?.creator);
  if (name.length < 2 || name.length > 32) throw new LaunchError(400, 'name: 2 to 32 characters');
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) throw new LaunchError(400, 'ticker: 2 to 10 letters or digits');
  if (!EVM_ADDR.test(creator)) throw new LaunchError(400, 'connect an EVM wallet first');
  const description = str(body?.description).slice(0, 500);
  const links = {};
  for (const k of ['website', 'twitter', 'telegram']) { const v = str(body?.[k]); if (v && !/^https:\/\/[^\s]{3,200}$/.test(v)) throw new LaunchError(400, `${k}: a full https:// link`); links[k] = v; }
  const sources = parseSources(body);
  const placed = placeSources({ description, twitter: links.twitter, website: links.website }, sources);
  const devBuyEth = body?.devBuyEth === undefined || body?.devBuyEth === '' ? 0 : Number(body.devBuyEth);
  if (!Number.isFinite(devBuyEth) || devBuyEth < 0 || devBuyEth > 0.5) throw new LaunchError(400, 'dev buy: 0 to 0.5 ETH');
  const taxBps = Math.round(Number(body?.creatorTaxPct ?? 0) * 100);
  if (!Number.isInteger(taxBps) || taxBps < 0 || taxBps > 500) throw new LaunchError(400, 'creator tax: 0 to 5%');
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(str(body?.image));
  if (!m) throw new LaunchError(400, 'image: a PNG, JPEG, WebP or GIF');
  const bytes = new Uint8Array(Buffer.from(m[2], 'base64'));
  if (bytes.length > 2_000_000 || !imageMatches(m[1], bytes)) throw new LaunchError(400, 'image: up to 2 MB, and the type it claims to be');
  limit(`ip:${req.ip}`, PER_IP_HOUR, 3_600_000);
  limit('all', PER_DAY, 86_400_000);
  const terms = await readTerms(pons);
  if (!terms.launchEnabled) throw new LaunchError(503, 'pons has paused launches right now');
  const imageUrl = await pin(`${symbol}.${m[1].split('/')[1]}`, bytes, m[1]);
  const logo = 'ipfs://' + imageUrl.split('/ipfs/')[1];
  const args = { creator, name, symbol, logo, description: placed.description.slice(0, 1800), twitter: placed.twitter, telegram: links.telegram, website: placed.website, feeRecipient: creator, creatorTaxBps: taxBps, devBuyEth: String(devBuyEth), terms };
  let minTokensOut = 0n, salt;
  if (devBuyEth > 0) {
    try { ({ minTokensOut, salt } = await quoteMinTokensOut(args, creator, 200n, pons)); }
    catch (e) {
      const msg = String(e.shortMessage ?? e.message);
      throw new LaunchError(400, /insufficient|exceeds the balance|funds/i.test(msg) ? `not enough ETH on Robinhood Chain: a launch needs ${Number(terms.launchFee) / 1e18} ETH plus the dev buy plus gas` : `pons refused the launch in simulation: ${msg.slice(0, 160)}`);
    }
  }
  const tx = buildLaunchTx({ ...args, minTokensOut, salt });
  return { to: tx.to, data: tx.data, value: '0x' + tx.value.toString(16), logo, image: imageUrl, launchFeeEth: Number(terms.launchFee) / 1e18 };
}
async function ponsConfirm(body) {
  const hash = String(body?.hash ?? '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new LaunchError(400, 'not a transaction hash');
  const receipt = await pons.getTransactionReceipt({ hash }).catch(() => null);
  if (!receipt) return { status: 'pending' };
  if (receipt.status !== 'success') throw new LaunchError(400, 'the launch failed on chain');
  const l = parseLaunchReceipt(receipt);
  if (!l) throw new LaunchError(400, 'that transaction is not a pons launch');
  let src = { repo: null, post: null };
  try { src = parseSources(body); } catch {}
  const meta = { name: String(body?.name ?? '').slice(0, 40), symbol: String(body?.symbol ?? '').slice(0, 12), image: String(body?.image ?? '').slice(0, 200), repo: src.repo, post: src.post };
  appendFileSync(LOG, JSON.stringify({ chain: 'robinhood', mint: l.token, curve: l.curve, creator: l.deployer, ...meta, signature: hash, at: new Date().toISOString() }) + '\n');
  return { status: 'live', token: l.token, curve: l.curve };
}

// --- Launch Cup ---------------------------------------------------------------------------------------------------
const cup = createCup({ conn: conn ?? null, log: LOG, dir: dirname(LOG), prizes: env('CUP_PRIZES', '50,20,10').split(',').map(Number) });

// --- Chain advisor: Solana or Robinhood, from the last 24h of launches and graduations ----------------------------------
const ponsCounter = createPonsCounter({ file: `${dirname(LOG)}/pons-counts.json` });
let advisor = null;
const advise = () => {
  crewDb ??= openDb(env('CREWS_DB', '/data/crews.db'));
  advisor ??= createAdvisor({ db: crewDb, key: env('XAI_API_KEY', ''), pons: ponsCounter, dataDir: dirname(LOG), dailyUsd: Number(env('ADVISOR_DAILY_USD', 0.5)) });
  return advisor.get();
};
// --- Narrative Hunter: what started moving on X in the last hours, with clone counts from the launch feed --------------
let hunter = null;
const narratives = () => {
  if (!env('XAI_API_KEY', '')) throw new LaunchError(503, 'not switched on yet');
  crewDb ??= openDb(env('CREWS_DB', '/data/crews.db'));
  hunter ??= createNarratives({ key: env('XAI_API_KEY', ''), db: crewDb, dataDir: dirname(LOG), dailyUsd: Number(env('NARRATIVES_DAILY_USD', 1.5)) });
  return hunter.get();
};
setInterval(() => ponsCounter.refresh().catch((e) => console.error('[advisor] pons', e.shortMessage ?? e.message)), 300_000).unref();

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
    if (req.method === 'POST' && url.pathname === '/v1/pons/prepare') return send(200, await ponsPrepare(req, await readJson(req, 3_000_000)));
    if (req.method === 'POST' && url.pathname === '/v1/pons/confirm') return send(200, await ponsConfirm(await readJson(req, 4_000)));
    if (req.method === 'GET' && url.pathname === '/v1/rpc') return send(200, { endpoints: solanaPool().stats() });
    if (req.method === 'GET' && url.pathname === '/v1/narratives') return send(200, (await narratives()) ?? { narratives: [] });
    if (req.method === 'GET' && url.pathname === '/v1/advisor') return send(200, await advise());
    if (req.method === 'GET' && url.pathname === '/v1/cup') { if (!conn) throw new LaunchError(503, 'not switched on yet'); return send(200, await cup()); }
    if (req.method === 'GET' && url.pathname === '/v1/record') return send(200, councilRecord());
    if (req.method === 'POST' && url.pathname === '/v1/roast-bag') return send(200, await roastBag(req, await readJson(req, 8_000)));
    if (req.method === 'GET' && url.pathname.startsWith('/v1/roast/')) return send(200, await roastCoin(req, decodeURIComponent(url.pathname.slice(10)).trim()));
    if (req.method === 'POST' && /^\/v1\/council\/[^/]+\/ask$/.test(url.pathname)) return send(200, await askCouncil(req, decodeURIComponent(url.pathname.split('/')[3]), await readJson(req, 4_000)));
    if (req.method === 'GET' && url.pathname.startsWith('/v1/council/')) { const d = await convene(req, decodeURIComponent(url.pathname.slice(12)).trim()); const { facts, ...pub } = d; return send(200, pub); }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/wallet/')) return send(200, await wallet(req, decodeURIComponent(url.pathname.slice(11)).trim()));
    if (req.method === 'GET' && url.pathname.startsWith('/v1/crew/')) return send(200, crew(decodeURIComponent(url.pathname.slice(9)).trim()));
    if (req.method === 'GET' && url.pathname === '/v1/index') return send(200, await bundleIndex());
    if (req.method === 'GET' && url.pathname === '/v1/burns') return send(200, await burnStats(conn, RPC, url.searchParams.get('owner')));
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
