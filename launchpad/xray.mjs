import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { LaunchError } from './launch.mjs';

const require = createRequire(import.meta.url);
const { PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda, feeSharingConfigPda } = require('@pump-fun/pump-sdk');

/**
 * Web X-ray: who really holds a coin. Takes the largest holders and everyone who bought in the launch block or the
 * seconds after it, follows the SOL that funded them and the coins they passed between each other, and groups wallets
 * that share a funder, sent to each other, or bought together at launch. Every link carries the transaction behind it.
 *
 * Exchanges fund thousands of strangers, so their hot wallets never count as a shared funder.
 */
export const EXCHANGES = new Set([
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S', // Binance
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm', // Coinbase
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2', // Bybit
  '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD', 'is6MTRHEgyFLNTfYcuV4QBWLjrZBfmhVNYR6ccgr8KV', // OKX
  'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5', // Kraken
  'BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6', // KuCoin
  'G2YxRa6wt1qePMwfJzdXZG62ej4qaTC7YURzuh2Lwd3t', // MEXC
  'ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ', // MEXC
  'u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w', // Gate
]);
const LAUNCH_WINDOW_S = 5; // buys this soon after creation count as launch buys

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k).catch(() => null); } }));
  return out;
}

export async function xrayToken(conn, rpc, mintText) {
  const key = (() => { try { return new URL(rpc).searchParams.get('api-key'); } catch { return null; } })();
  if (!key) throw new LaunchError(503, 'the X-ray needs a Helius key on the server');
  const helius = (path, body) => fetch(`https://api.helius.xyz/v0/${path}${path.includes('?') ? '&' : '?'}api-key=${key}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) } : { signal: AbortSignal.timeout(20_000) }).then((r) => (r.ok ? r.json() : null));

  let mint;
  try { mint = new PublicKey(mintText); } catch { throw new LaunchError(400, 'that is not a Solana address'); }
  const M = mint.toBase58();
  const parsed = (await conn.getParsedAccountInfo(mint, 'confirmed')).value?.data?.parsed;
  if (parsed?.type !== 'mint') throw new LaunchError(404, 'no token at that address');
  const supply = Number(parsed.info.supply) / 10 ** parsed.info.decimals;

  const curvePda = bondingCurvePda(mint).toBase58();
  const poolPda = canonicalPumpPoolPda(mint).toBase58();
  const infra = new Set([curvePda, poolPda, feeSharingConfigPda(mint).toBase58()]);
  const curveInfo = await conn.getAccountInfo(new PublicKey(curvePda), 'confirmed');
  const curve = curveInfo?.data?.length >= 49 ? PUMP_SDK.decodeBondingCurveNullable(curveInfo) : null;
  let dev = curve?.creator?.toBase58() ?? null;
  if (dev && dev === feeSharingConfigPda(mint).toBase58()) {
    try { dev = PUMP_SDK.decodeSharingConfig(await conn.getAccountInfo(feeSharingConfigPda(mint))).admin.toBase58(); } catch { dev = null; }
  }

  // The launch: walk the coin's signatures back to its first one (capped for very busy coins).
  let before, oldest = [], pages = 0, all = 0;
  for (; pages < 25; pages++) {
    const page = await conn.getSignaturesForAddress(mint, { before, limit: 1000 }, 'confirmed');
    all += page.length;
    if (page.length) { oldest = oldest.concat(page).slice(-150); before = page[page.length - 1].signature; } // pages run newest to oldest
    if (page.length < 1000) break;
  }
  const reachedStart = pages < 25;
  const firstSigs = [...oldest].reverse().slice(0, 100); // oldest first
  const firstTxs = reachedStart && firstSigs.length ? (await helius('transactions', { transactions: firstSigs.map((s) => s.signature) })) ?? [] : [];
  firstTxs.sort((a, b) => a.slot - b.slot || a.timestamp - b.timestamp);
  const created = firstTxs[0] ?? null;
  const launch = created ? { slot: created.slot, time: created.timestamp, signature: created.signature } : null;
  const buys = [], sells = [];
  for (const t of firstTxs) {
    if (!launch || t.timestamp - launch.time > LAUNCH_WINDOW_S) break;
    // One buy per wallet per transaction: Helius can list the same Token-2022 movement more than once.
    const perWallet = new Map();
    for (const x of t.tokenTransfers ?? []) if (x.mint === M && infra.has(x.fromUserAccount) && x.toUserAccount && !infra.has(x.toUserAccount)) perWallet.set(x.toUserAccount, Math.max(perWallet.get(x.toUserAccount) ?? 0, x.tokenAmount));
    for (const [wallet, amount] of perWallet) buys.push({ wallet, amount, slot: t.slot, sameBlock: t.slot === launch.slot, signature: t.signature });
    const perSeller = new Map();
    for (const x of t.tokenTransfers ?? []) if (x.mint === M && infra.has(x.toUserAccount) && x.fromUserAccount && !infra.has(x.fromUserAccount)) perSeller.set(x.fromUserAccount, Math.max(perSeller.get(x.fromUserAccount) ?? 0, x.tokenAmount));
    for (const [wallet, amount] of perSeller) sells.push({ wallet, amount });
  }
  // Net per wallet in the launch window: bots that buy and sell back within seconds do not inflate the total.
  const net = new Map();
  for (const b of buys) net.set(b.wallet, (net.get(b.wallet) ?? 0) + b.amount);
  for (const x of sells) if (net.has(x.wallet)) net.set(x.wallet, net.get(x.wallet) - x.amount);
  const netOf = (w) => Math.max(0, net.get(w) ?? 0);

  // Holders now: the 20 largest, and every launch buyer's current balance.
  const largest = (await conn.getTokenLargestAccounts(mint, 'confirmed')).value;
  const owners = await conn.getMultipleParsedAccounts(largest.map((a) => a.address), { commitment: 'confirmed' });
  const holding = new Map();
  largest.forEach((a, i) => { const o = owners.value[i]?.data?.parsed?.info?.owner; if (o) holding.set(o, (holding.get(o) ?? 0) + Number(a.uiAmount ?? 0)); });
  const launchWallets = [...new Set(buys.map((b) => b.wallet))];
  await pool(launchWallets.filter((w) => !holding.has(w)), 4, async (w) => {
    const r = await conn.getParsedTokenAccountsByOwner(new PublicKey(w), { mint }, 'confirmed');
    holding.set(w, r.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0));
  });

  const wallets = [...new Set([...holding.keys(), ...launchWallets, ...(dev ? [dev] : [])])].filter((w) => !infra.has(w));
  const inSet = new Set(wallets);

  // Follow the money: SOL in from where, coins passed between the wallets we look at.
  const funders = new Map(); // funder -> Map(wallet -> {sol, signature})
  const edges = [];
  const seen = new Set();
  await pool(wallets, 5, async (w) => {
    const txs = await helius(`addresses/${w}/transactions?limit=100`);
    for (const t of Array.isArray(txs) ? txs : []) {
      for (const n of t.nativeTransfers ?? []) {
        if (n.toUserAccount !== w || !n.fromUserAccount || n.fromUserAccount === w || n.amount < 5_000_000) continue;
        const f = n.fromUserAccount;
        if (infra.has(f) || EXCHANGES.has(f)) continue;
        if (!funders.has(f)) funders.set(f, new Map());
        const prev = funders.get(f).get(w);
        funders.get(f).set(w, { sol: (prev?.sol ?? 0) + n.amount / 1e9, signature: prev?.signature ?? t.signature });
      }
      for (const x of t.tokenTransfers ?? []) {
        if (x.mint !== M || !inSet.has(x.fromUserAccount) || !inSet.has(x.toUserAccount) || x.fromUserAccount === x.toUserAccount) continue;
        const id = `${t.signature}:${x.fromUserAccount}:${x.toUserAccount}`;
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push({ from: x.fromUserAccount, to: x.toUserAccount, kind: 'coins', amount: x.tokenAmount, signature: t.signature });
      }
    }
  });
  // A funder inside the set is a direct link; one outside that funded two or more of them is a shared source.
  const sharedFunders = [];
  for (const [f, got] of funders) {
    const fundedHere = [...got.keys()].filter((w) => inSet.has(w));
    if (inSet.has(f)) for (const w of fundedHere) edges.push({ from: f, to: w, kind: 'sol', sol: round(got.get(w).sol, 3), signature: got.get(w).signature });
    else if (fundedHere.length >= 2) {
      sharedFunders.push(f);
      for (const w of fundedHere) edges.push({ from: f, to: w, kind: 'funded', sol: round(got.get(w).sol, 3), signature: got.get(w).signature });
    }
  }

  // Clusters: union of everything linked, plus everyone who bought in the launch block together.
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const join = (a, b) => { add(a); add(b); parent.set(find(a), find(b)); };
  wallets.forEach(add);
  sharedFunders.forEach(add);
  for (const e of edges) join(e.from, e.to);
  const sameBlock = [...new Set(buys.filter((b) => b.sameBlock).map((b) => b.wallet))];
  for (let i = 1; i < sameBlock.length; i++) join(sameBlock[0], sameBlock[i]);
  const groups = new Map();
  for (const w of wallets) { const r = find(w); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(w); }
  const pctOf = (w) => round(((holding.get(w) ?? 0) / supply) * 100);
  const clusters = [...groups.values()].filter((g) => g.length >= 2).map((g) => {
    const set = new Set(g);
    const reasons = [];
    const sb = g.filter((w) => sameBlock.includes(w)).length;
    if (sb >= 2) reasons.push(`${sb} bought in the launch block`);
    const shared = sharedFunders.filter((f) => edges.some((e) => e.from === f && set.has(e.to)));
    if (shared.length) reasons.push(`funded from ${shared.length === 1 ? 'one wallet' : shared.length + ' shared wallets'}`);
    const direct = edges.filter((e) => e.kind !== 'funded' && set.has(e.from) && set.has(e.to)).length;
    if (direct) reasons.push(`${direct} direct transfer${direct > 1 ? 's' : ''} between them`);
    if (dev && set.has(dev)) reasons.push('includes the dev wallet');
    return { wallets: g, size: g.length, holdsPct: round(g.reduce((s, w) => s + pctOf(w), 0)), reasons, funders: shared };
  }).sort((a, b) => b.holdsPct - a.holdsPct || b.size - a.size);
  const clusterOf = new Map();
  clusters.forEach((c, i) => c.wallets.forEach((w) => clusterOf.set(w, i)));

  const boughtByLaunch = launchWallets.reduce((s, w) => s + netOf(w), 0);
  const sameBlockBought = [...new Set(buys.filter((b) => b.sameBlock).map((b) => b.wallet))].reduce((s, w) => s + netOf(w), 0);
  const launchHoldNow = launchWallets.reduce((s, w) => s + (holding.get(w) ?? 0), 0);
  const nodes = [
    ...wallets.map((w) => ({ id: w, pct: pctOf(w), kind: w === dev ? 'dev' : launchWallets.includes(w) ? (sameBlock.includes(w) ? 'bundle' : 'sniper') : 'holder', cluster: clusterOf.get(w) ?? null })),
    ...sharedFunders.map((f) => ({ id: f, pct: 0, kind: 'funder', cluster: clusterOf.get(find(f)) ?? [...groups.values()].findIndex((g) => g.includes(f)) })),
  ];
  // Funders join their cluster index through the wallets they funded.
  for (const n of nodes) if (n.kind === 'funder') { const w = edges.find((e) => e.from === n.id)?.to; n.cluster = clusterOf.get(w) ?? null; }
  const poolPct = round(((holding.get(poolPda) ?? 0) + (holding.get(curvePda) ?? 0)) / supply * 100);

  return {
    mint: M,
    dev,
    launch: launch && { ...launch, at: new Date(launch.time * 1000).toISOString() },
    reachedStart,
    signaturesRead: all,
    bundle: launch ? {
      sameBlockWallets: sameBlock.length,
      sameBlockBoughtPct: round((sameBlockBought / supply) * 100),
      launchWindowWallets: launchWallets.length,
      launchWindowBoughtPct: round((boughtByLaunch / supply) * 100),
      launchBuyersHoldNowPct: round((launchHoldNow / supply) * 100),
      windowSeconds: LAUNCH_WINDOW_S,
    } : null,
    poolPct,
    clusters: clusters.slice(0, 12),
    nodes,
    edges,
    at: new Date().toISOString(),
  };
}
