// pons V2 launch tx builder (Robinhood Chain, chainId 4663). Builds calldata only; never signs or sends.
// ABI source: Sourcify-verified PonsV2LaunchFactory / PonsV2LaunchAndBuy (trimmed copy in abi.json).
import { createPublicClient, http, defineChain, encodeFunctionData, decodeFunctionResult, parseEther,
  parseEventLogs, toHex, zeroAddress, getAddress } from 'viem';
import { readFileSync } from 'node:fs';

const ABI = JSON.parse(readFileSync(new URL('./pons-abi.json', import.meta.url)));
export const FACTORY_ABI = ABI.factory;
export const ROUTER_ABI = ABI.router;

export const robinhoodChain = defineChain({
  id: 4663, name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
});
export const PONS = {
  factory: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  router: '0xe33e9e479df8802cb0866d5d05258bec4cf62948', // PonsV2LaunchAndBuy, factory.launchForwarder
};
const LIMITS = { name: 64, symbol: 16, logo: 512, description: 2048, social: 256 }; // bytes, enforced by PonsV2LaunchDeployer

export function client(rpc = robinhoodChain.rpcUrls.default.http[0]) {
  return createPublicClient({ chain: robinhoodChain, transport: http(rpc) });
}

const bytes = (s) => new TextEncoder().encode(s).length;
function check(field, s, max) {
  if (bytes(s) > max) throw new Error(`${field} is ${bytes(s)} bytes, max ${max}`);
}

/** Live on-chain terms: launch fee (wei) and economics digest for config 0 / native ETH. */
export async function readTerms(pc = client(), launchConfigId = 0n) {
  const [launchFee, expectedEconomics, launchEnabled, maxCreatorTaxBps] = await Promise.all([
    pc.readContract({ address: PONS.factory, abi: FACTORY_ABI, functionName: 'launchFee' }),
    pc.readContract({ address: PONS.factory, abi: FACTORY_ABI, functionName: 'previewLaunchEconomics', args: [launchConfigId, zeroAddress] }),
    pc.readContract({ address: PONS.factory, abi: FACTORY_ABI, functionName: 'launchEnabled' }),
    pc.readContract({ address: PONS.factory, abi: FACTORY_ABI, functionName: 'maxCreatorTaxBps' }),
  ]);
  return { launchFee, expectedEconomics, launchEnabled, maxCreatorTaxBps };
}

/**
 * Build an ETH-quoted pons V2 launch.
 *  - devBuyEth == 0  -> factory.launchToken(params, configId, 0x0, exemptions)   value = launchFee
 *  - devBuyEth  > 0  -> router.launchAndBuy(params, configId, 0x0, quoteIn, minTokensOut, recipient, exemptions)
 *                       value = launchFee + quoteIn  (exact; router reverts NativeValueMismatch otherwise)
 * The tx MUST be sent by `creator` (the factory records msg.sender / router caller as deployer).
 * terms: { launchFee, expectedEconomics } from readTerms(); pass them in so the builder stays sync & pure.
 */
export function buildLaunchTx({
  creator, name, symbol, logo = '', description = '',
  twitter = '', telegram = '', discord = '', website = '', farcaster = '',
  feeRecipient, creatorTaxBps = 0, buybackEnabled = false,
  devBuyEth = '0', minTokensOut = 0n, devBuyRecipient,
  snipeTaxExemptions = [], salt, launchConfigId = 0n, terms,
}) {
  if (!terms?.launchFee && terms?.launchFee !== 0n) throw new Error('terms.launchFee required (readTerms())');
  creator = getAddress(creator);
  name = name.trim(); symbol = symbol.trim();
  if (!name || !symbol) throw new Error('name and symbol required');
  check('name', name, LIMITS.name); check('symbol', symbol, LIMITS.symbol);
  check('logo', logo, LIMITS.logo); check('description', description, LIMITS.description);
  const socials = { twitter, telegram, discord, website, farcaster };
  for (const [k, v] of Object.entries(socials)) check(k, v, LIMITS.social);
  if (!Number.isInteger(creatorTaxBps) || creatorTaxBps < 0 || creatorTaxBps > Number(terms.maxCreatorTaxBps ?? 1000))
    throw new Error('creatorTaxBps out of range');

  const params = {
    name, symbol, logo: logo.trim(), description: description.trim(), socials,
    creatorFeeRecipient: getAddress(feeRecipient ?? creator),
    creatorTaxBps, buybackEnabled,
    expectedEconomics: terms.expectedEconomics ?? `0x${'0'.repeat(64)}`, // pin; zero = no check
    salt: salt ?? toHex(crypto.getRandomValues(new Uint8Array(32))),    // same as pons UI: random 32 bytes
  };
  const quoteIn = typeof devBuyEth === 'bigint' ? devBuyEth : parseEther(String(devBuyEth));

  if (quoteIn === 0n) {
    return {
      to: PONS.factory, value: terms.launchFee, params,
      data: encodeFunctionData({ abi: FACTORY_ABI, functionName: 'launchToken',
        args: [params, launchConfigId, zeroAddress, snipeTaxExemptions] }),
    };
  }
  const recipient = getAddress(devBuyRecipient ?? creator);
  const ex = snipeTaxExemptions.filter((a) => a.toLowerCase() !== recipient.toLowerCase()).slice(0, 31);
  return {
    to: PONS.router, value: terms.launchFee + quoteIn, params,
    data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'launchAndBuy',
      args: [params, launchConfigId, zeroAddress, quoteIn, minTokensOut, recipient, ex] }),
  };
}

/** eth_call the tx as `from`; returns decoded {token, curve[, tokensOut]} or throws with revert reason. */
export async function simulate(tx, from, pc = client(), stateOverride) {
  const { data } = await pc.call({ account: from, to: tx.to, data: tx.data, value: tx.value, stateOverride });
  const isRouter = tx.to.toLowerCase() === PONS.router;
  const r = decodeFunctionResult({ abi: isRouter ? ROUTER_ABI : FACTORY_ABI,
    functionName: isRouter ? 'launchAndBuy' : 'launchToken', data });
  return isRouter ? { token: r[0], curve: r[1], tokensOut: r[2] } : { token: r[0], curve: r[1] };
}

/** pons UI approach to slippage: simulate with minTokensOut=0, then take tokensOut * (1 - bps). */
export async function quoteMinTokensOut(args, from, slippageBps = 200n, pc = client(), stateOverride) {
  const tx = buildLaunchTx({ ...args, minTokensOut: 0n });
  const { tokensOut } = await simulate(tx, from, pc, stateOverride);
  return { tokensOut, minTokensOut: (tokensOut * (10000n - slippageBps)) / 10000n, salt: tx.params.salt };
}

/** After the receipt: new token + curve from the factory's TokenLaunched event. */
export function parseLaunchReceipt(receipt) {
  const ev = parseEventLogs({ abi: FACTORY_ABI, eventName: 'TokenLaunched', logs: receipt.logs })
    .find((l) => l.address.toLowerCase() === PONS.factory);
  return ev ? { token: ev.args.token, curve: ev.args.curve, deployer: ev.args.deployer,
    graduationThreshold: ev.args.graduationThreshold } : null;
}
