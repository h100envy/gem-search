import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { LaunchError } from './launch.mjs';

const require = createRequire(import.meta.url);
const { PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda, feeSharingConfigPda } = require('@pump-fun/pump-sdk');

/**
 * Web X-ray: who really holds a coin. Takes the largest holders and everyone who bought in the launch block or the
 * seconds after it, follows the SOL that funded them and the coins they passed between each other, and groups wallets
 * that share a funder, sent to each other, or bought together at launch. Every link carries the transaction behind it.
 *
 * Exchanges fund thousands of strangers, so their hot wallets never count as a shared funder.
 *
 * Only standard Solana JSON-RPC is used (free public RPCs, a few requests a second), so every read is capped.
 * Worst case per X-ray: 3 (mint, curve, fee config) + SIG_PAGES (25) mint signature pages + LAUNCH_TXS (40) launch
 * transactions + 2 (largest holders and their owners) + 1 per 100 launch buyers' balances (1-2) + TRACE_WALLETS (24) x
 * (1 signature page + TXS_PER_WALLET (2) transactions) = 72 => about 145 calls. A quiet coin needs a fraction of that.
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
const SIG_PAGES = 25; // mint signature pages of 1000 walked back to the launch
const LAUNCH_TXS = 40; // successful transactions read in the launch window
const TRACE_WALLETS = 24; // wallets whose history is read for funding and transfers
const TXS_PER_WALLET = 2; // transactions read per traced wallet
const CONCURRENCY = 3;
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
// Anchor discriminators of pump.fun's create and create_v2 (node_modules/@pump-fun/pump-sdk/src/idl/pump.json).
// In both the mint is account 0; the launching wallet ("user") is account 7 in create and 5 in create_v2.
const CREATES = [
  { name: 'create', disc: [24, 30, 200, 40, 5, 28, 7, 119], user: 7 },
  { name: 'create_v2', disc: [214, 144, 76, 236, 95, 139, 49, 180], user: 5 },
];

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
/** Runs fn over items, n at a time; a failed item becomes null (unknown), never a guess. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k).catch(() => null); } }));
  return out;
}

export const getTx = (conn, signature) => conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' });

const str = (x) => (x == null ? null : String(x)); // PublicKey or base58 string (JSON fixtures) -> base58
/** Outer instructions, each followed by its inner ones, in execution order. */
function instructions(tx) {
  const inner = new Map((tx.meta?.innerInstructions ?? []).map((x) => [x.index, x.instructions]));
  return (tx.transaction?.message?.instructions ?? []).flatMap((ix, i) => [ix, ...(inner.get(i) ?? [])]);
}

/**
 * A parsed RPC transaction in the shape the analysis below was written against (Helius "enhanced" transactions):
 * { signature, slot, timestamp, feePayer, failed, nativeTransfers: [{ fromUserAccount, toUserAccount, amount (lamports) }],
 *   tokenTransfers: [{ fromUserAccount, toUserAccount, mint, tokenAmount (ui units) }] }.
 * Token accounts are resolved to their owners from the pre/post token balances, falling back to the account's
 * initialization in the same transaction; a source with no balance record falls back to the transfer authority.
 */
export function shapeTx(tx) {
  if (!tx?.transaction) return null;
  const keys = (tx.transaction.message?.accountKeys ?? []).map((k) => str(k?.pubkey ?? k));
  const meta = tx.meta ?? {};
  const accounts = new Map(); // token account -> { owner, mint, decimals }
  for (const b of [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])]) {
    const a = keys[b.accountIndex];
    if (a) accounts.set(a, { owner: b.owner ?? accounts.get(a)?.owner ?? null, mint: b.mint, decimals: b.uiTokenAmount?.decimals ?? accounts.get(a)?.decimals ?? null });
  }
  const ixs = instructions(tx);
  for (const ix of ixs) {
    const p = ix.parsed;
    if (!p?.info || typeof p !== 'object') continue;
    const prog = ix.program;
    let acct = null, owner = null;
    if ((prog === 'spl-token' || prog === 'spl-token-2022') && /^initializeAccount/.test(p.type)) [acct, owner] = [p.info.account, p.info.owner];
    else if (prog === 'spl-associated-token-account' && /^create/.test(p.type)) [acct, owner] = [p.info.account, p.info.wallet];
    if (acct && owner && !accounts.get(acct)?.owner) accounts.set(acct, { decimals: null, ...accounts.get(acct), owner, mint: accounts.get(acct)?.mint ?? p.info.mint ?? null });
  }
  const nativeTransfers = [], tokenTransfers = [];
  const passing = new Map(); // account -> SOL put into it in this transaction: { from, lamports }
  if (!meta.err) {
    for (const ix of ixs) {
      const p = ix.parsed;
      if (!p?.info || typeof p !== 'object') continue;
      if (ix.program === 'system' && (p.type === 'transfer' || p.type === 'transferWithSeed')) {
        nativeTransfers.push({ fromUserAccount: p.info.source, toUserAccount: p.info.destination, amount: Number(p.info.lamports) });
        if (p.info.destination) passing.set(p.info.destination, { from: passing.get(p.info.destination)?.from ?? p.info.source, lamports: (passing.get(p.info.destination)?.lamports ?? 0) + Number(p.info.lamports) });
      } else if (ix.program === 'system' && /^createAccount/.test(p.type) && p.info.newAccount) {
        passing.set(p.info.newAccount, { from: p.info.source, lamports: (passing.get(p.info.newAccount)?.lamports ?? 0) + Number(p.info.lamports) });
      } else if ((ix.program === 'spl-token' || ix.program === 'spl-token-2022') && p.type === 'closeAccount' && passing.has(p.info.account)) {
        // SOL routed through a token account opened and closed in the same transaction (a common way to fund a
        // wallet without a plain transfer): count it as a transfer from whoever filled that account.
        const via = passing.get(p.info.account);
        if (via.from && p.info.destination && via.lamports > 0) nativeTransfers.push({ fromUserAccount: via.from, toUserAccount: p.info.destination, amount: via.lamports, via: p.info.account });
        passing.delete(p.info.account);
      } else if ((ix.program === 'spl-token' || ix.program === 'spl-token-2022') && (p.type === 'transfer' || p.type === 'transferChecked')) {
        const src = accounts.get(p.info.source), dst = accounts.get(p.info.destination);
        const mint = p.info.mint ?? src?.mint ?? dst?.mint ?? null;
        const decimals = p.info.tokenAmount?.decimals ?? src?.decimals ?? dst?.decimals;
        const amount = p.info.tokenAmount ? Number(p.info.tokenAmount.uiAmountString ?? p.info.tokenAmount.uiAmount) : decimals != null ? Number(p.info.amount) / 10 ** decimals : null;
        if (amount == null || !Number.isFinite(amount)) continue;
        tokenTransfers.push({ fromUserAccount: src?.owner ?? p.info.authority ?? p.info.multisigAuthority ?? null, toUserAccount: dst?.owner ?? null, fromTokenAccount: p.info.source, toTokenAccount: p.info.destination, mint, tokenAmount: amount });
      }
    }
  }
  return { signature: tx.transaction.signatures?.[0] ?? null, slot: tx.slot, timestamp: tx.blockTime ?? null, feePayer: keys[0] ?? null, failed: Boolean(meta.err), nativeTransfers, tokenTransfers };
}

/** pump.fun create / create_v2 instructions in a parsed transaction (outer or via CPI): [{ mint, user, kind }]. */
export function pumpCreates(tx) {
  if (!tx?.transaction || tx.meta?.err) return [];
  const out = [];
  for (const ix of instructions(tx)) {
    if (str(ix.programId) !== PUMP || !ix.data || !ix.accounts) continue;
    let data;
    try { data = bs58.decode(ix.data); } catch { continue; }
    const kind = CREATES.find((c) => c.disc.every((b, i) => data[i] === b));
    if (kind) out.push({ mint: str(ix.accounts[0]), user: str(ix.accounts[kind.user]), kind: kind.name });
  }
  return out;
}

/** Whether a parsed transaction initializes this mint (any token program) or creates it on pump.fun. */
export function initializesMint(tx, mint) {
  if (!tx?.transaction || tx.meta?.err) return false;
  return pumpCreates(tx).some((c) => c.mint === mint) || instructions(tx).some((ix) => /^initializeMint/.test(ix.parsed?.type ?? '') && ix.parsed?.info?.mint === mint);
}

const ata = (owner, mint, tokenProgram) => PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

/** `rpc` is unused since the move off Helius; it stays so the call sites keep their shape. */
export async function xrayToken(conn, rpc, mintText) {
  let mint;
  try { mint = new PublicKey(mintText); } catch { throw new LaunchError(400, 'that is not a Solana address'); }
  const M = mint.toBase58();
  const mintAccount = (await conn.getParsedAccountInfo(mint, 'confirmed')).value;
  const parsed = mintAccount?.data?.parsed;
  if (parsed?.type !== 'mint') throw new LaunchError(404, 'no token at that address');
  const tokenProgram = new PublicKey(mintAccount.owner);
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
  // A page that cannot be read (a node that lacks the `before` signature answers "not found") ends the walk as
  // "did not reach the start": the launch is then unknown, never guessed from a partial list.
  let before, oldest = [], pages = 0, all = 0, broken = false;
  const sigPage = (opts) => conn.getSignaturesForAddress(mint, opts, 'confirmed');
  for (; pages < SIG_PAGES; pages++) {
    const page = await sigPage({ before, limit: 1000 }).catch(() => sigPage({ before, limit: 1000 })).catch(() => null);
    if (!page) { broken = true; break; }
    all += page.length;
    if (page.length) { oldest = oldest.concat(page).slice(-150); before = page[page.length - 1].signature; } // pages run newest to oldest
    if (page.length < 1000) break;
  }
  const reachedStart = !broken && pages < SIG_PAGES;
  // Oldest first; within a slot by position in the block when the RPC reports it. Failed transactions move no coins.
  const firstSigs = [...oldest].reverse().map((x, k) => ({ ...x, k })).filter((x) => !x.err)
    .sort((a, b) => a.slot - b.slot || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0) || a.k - b.k);
  const created = reachedStart ? firstSigs[0] ?? null : null;
  let launch = created?.blockTime ? { slot: created.slot, time: created.blockTime, signature: created.signature } : null;
  const windowSigs = launch ? firstSigs.filter((x) => x.blockTime == null || x.blockTime - launch.time <= LAUNCH_WINDOW_S) : [];
  // Some free RPCs keep only recent signature history and return a short list without saying so. The oldest
  // transaction must be the one that made the mint, or the walk did not really reach the start: read it first.
  const first = windowSigs.length ? await getTx(conn, windowSigs[0].signature).catch(() => null) : null;
  const notGenesis = Boolean(launch && first) && !initializesMint(first, M);
  if (notGenesis || !first) launch = null; // unreadable first transaction: launch unknown
  const toRead = launch ? windowSigs.slice(0, LAUNCH_TXS) : [];
  const read = toRead.length ? [first, ...(await pool(toRead.slice(1), CONCURRENCY, (x) => getTx(conn, x.signature)))] : [];
  const missed = read.filter((t) => !t).length;
  // More than half of the launch unreadable: report the launch as unknown rather than understate a bundle.
  if (toRead.length && missed * 2 > toRead.length) launch = null;
  const firstTxs = read.map(shapeTx).filter(Boolean).filter((t) => t.timestamp != null);
  const buys = [], sells = [];
  for (const t of firstTxs) {
    if (!launch || t.timestamp - launch.time > LAUNCH_WINDOW_S) break;
    // One buy per wallet per transaction (a router can move the same coins twice on the way).
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
  // Launch buyers outside the top 20: read their associated token accounts, 100 to a call. A closed or missing
  // account is a zero balance; a failed read leaves the wallet out of "hold now" (unknown, not zero).
  const rest = launchWallets.filter((w) => !holding.has(w));
  for (let i = 0; i < rest.length; i += 100) {
    const chunk = rest.slice(i, i + 100);
    const r = await conn.getMultipleParsedAccounts(chunk.map((w) => ata(w, mint, tokenProgram)), { commitment: 'confirmed' }).catch(() => null);
    if (r) chunk.forEach((w, k) => holding.set(w, Number(r.value[k]?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0)));
  }

  const wallets = [...new Set([...holding.keys(), ...launchWallets, ...(dev ? [dev] : [])])].filter((w) => !infra.has(w));
  const inSet = new Set(wallets);

  // Follow the money: SOL in from where, coins passed between the wallets we look at.
  // Traced first: the dev, launch-block buyers, other launch buyers, then holders by size. Per wallet one signature
  // page and its TXS_PER_WALLET most telling transactions: the oldest (what funded a fresh wallet) and the last one
  // before the launch (a bundle's top-up). Any transfer in them that lands on a wallet in the set counts, not only
  // on the traced one, so one funder paying out to many wallets in a transaction is still seen.
  const sameBlockSet = new Set(buys.filter((b) => b.sameBlock).map((b) => b.wallet));
  const rank = (w) => (w === dev ? 0 : sameBlockSet.has(w) ? 1 : launchWallets.includes(w) ? 2 : 3);
  const traced = [...wallets].sort((a, b) => rank(a) - rank(b) || (holding.get(b) ?? 0) - (holding.get(a) ?? 0)).slice(0, TRACE_WALLETS);
  const picks = await pool(traced, CONCURRENCY, async (w) => {
    const sigs = (await conn.getSignaturesForAddress(new PublicKey(w), { limit: 100 }, 'confirmed')).filter((x) => !x.err); // newest first
    const chosen = [sigs[sigs.length - 1]];
    if (launch) chosen.push(sigs.find((x) => x.blockTime != null && x.blockTime < launch.time));
    for (let k = sigs.length - 2; chosen.filter(Boolean).length < TXS_PER_WALLET && k >= 0; k--) chosen.push(sigs[k]);
    return [...new Set(chosen.filter(Boolean).map((x) => x.signature))].slice(0, TXS_PER_WALLET);
  });
  const traceSigs = [...new Set(picks.flat().filter(Boolean))];
  const traceTxs = (await pool(traceSigs, CONCURRENCY, (sig) => getTx(conn, sig))).map(shapeTx);
  const funders = new Map(); // funder -> Map(wallet -> {sol, signature})
  const edges = [];
  const seen = new Set();
  for (const t of traceTxs) {
    if (!t) continue;
    for (const n of t.nativeTransfers ?? []) {
      const w = n.toUserAccount;
      if (!inSet.has(w) || !n.fromUserAccount || n.fromUserAccount === w || n.amount < 5_000_000) continue;
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
    reachedStart: reachedStart && !notGenesis,
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
    // What was read: anything short of complete means links or launch buys may be missing, never that they are absent.
    coverage: {
      launchTxs: toRead.length, launchTxsMissed: missed, launchWindowCapped: toRead.length > 0 && windowSigs.length > toRead.length,
      walletsTraced: traced.length - picks.filter((x) => !x).length, wallets: wallets.length, traceTxs: traceSigs.length, traceTxsMissed: traceTxs.filter((t) => !t).length,
    },
    clusters: clusters.slice(0, 12),
    nodes,
    edges,
    at: new Date().toISOString(),
  };
}
