import { Connection } from '@solana/web3.js';

/**
 * Our own Solana RPC layer over free public endpoints, so the server needs no paid RPC plan. Every JSON-RPC request
 * goes to the endpoint with the soonest free slot under its own requests-per-second budget. A 429 cools that endpoint
 * down for that method; a 401/402/403 or "method not found" marks the method unsupported there for a while; network
 * errors and 5xx cool the endpoint. The request then moves to the next endpoint. Identical requests in flight are
 * shared, and transactions (immutable once found) are cached. web3.js talks to it through Connection's `fetch` option,
 * so the rest of the code keeps using a plain Connection.
 */
export const DEFAULT_ENDPOINTS = [
  { url: 'https://solana-rpc.publicnode.com', rps: 4 },
  { url: 'https://public.rpc.solanavibestation.com', rps: 3 },
  { url: 'https://api.mainnet-beta.solana.com', rps: 2, full: true, historyRps: 0.8 }, // the only free node with the whole signature history
  { url: 'https://solana.leorpc.com/?api_key=FREE', rps: 2 },
];
// Free nodes silently cut signature history to hours or a few hundred entries, so history reads go to full nodes.
const HISTORY = new Set(['getSignaturesForAddress']);
const CACHEABLE = new Set(['getTransaction', 'getParsedTransaction', 'getBlockTime']);
// Solana now has version-1 transactions; a node refuses them when asked for version 0 at most, so ask for 1.
const TX_METHODS = new Set(['getTransaction', 'getParsedTransaction', 'getBlock', 'getParsedBlock']);
const UNSUPPORTED_CODES = new Set([-32601, -32010, -32011]);
const RATE_CODES = new Set([-32429, -32005, -32029, 429]);

export function parseEndpoints(spec) {
  return String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [url, rps, flag, hist] = s.split('|');
    return { url, rps: Number(rps) || 3, ...(flag === 'full' ? { full: true } : {}), ...(Number(hist) ? { historyRps: Number(hist) } : {}) };
  });
}

function upgrade(req) {
  if (!TX_METHODS.has(req.method) || !Array.isArray(req.params)) return req;
  const o = req.params[1];
  if (o && typeof o === 'object' && (o.maxSupportedTransactionVersion ?? 0) < 1) return { ...req, params: [req.params[0], { ...o, maxSupportedTransactionVersion: 1 }, ...req.params.slice(2)] };
  if (!o) return { ...req, params: [req.params[0], { maxSupportedTransactionVersion: 1 }] };
  return req;
}

export function createRpcPool({ endpoints = DEFAULT_ENDPOINTS, historyAnyNode = false, fetchFn = fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), deadlineMs = 45_000, cacheSize = 5000, logger = console } = {}) {
  const eps = endpoints.map((e) => ({ ...e, next: 0, nextHist: 0, cool: 0, methodCool: new Map(), unsupported: new Map(), ok: 0, fail: 0, txHit: 0, txMiss: 0 }));
  const hasFull = eps.some((e) => e.full);
  const cache = new Map();
  const inflight = new Map();
  // A node that keeps answering null for transactions others have is short on history: ask it last.
  const forgetful = (e) => e.txHit + e.txMiss >= 6 && e.txMiss > e.txHit;

  const usable = (e, method, t) => (historyAnyNode || !HISTORY.has(method) || e.full || !hasFull) && e.cool <= t && (e.methodCool.get(method) ?? 0) <= t && (e.unsupported.get(method) ?? 0) <= t;

  /** The endpoint that can take this method soonest, and how long to wait for its slot. */
  function choose(method, tried) {
    const t = now();
    let best = null, backup = null;
    for (const e of eps) {
      if (tried.has(e) || !usable(e, method, t)) continue;
      if (e.backup || (TX_METHODS.has(method) && forgetful(e))) { if (!backup || e.next < backup.next) backup = e; continue; }
      if (!best || e.next < best.next) best = e;
    }
    // A backup (a paid key, or a forgetful node for transactions) is used only when the rest are out or > 1.5 s away.
    if (backup && (!best || best.next - t > 1500)) best = backup;
    if (!best) return null;
    if (HISTORY.has(method) && best.historyRps) {
      const wait = Math.max(0, best.next - t, best.nextHist - t);
      const at = t + wait;
      best.nextHist = at + 1000 / best.historyRps;
      best.next = Math.max(best.next, at) + 1000 / best.rps;
      return { e: best, wait };
    }
    const wait = Math.max(0, best.next - t);
    best.next = Math.max(best.next, t) + 1000 / best.rps;
    return { e: best, wait };
  }

  /** When nothing is usable: how long until the first endpoint frees up for this method. */
  function soonest(method) {
    const t = now();
    let w = Infinity;
    for (const e of eps) w = Math.min(w, Math.max(e.cool, e.methodCool.get(method) ?? 0, e.unsupported.get(method) ?? 0) - t);
    return Math.max(50, Math.min(w, 5000));
  }

  const done = (body, e) => { e.ok++; Object.defineProperty(body, 'from', { value: e, enumerable: false }); return body; };

  async function sendOne(req, avoid = new Set()) {
    const method = req.method;
    const deadline = now() + deadlineMs;
    let tried = new Set(avoid), last = null, shallow = false;
    while (now() < deadline) {
      const pick = choose(method, tried);
      if (!pick) {
        if (avoid.size && avoid.size >= eps.length) return { jsonrpc: '2.0', id: req.id, result: null };
        if (shallow && tried.size >= eps.length) break; // no node in the pool keeps that much history
        if (tried.size > avoid.size) tried = new Set(avoid); // every endpoint had a go: start another round after a pause
        await sleep(soonest(method));
        continue;
      }
      const { e, wait } = pick;
      if (wait) await sleep(wait);
      tried.add(e);
      let res, body;
      try {
        res = await fetchFn(e.url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'gemsearch/1.0' }, body: JSON.stringify(req), signal: AbortSignal.timeout(20_000) });
        body = await res.json().catch(() => null);
      } catch (err) {
        e.cool = now() + 15_000; e.fail++; last = { error: { code: -32000, message: `rpc unreachable: ${err.message}` } };
        continue;
      }
      const code = body?.error?.code;
      const msg = String(body?.error?.message ?? '');
      if (body && 'result' in body && !body.error) return done(body, e); // some nodes answer 429 with a good result: keep it
      if (res.status === 429 || RATE_CODES.has(code) || /rate|too many|max usage/i.test(msg)) {
        e.methodCool.set(method, now() + (/max usage/i.test(msg) ? 3_600_000 : 3_000));
        e.fail++; last = body ?? { error: { code: 429, message: 'rate limited' } };
        continue;
      }
      if ([401, 402, 403].includes(res.status) || UNSUPPORTED_CODES.has(code) || /not available|not supported|paid plan|personal token/i.test(msg)) {
        e.unsupported.set(method, now() + 600_000);
        e.fail++; last = body ?? { error: { code: res.status, message: `rpc ${res.status}` } };
        continue;
      }
      // Free nodes keep only hours of signature history: a cursor older than that is "not found" there, so ask the
      // next node (api.mainnet-beta keeps it all) without cooling this one down.
      if (code === -32020 || (HISTORY.has(method) && /not found/i.test(msg))) {
        shallow = true; last = body;
        continue;
      }
      if (code === -32603 || /internal|timed? ?out|unavailable/i.test(msg)) { // the node hiccuped: try another one
        e.methodCool.set(method, now() + 5_000);
        e.fail++; last = body;
        continue;
      }
      if (res.status >= 500 || !body) {
        e.cool = now() + 15_000; e.fail++; last = body ?? { error: { code: res.status, message: `rpc ${res.status}` } };
        continue;
      }
      return done(body, e);
    }
    logger.error?.('[rpc] gave up on', method, last?.error?.message);
    return { jsonrpc: '2.0', id: req.id, ...(last?.error ? { error: last.error } : { error: { code: -32000, message: 'all RPC endpoints are busy; try again' } }) };
  }

  async function handle(req) {
    req = upgrade(req);
    const key = JSON.stringify([req.method, req.params ?? []]);
    if (CACHEABLE.has(req.method) && cache.has(key)) return { ...cache.get(key), id: req.id };
    if (inflight.has(key)) return { ...(await inflight.get(key)), id: req.id };
    const p = (async () => {
      let out = await sendOne(req);
      // A node without that part of history (or a few slots behind) answers null: ask up to two others.
      const asked = new Set(out.from ? [out.from] : []), missed = [];
      while (TX_METHODS.has(req.method) && out.result === null && !out.error && out.from && asked.size < Math.min(3, eps.length)) {
        missed.push(out.from);
        const again = await sendOne(req, asked);
        if (!again.from) break;
        asked.add(again.from); out = again;
      }
      if (TX_METHODS.has(req.method) && out.result != null && out.from) { out.from.txHit++; for (const m of missed) m.txMiss++; }
      return { jsonrpc: '2.0', id: req.id, ...(out.error ? { error: out.error } : { result: out.result }) };
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    const out = await p;
    if (CACHEABLE.has(req.method) && out.result != null) {
      cache.set(key, out);
      if (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    }
    return { ...out, id: req.id };
  }

  return {
    async fetch(_url, init = {}) {
      const payload = JSON.parse(typeof init.body === 'string' ? init.body : String(init.body));
      const out = Array.isArray(payload) ? await Promise.all(payload.map(handle)) : await handle(payload);
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    stats: () => eps.map((e) => ({ url: e.url.replace(/\?.*/, ''), rps: e.rps, full: !!e.full, backup: !!e.backup, ok: e.ok, fail: e.fail })),
  };
}

let shared = null;
/** One pool per process: SOLANA_RPC_POOL ("url|rps[|full[|historyRps]],...") or the free defaults, plus SOLANA_RPC_URL as a backup. */
export function solanaPool(env = process.env) {
  if (shared) return shared;
  const list = env.SOLANA_RPC_POOL ? parseEndpoints(env.SOLANA_RPC_POOL) : DEFAULT_ENDPOINTS.map((e) => ({ ...e }));
  if (env.SOLANA_RPC_URL && !list.some((e) => e.url === env.SOLANA_RPC_URL)) list.push({ url: env.SOLANA_RPC_URL, rps: Number(env.SOLANA_RPC_URL_RPS) || 5, backup: true, full: true });
  shared = createRpcPool({ endpoints: list, historyAnyNode: env.SOLANA_HISTORY_ANY_NODE === '1' });
  return shared;
}

export function solanaConnection(commitment = 'confirmed', env = process.env) {
  const pool = solanaPool(env);
  return new Connection(DEFAULT_ENDPOINTS[0].url, { commitment, fetch: pool.fetch, disableRetryOnRateLimit: true });
}
