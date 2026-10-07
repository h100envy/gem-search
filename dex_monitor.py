import json
import math
import re
import time
from types import SimpleNamespace
from urllib.request import Request, urlopen
from solscan_monitor import SolscanMonitor
from onchain import solana_supplies
from market_metrics import metric


def request(path):
    req = Request('https://api.dexscreener.com/' + path, headers={'Accept': 'application/json', 'User-Agent': 'GemSearch/0.7'})
    with urlopen(req, timeout=8) as response:
        raw = response.read(2000001)
    if len(raw) > 2000000:
        raise ValueError('Market response exceeds limit')
    return json.loads(raw)


def select_pairs(pairs, addresses, captured):
    if not isinstance(pairs, list):
        raise ValueError('Invalid market response')
    selected = {}
    for pair in pairs:
        if not isinstance(pair, dict) or pair.get('chainId') != 'solana':
            continue
        base = pair.get('baseToken') or {}
        address = base.get('address')
        if address not in addresses or not isinstance(pair.get('pairAddress'), str):
            continue
        liquidity = metric((pair.get('liquidity') or {}).get('usd'))
        if address in selected and (liquidity or 0) <= (selected[address]['liquidity_usd'] or 0):
            continue
        try:
            price = float(pair.get('priceUsd'))
        except (TypeError, ValueError, OverflowError):
            price = None
        if price is not None and (not math.isfinite(price) or price <= 0):
            price = None
        volume = pair.get('volume') or {}
        txns = (pair.get('txns') or {}).get('m5') or {}
        selected[address] = {'name': base.get('name') or base.get('symbol') or address, 'data_source': 'DexScreener', 'market_cap_source': 'DexScreener', 'market_cap_usd': metric(pair.get('marketCap')), 'market_cap_updated_at': captured, 'price_usd': price, 'price_source': 'DexScreener', 'price_sampled_at': captured, 'liquidity_usd': liquidity, 'volume_m5_usd': metric(volume.get('m5')), 'volume_h24_usd': metric(volume.get('h24')), 'volume_m1_usd': None, 'buy_count_m5': metric(txns.get('buys')), 'sell_count_m5': metric(txns.get('sells')), 'statistics_sampled_at': captured, 'market_pair': pair['pairAddress'], 'pair_created_at': metric(pair.get('pairCreatedAt')), 'token_created_at': None, 'net_inflow_m5_usd': None, 'flow_updated_at': None, 'flow_method': None, 'verification_status': 'Pending mint verification', 'onchain_supply_sampled_at': None}
    for address, fields in selected.items():
        pair = next(pair for pair in pairs if isinstance(pair, dict) and pair.get('chainId') == 'solana' and pair.get('pairAddress') == fields['market_pair'] and (pair.get('baseToken') or {}).get('address') == address)
        fields['dex_id'] = str(pair.get('dexId') or '')
        fields['fdv_usd'] = metric(pair.get('fdv'))
        fields['pair_labels'] = [str(label) for label in pair.get('labels', [])] if isinstance(pair.get('labels'), list) else []
        fields['active_boosts'] = metric((pair.get('boosts') or {}).get('active'))
        for window in ['m5', 'h1', 'h6', 'h24']:
            activity = (pair.get('txns') or {}).get(window) or {}
            buys, sells = metric(activity.get('buys')), metric(activity.get('sells'))
            fields['buy_count_' + window] = buys
            fields['sell_count_' + window] = sells
            fields['transaction_count_' + window] = buys + sells if buys is not None and sells is not None else None
            fields['volume_' + window + '_usd'] = metric((pair.get('volume') or {}).get(window))
            change = (pair.get('priceChange') or {}).get(window)
            fields['price_change_' + window + '_pct'] = change if type(change) in (int, float) and math.isfinite(change) else None
    return selected


class DexMonitor(SolscanMonitor):
    def __init__(self, alerts, observer=None, watchlist=None, tracked=None, key=''):
        super().__init__(alerts, observer, watchlist, tracked, client=SimpleNamespace(key='public-feed'))
        self.discovery_at = 0
        self.discovered = []
        self.rotation = 0
        self.flow_error = 'Net flow requires USD buy and sell totals; this feed supplies volume and trade counts.'

    def set_key(self, key):
        with self.lock:
            self.generation += 1

    def status(self):
        state = super().status()
        state['coverage'] = 'Solana profiles, boosted entries, saved and watched tokens; incomplete market coverage'
        state['refresh_seconds'] = 15
        state['market_cap_rule'] = 'Reported market capitalization; mint verification does not verify USD valuation'
        return state

    def poll(self):
        if not self.status()['enabled'] or time.monotonic() - self.last_poll < 15:
            return
        with self.lock:
            generation = self.generation
            self.last_poll = time.monotonic()
        self.error = self.valuation_error = None
        self.checked = self.skipped = 0
        previous = {row['address']: row for row in (self.tracked() if self.tracked else []) if row.get('chain') == 'solana'}
        if time.monotonic() - self.discovery_at >= 60:
            discovered = []
            try:
                for path in ['token-profiles/latest/v1', 'token-boosts/top/v1']:
                    rows = request(path)
                    if not isinstance(rows, list):
                        raise ValueError('Invalid discovery response')
                    discovered.extend(row['tokenAddress'] for row in rows if isinstance(row, dict) and row.get('chainId') == 'solana' and isinstance(row.get('tokenAddress'), str))
                self.discovered = list(dict.fromkeys(discovered))
                self.discovery_at = time.monotonic()
                self.ranking_error = None
            except (ValueError, OSError) as error:
                self.ranking_error = 'Discovery delayed: ' + type(error).__name__
        watched = [address for chain, address in (self.watchlist() if self.watchlist else []) if chain == 'solana']
        priority = list(dict.fromkeys(watched + self.discovered))
        remaining = [address for address in previous if address not in priority]
        offset = self.rotation % max(1, len(remaining))
        ordered = list(dict.fromkeys(priority + remaining[offset:] + remaining[:offset]))
        self.rotation += max(1, 300 - len(priority))
        ordered = [a for a in ordered if re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}', a)]
        records = {}
        for start in range(0, min(len(ordered), 300), 30):
            if not self.active(generation):
                return
            addresses = ordered[start:start + 30]
            try:
                records.update(select_pairs(request('tokens/v1/solana/' + ','.join(addresses)), set(addresses), time.time()))
            except (ValueError, OSError) as error:
                self.error = 'Some quotes delayed: ' + type(error).__name__
        samples = {}
        addresses = list(records)
        for start in range(0, len(addresses), 100):
            if not self.active(generation):
                return
            try:
                samples.update(solana_supplies(addresses[start:start + 100]))
            except (ValueError, OSError) as error:
                self.valuation_error = 'Mint check delayed: ' + type(error).__name__
        for address, fields in records.items():
            if not self.active(generation):
                return
            sample = samples.get(address)
            if sample:
                fields.update(sample)
                fields['verification_status'] = 'Mint account confirmed; USD value not independently verified'
            self.observer('solana', address, fields)
            self.last_success_at = time.time()
            self.skipped += 1
