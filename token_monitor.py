import json
import math
import threading
import time
from datetime import datetime
from urllib.request import Request, urlopen
from urllib.parse import quote
from contextlib import contextmanager
from onchain import solana_supplies, supply_valuation


def get_json(path):
    with urlopen(Request('https://api.geckoterminal.com/api/v2/' + path, headers={'Accept': 'application/json', 'User-Agent': 'GemSearch/0.3'}), timeout=15) as response:
        raw = response.read(2000001)
    if len(raw) > 2000000:
        raise ValueError('Response exceeds limit')
    return json.loads(raw)


def net_swaps(trades, captured):
    if not isinstance(trades, list):
        return None
    total = 0
    timestamps = []
    seen = set()
    for trade in trades:
        fields = trade.get('attributes', {})
        try:
            stamp = datetime.fromisoformat(fields['block_timestamp'].replace('Z', '+00:00')).timestamp()
            amount = float(fields['volume_in_usd'])
            kind = fields['kind']
            identity = trade['id']
            if not math.isfinite(amount) or amount < 0 or kind not in ('buy', 'sell') or stamp > captured + 5:
                return None
        except (KeyError, ValueError, TypeError):
            return None
        timestamps.append(stamp)
        if captured - 300 <= stamp <= captured and identity not in seen:
            total += amount if kind == 'buy' else -amount
            seen.add(identity)
    if len(trades) >= 300 and (not timestamps or min(timestamps) > captured - 300):
        return None
    return total


def dex_market_caps(network, addresses):
    chain = {'eth': 'ethereum', 'polygon_pos': 'polygon', 'avax': 'avalanche'}.get(network, network)
    url = 'https://api.dexscreener.com/tokens/v1/' + quote(chain, safe='') + '/' + ','.join(quote(address, safe='') for address in addresses[:30])
    with urlopen(Request(url, headers={'Accept': 'application/json', 'User-Agent': 'GemSearch/0.4.1'}), timeout=8) as response:
        raw = response.read(2000001)
    if len(raw) > 2000000:
        raise ValueError('Response exceeds limit')
    return select_market_caps(json.loads(raw), chain, addresses)


def select_market_caps(pairs, chain, addresses):
    selected = {}
    for pair in pairs:
        address = pair.get('baseToken', {}).get('address')
        cap = pair.get('marketCap')
        if pair.get('chainId') != chain or address not in addresses:
            continue
        liquidity = (pair.get('liquidity') or {}).get('usd') or 0
        if type(liquidity) not in (int, float) or not math.isfinite(liquidity):
            liquidity = 0
        if address not in selected or liquidity > selected[address][0]:
            fields = {}
            if type(cap) in (int, float) and math.isfinite(cap) and cap > 0:
                fields.update(market_cap_usd=cap, market_cap_source='DexScreener', market_cap_updated_at=time.time())
            try:
                price = float(pair.get('priceUsd'))
            except (ValueError, TypeError):
                price = 0
            if math.isfinite(price) and price > 0:
                fields.update(price_usd=str(pair['priceUsd']), price_source='DexScreener', price_sampled_at=time.time(), price_pool_address=pair.get('pairAddress'), price_liquidity_usd=liquidity if liquidity > 0 else None)
            if fields:
                selected[address] = (liquidity, fields)
    return {address: fields for address, (_, fields) in selected.items()}


class TokenMonitor:
    def __init__(self, alerts, observer=None, watchlist=None, tracked=None):
        self.alerts = alerts
        self.observer = observer
        self.watchlist = watchlist
        self.tracked = tracked
        self.quote_offset = 0
        self.valuation_error = None
        self.lock = threading.Lock()
        self.enabled = False
        self.expires = None
        self.generation = 0
        self.last_poll = 0
        self.error = None
        self.checked = 0
        self.skipped = 0

    def control(self, enabled, minutes=0):
        if type(enabled) is not bool or type(minutes) is not int or not 0 <= minutes <= 1440:
            raise ValueError('Invalid alert monitor duration')
        with self.lock:
            self.enabled = enabled
            self.expires = time.time() + minutes * 60 if enabled and minutes else None
            self.generation += 1
        return self.status()

    @contextmanager
    def alert_gate(self, generation):
        with self.lock:
            yield self.enabled and generation == self.generation and (not self.expires or time.time() < self.expires)

    def status(self):
        with self.lock:
            if self.expires and time.time() >= self.expires:
                self.enabled = False
            return {'enabled': self.enabled, 'expires_at': self.expires, 'error': self.error, 'checked': self.checked, 'skipped': self.skipped,
                    'coverage': 'Latest new pools across GeckoTerminal networks; sampled discovery, not every token or chain',
                    'market_cap_rule': 'Waiting for a token creation timestamp provider; pool creation time is not used', 'valuation_error': self.valuation_error}

    def poll(self):
        state = self.status()
        if not state['enabled'] or time.monotonic() - self.last_poll < 60:
            return
        self.last_poll = time.monotonic()
        generation = self.generation
        self.checked = self.skipped = 0
        try:
            pools = get_json('networks/new_pools?include=base_token,network')['data']
            candidates = {}
            missing_caps = {}
            for pool in pools[:20]:
                attr = pool['attributes']
                volume = float(attr.get('volume_usd', {}).get('m5', 0))
                network = pool['relationships']['network']['data']['id']
                token_id = pool['relationships']['base_token']['data']['id']
                address = token_id.removeprefix(network + '_')
                if self.observer:
                    fields = {'name': attr.get('name', address).split(' / ')[0], 'price_usd': attr.get('base_token_price_usd'), 'volume_m5_usd': volume, 'pool_created_at': attr.get('pool_created_at'), 'updated_at': time.time()}
                    try:
                        cap = float(attr.get('market_cap_usd'))
                    except (TypeError, ValueError):
                        cap = 0
                    if math.isfinite(cap) and cap > 0:
                        fields.update(market_cap_usd=cap, market_cap_source='GeckoTerminal', market_cap_updated_at=time.time())
                    else:
                        missing_caps.setdefault(network, []).append(address)
                    self.observer(network, address, fields)
                    if address not in missing_caps.setdefault(network, []):
                        missing_caps[network].append(address)
                candidates[(network, address)] = volume
            if self.watchlist:
                for network, address in self.watchlist():
                    candidates[(network, address)] = float('inf')
                    if address not in missing_caps.setdefault(network, []):
                        missing_caps[network].append(address)
            if self.observer:
                if self.tracked:
                    tracked = sorted({(row['chain'], row['address']) for row in self.tracked()})
                    if tracked:
                        for index in range(min(20, len(tracked))):
                            network, address = tracked[(self.quote_offset + index) % len(tracked)]
                            if address not in missing_caps.setdefault(network, []):
                                missing_caps[network].append(address)
                        self.quote_offset = (self.quote_offset + 20) % len(tracked)
                quotes = {}
                self.valuation_error = None
                for network, addresses in list(missing_caps.items())[:20]:
                    if not self.status()['enabled'] or generation != self.generation:
                        return
                    try:
                        for offset in range(0, len(addresses), 30):
                            for address, fields in dex_market_caps(network, addresses[offset:offset + 30]).items():
                                if self.status()['enabled'] and generation == self.generation:
                                    self.observer(network, address, fields)
                                    if network == 'solana':
                                        quotes[address] = fields
                    except (OSError, ValueError, TypeError):
                        self.valuation_error = 'Quote refresh delayed; check sample ages'
                if quotes and self.status()['enabled'] and generation == self.generation:
                    try:
                        for address, supply in solana_supplies(list(quotes)).items():
                            if self.status()['enabled'] and generation == self.generation:
                                self.observer('solana', address, supply_valuation(supply, quotes[address]))
                    except (OSError, ValueError, TypeError):
                        self.valuation_error = 'Solana supply refresh unavailable; check sample ages'
            with self.alerts.connect() as con:
                for row in con.execute("SELECT chain,address FROM token_alert_state WHERE rule='net_inflow_100k_5m' AND active=1"):
                    candidates.setdefault((row[0], row[1]), 100001)
            budget = 28
            for (network, address), volume in sorted(candidates.items(), key=lambda item: item[1], reverse=True):
                if not self.status()['enabled'] or generation != self.generation or budget < 2:
                    break
                token_pools = get_json('networks/' + quote(network, safe='') + '/tokens/' + quote(address, safe='') + '/pools')['data']
                budget -= 1
                if not token_pools or len(token_pools) >= 20 or len(token_pools) > budget:
                    self.skipped += 1
                    continue
                total = 0
                complete = True
                captured = time.time()
                for pool in token_pools:
                    if pool['relationships']['base_token']['data']['id'] != network + '_' + address:
                        complete = False
                        break
                    trades = get_json('networks/' + quote(network, safe='') + '/pools/' + quote(pool['attributes']['address'], safe='') + '/trades')['data']
                    budget -= 1
                    amount = net_swaps(trades, captured)
                    if amount is None:
                        complete = False
                        break
                    total += amount
                with self.lock:
                    if not self.enabled or generation != self.generation or self.expires and time.time() >= self.expires:
                        break
                if time.time() - captured > 60:
                    complete = False
                if complete:
                    if self.observer:
                        self.observer(network, address, {'net_inflow_m5_usd': total, 'flow_updated_at': captured})
                    self.alerts.evaluate(network, address, {'net_inflow_m5_usd': total, 'source': 'GeckoTerminal indexed token pools'}, captured, gate=lambda: self.alert_gate(generation))
                    self.checked += 1
                else:
                    self.skipped += 1
            self.error = None
        except Exception as exc:
            self.error = 'Discovery unavailable: ' + type(exc).__name__
