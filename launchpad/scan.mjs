import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { LaunchError, pumpGlobals } from './launch.mjs';
import { getTx, pool, pumpCreates } from './xray.mjs';

const require = createRequire(import.meta.url);
const { PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda, feeSharingConfigPda } = require('@pump-fun/pump-sdk');

/**
 * A reading of one Solana token, built only from what can be read: the mint account, pump.fun's bonding curve, the
 * largest holders, the creator's earlier pump.fun launches (read from
 * its recent transactions over standard RPC), and DexScreener's market and profile data.
 * Every check says what it saw; anything that could not be read is reported as unknown and never counts as a pass.
 */
const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const json = (url, ms = 10_000) => fetch(url, { headers: { accept: 'application/json', 'user-agent': 'gemsearch-scan' }, signal: AbortSignal.timeout(ms) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

const DEV_SIGS = 100; // signatures of the creator listed
const DEV_TXS = 25; // of those, the newest successful ones read

/**
 * The creator's pump.fun launches among its recent transactions, and how many of them left the curve.
 * RPC calls: 1 signature page + up to DEV_TXS (25) transactions + 1 curve lookup per 100 launches => at most 27.
 * A launch is a pump.fun create / create_v2 instruction this wallet signed as the launcher. Transactions that could
 * not be read make the answer partial ("N+"); if none of them showed a launch, the answer is unknown, not "first".
 * A short list that does not even hold this coin's own launch is a truncated history: unknown as well.
 */
export async function devHistory(conn, creator, mint) {
  const sigs = await conn.getSignaturesForAddress(new PublicKey(creator), { limit: DEV_SIGS }, 'confirmed');
  const ok = sigs.filter((s) => !s.err);
  const picked = ok.slice(0, DEV_TXS);
  const txs = await pool(picked, 3, (s) => getTx(conn, s.signature));
  const missed = txs.filter((t) => !t).length;
  const creates = txs.flatMap((t) => pumpCreates(t)).filter((c) => c.user === creator);
  const mints = [...new Set(creates.map((c) => c.mint).filter((m) => m && m !== mint))];
  if (missed && (!mints.length || missed * 2 > picked.length)) return null;
  let capped = sigs.length >= DEV_SIGS || ok.length > picked.length || missed > 0;
  // Some free RPCs keep only recent signature history. When every listed transaction was read, the launch of the
  // coin being scanned must be among them; if it is not, the list was cut short: the count is a floor ("N+"), and
  // with nothing found, "first launch" would be a guess.
  if (!capped && !creates.some((c) => c.mint === mint)) {
    if (!mints.length) return null;
    capped = true;
  }
  let graduated = 0;
  for (let i = 0; i < mints.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(mints.slice(i, i + 100).map((m) => bondingCurvePda(new PublicKey(m))));
    for (const info of infos) if (info?.data?.length >= 49 && PUMP_SDK.decodeBondingCurveNullable(info)?.complete) graduated++;
  }
  return { launches: mints.length, graduated, capped, examined: picked.length };
}

async function dexscreener(mint, symbol) {
  const [pairs, orders] = await Promise.all([json(`https://api.dexscreener.com/tokens/v1/solana/${mint}`), json(`https://api.dexscreener.com/orders/v1/solana/${mint}`)]);
  const list = Array.isArray(pairs) ? pairs : [];
  const top = list.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
  const profile = orders ? (orders.orders ?? []).find((o) => o.type === 'tokenProfile')?.status ?? 'none' : null;
  const sym = symbol || top?.baseToken?.symbol;
  let clones = null;
  if (sym) {
    const found = await json(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`);
    if (found?.pairs) clones = new Set(found.pairs.filter((p) => p.chainId === 'solana' && p.baseToken?.symbol?.toLowerCase() === sym.toLowerCase() && p.baseToken.address !== mint).map((p) => p.baseToken.address)).size;
  }
  return { top, profile, clones };
}

/** `rpc` is unused since the move off Helius; it stays so the call sites keep their shape. */
export async function scanToken(conn, rpc, mintText) {
  let mint;
  try {
    mint = new PublicKey(mintText);
  } catch {
    throw new LaunchError(400, 'that is not a Solana address');
  }
  const account = (await conn.getParsedAccountInfo(mint, 'confirmed')).value;
  const parsed = account?.data?.parsed;
  if (!parsed || parsed.type !== 'mint') throw new LaunchError(404, 'no token at that address');
  const info = parsed.info;
  const meta = (info.extensions ?? []).find((e) => e.extension === 'tokenMetadata')?.state ?? {};
  const decimals = info.decimals;
  const supply = Number(info.supply) / 10 ** decimals;

  // pump.fun: the curve tells who created the coin and whether it has graduated.
  const curvePda = bondingCurvePda(mint);
  const poolPda = canonicalPumpPoolPda(mint);
  const curveInfo = await conn.getAccountInfo(curvePda, 'confirmed');
  const curve = curveInfo?.data?.length >= 49 ? PUMP_SDK.decodeBondingCurveNullable(curveInfo) : null;
  let creator = curve?.creator?.toBase58() ?? null;
  // With fee sharing on, the curve names the sharing config; the config names the wallet that set it up.
  let split = null;
  if (creator && creator === feeSharingConfigPda(mint).toBase58()) {
    const cfgInfo = await conn.getAccountInfo(feeSharingConfigPda(mint), 'confirmed');
    const cfg = cfgInfo ? (() => { try { return PUMP_SDK.decodeSharingConfig(cfgInfo); } catch { return null; } })() : null;
    creator = cfg?.admin?.toBase58() ?? null;
    split = cfg ? cfg.shareholders.map((h) => ({ address: h.address.toBase58(), share: h.shareBps / 100 })) : null;
  }
  const sharedFees = curve && !creator;
  let progress = null;
  if (curve && !curve.complete) {
    const { global } = await pumpGlobals(conn);
    const initial = Number(global.initialRealTokenReserves.toString());
    progress = initial > 0 ? round(100 - pct(Number(curve.realTokenReserves.toString()), initial)) : null;
  }

  // Holders: the 20 largest accounts, with the curve, the pool and the creator named.
  const largest = (await conn.getTokenLargestAccounts(mint, 'confirmed').catch(() => null))?.value ?? null;
  let holders = null;
  if (largest) {
    const owners = await conn.getMultipleParsedAccounts(largest.map((a) => a.address), { commitment: 'confirmed' });
    const named = { [curvePda.toBase58()]: 'pump.fun curve', [poolPda.toBase58()]: 'PumpSwap pool' };
    holders = largest.map((a, i) => {
      const owner = owners.value[i]?.data?.parsed?.info?.owner ?? null;
      const amount = Number(a.uiAmount ?? 0);
      return { owner, share: round(pct(amount, supply), 2), label: named[owner] ?? (owner && owner === creator ? 'dev' : null) };
    });
  }
  const people = holders?.filter((h) => !['pump.fun curve', 'PumpSwap pool'].includes(h.label)) ?? null;
  const top10 = people ? round(people.slice(0, 10).reduce((s, h) => s + h.share, 0)) : null;
  let devShare = null;
  if (creator && !sharedFees) {
    const fromTop = holders?.find((h) => h.owner === creator);
    if (fromTop) devShare = fromTop.share;
    else {
      const accs = await conn.getParsedTokenAccountsByOwner(new PublicKey(creator), { mint }, 'confirmed').catch(() => null);
      if (accs) devShare = round(pct(accs.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0), supply), 2);
    }
  }

  const [dex, history] = await Promise.all([dexscreener(mint.toBase58(), meta.symbol), creator && !sharedFees ? devHistory(conn, creator, mint.toBase58()).catch(() => null) : null]);
  const pair = dex.top;
  const socials = [...(pair?.info?.websites ?? []).map((w) => w.url), ...(pair?.info?.socials ?? []).map((s) => s.url)].filter(Boolean);
  const ageHours = pair?.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : null;

  // --- checks ------------------------------------------------------------------------------------------------------
  const checks = [];
  const add = (id, label, status, detail, weight = 0) => checks.push({ id, label, status, detail, weight });
  add('mint', 'Mint authority', info.mintAuthority ? 'fail' : 'pass', info.mintAuthority ? 'Active: more of this coin can be printed' : 'Revoked: supply is fixed', info.mintAuthority ? 30 : 0);
  add('freeze', 'Freeze authority', info.freezeAuthority ? 'fail' : 'pass', info.freezeAuthority ? 'Active: holders can be frozen' : 'Revoked: nobody can freeze holders', info.freezeAuthority ? 25 : 0);
  if (top10 === null) add('holders', 'Top 10 holders', 'unknown', 'Could not read the largest holders');
  else add('holders', 'Top 10 holders', top10 > 50 ? 'fail' : top10 > 30 ? 'warn' : 'pass', `${top10}% of supply, not counting the curve or pool`, top10 > 50 ? 20 : top10 > 30 ? 10 : 0);
  if (sharedFees) add('dev', 'Dev wallet', 'unknown', 'Could not read who set up the fee sharing');
  else if (devShare === null) add('dev', 'Dev wallet', 'unknown', creator ? 'Could not read the dev balance' : 'Not a pump.fun coin: no creator on record');
  else add('dev', 'Dev wallet', devShare > 10 ? 'fail' : devShare > 5 ? 'warn' : 'pass', `Dev holds ${devShare}%`, devShare > 10 ? 15 : devShare > 5 ? 7 : 0);
  if (history) {
    const rate = history.launches ? history.graduated / history.launches : null;
    const many = history.launches >= 10;
    add('history', 'Dev history', many && rate < 0.05 ? 'warn' : 'pass', history.launches ? `${history.launches}${history.capped ? '+' : ''} earlier pump.fun launch${history.launches === 1 ? '' : 'es'}, ${history.graduated} graduated` : history.capped ? `No earlier pump.fun launch in the wallet's last ${history.examined} transactions` : 'First pump.fun launch from this wallet', many && rate < 0.05 ? 10 : 0);
  } else add('history', 'Dev history', 'unknown', creator ? 'Could not read earlier launches' : 'No pump.fun creator on record');
  if (curve && !curve.complete) add('stage', 'Stage', 'info', `On the pump.fun curve, ${progress ?? '?'}% to graduation`);
  else if (pair) {
    const liq = pair.liquidity?.usd ?? 0;
    add('stage', 'Liquidity', liq < 5_000 ? 'warn' : 'pass', `$${Math.round(liq).toLocaleString('en-US')} in the ${pair.dexId} pool`, liq < 5_000 ? 10 : 0);
  } else add('stage', 'Market', 'unknown', 'No pool or curve found');
  add('dex', 'DexScreener profile', dex.profile === 'approved' ? 'pass' : dex.profile === null ? 'unknown' : 'info', dex.profile === 'approved' ? 'Paid and approved' : dex.profile === null ? 'Could not check' : dex.profile === 'none' ? 'Not paid' : `Order ${dex.profile}`);
  add('socials', 'Links', socials.length ? 'pass' : 'warn', socials.length ? `${socials.length} link${socials.length > 1 ? 's' : ''} on DexScreener` : 'No website or socials listed', socials.length ? 0 : 5);
  if (dex.clones === null) add('clones', 'Ticker clones', 'unknown', 'Could not search the ticker');
  else add('clones', 'Ticker clones', dex.clones > 5 ? 'warn' : 'pass', dex.clones ? `${dex.clones} other Solana coin${dex.clones > 1 ? 's' : ''} use this ticker` : 'No other coin uses this ticker', dex.clones > 5 ? 5 : 0);
  if (ageHours !== null && ageHours < 1) add('age', 'Age', 'warn', 'Less than an hour old', 5);

  const unknown = checks.filter((c) => c.status === 'unknown').length;
  const score = Math.max(0, 100 - checks.reduce((s, c) => s + c.weight, 0));
  return {
    mint: mint.toBase58(),
    name: meta.name ?? pair?.baseToken?.name ?? null,
    symbol: meta.symbol ?? pair?.baseToken?.symbol ?? null,
    image: pair?.info?.imageUrl ?? null,
    metadataUri: meta.uri ?? null,
    program: account.owner.toBase58(),
    pump: Boolean(curve),
    graduated: curve ? Boolean(curve.complete) : null,
    progress,
    creator: sharedFees ? null : creator,
    feeSplit: split,
    market: pair ? { dex: pair.dexId, priceUsd: Number(pair.priceUsd) || null, marketCap: pair.marketCap ?? pair.fdv ?? null, liquidityUsd: pair.liquidity?.usd ?? null, volume24h: pair.volume?.h24 ?? null, change24h: pair.priceChange?.h24 ?? null, ageHours: ageHours === null ? null : round(ageHours), url: pair.url } : null,
    holders: holders?.slice(0, 10) ?? null,
    socials,
    score,
    unknown,
    checks: checks.map(({ weight, ...c }) => c),
    at: new Date().toISOString(),
  };
}
