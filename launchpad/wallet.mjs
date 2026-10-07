import { PublicKey } from '@solana/web3.js';
import { LaunchError } from './launch.mjs';

/**
 * "Am I exit liquidity?": the coins a wallet holds, valued with DexScreener prices, largest first. The page then scans
 * and X-rays each one. Reads public balances only: no wallet connection, no signature.
 */
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
// Not memecoins: stables and wrapped majors are left out of the verdict.
const SKIP = new Set([
  'So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj',
  'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
]);
const MIN_USD = 1;

export async function walletHoldings(conn, address, { limit = 10 } = {}) {
  let owner;
  try { owner = new PublicKey(address); } catch { throw new LaunchError(400, 'that is not a Solana wallet address'); }
  if (!PublicKey.isOnCurve(owner.toBytes())) throw new LaunchError(400, 'that looks like a token or program, not a wallet; paste a wallet address');
  const [a, b] = await Promise.all([TOKEN, TOKEN_2022].map((programId) => conn.getParsedTokenAccountsByOwner(owner, { programId }, 'confirmed').then((r) => r.value).catch(() => [])));
  const amounts = new Map();
  for (const acc of [...a, ...b]) {
    const i = acc.account.data.parsed.info;
    const n = Number(i.tokenAmount.uiAmount ?? 0);
    if (n > 0 && !SKIP.has(i.mint)) amounts.set(i.mint, (amounts.get(i.mint) ?? 0) + n);
  }
  const mints = [...amounts.keys()];
  const prices = new Map();
  for (let i = 0; i < mints.length && i < 300; i += 30) {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const pairs = res?.ok ? await res.json().catch(() => []) : [];
    for (const p of Array.isArray(pairs) ? pairs : []) {
      const m = p.baseToken?.address, liq = p.liquidity?.usd ?? 0;
      if (m && Number(p.priceUsd) > 0 && liq >= (prices.get(m)?.liq ?? -1)) prices.set(m, { price: Number(p.priceUsd), liq, symbol: p.baseToken.symbol, name: p.baseToken.name, image: p.info?.imageUrl ?? null });
    }
  }
  const coins = mints
    .map((m) => ({ mint: m, amount: amounts.get(m), ...(prices.get(m) ?? {}) }))
    .map((c) => ({ ...c, usd: c.price ? c.amount * c.price : 0 }))
    .filter((c) => c.usd >= MIN_USD)
    .sort((x, y) => y.usd - x.usd);
  return {
    wallet: owner.toBase58(),
    tokens: amounts.size,
    priced: coins.length,
    totalUsd: coins.reduce((s, c) => s + c.usd, 0),
    coins: coins.slice(0, limit).map(({ mint, symbol, name, image, amount, usd }) => ({ mint, symbol, name, image, amount, usd })),
    more: Math.max(0, coins.length - limit),
  };
}
