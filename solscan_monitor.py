import json
import math
import threading
import time
from contextlib import contextmanager
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from onchain import solana_supplies


class SolscanClient:
    def __init__(self, key):
        self.key = key

    def get(self, endpoint, **params):
        if not self.key:
            raise ValueError('Connect Solscan in Settings before monitoring')
        request = Request('https://pro-api.solscan.io/v2.0/' + endpoint + '?' + urlencode(params), headers={'token': self.key, 'Accept': 'application/json', 'User-Agent': 'GemSearch'})
        try:
            with urlopen(request, timeout=8) as response:
                raw = response.read(2000001)
        except HTTPError as error:
            raise ValueError({401: 'Solscan rejected the API key', 403: 'Solscan endpoint access is not enabled for this account', 429: 'Solscan rate limit reached; retrying next minute'}.get(error.code, 'Solscan request failed (' + str(error.code) + ')')) from None
        if len(raw) > 2000000:
            raise ValueError('Solscan response exceeds limit')
        result = json.loads(raw)
        if result.get('success') is not True:
            raise ValueError('Solscan returned an unsuccessful response')
        return result['data']


def metadata_fields(data, captured):
    if not isinstance(data, dict) or not isinstance(data.get('address'), str):
        raise ValueError('Invalid Solscan token metadata')
    fields = {'name': data.get('name') or data.get('symbol') or data['address'], 'data_source': 'Solscan', 'market_cap_source': 'Solscan', 'market_cap_updated_at': captured, 'price_source': 'Solscan', 'price_sampled_at': captured, 'market_cap_usd': None, 'price_usd': None, 'token_created_at': None, 'net_inflow_m5_usd': None, 'flow_updated_at': None, 'verification_status': 'Pending mint verification', 'onchain_valuation_usd': None, 'onchain_supply': None, 'onchain_slot': None, 'onchain_supply_sampled_at': None, 'solscan_supply': data.get('supply'), 'solscan_decimals': data.get('decimals')}
    for source, target in [('market_cap', 'market_cap_usd'), ('price', 'price_usd'), ('created_time', 'token_created_at')]:
        value = data.get(source)
        if type(value) in (int, float) and math.isfinite(value) and value > 0:
            fields[target] = value
    return fields


class SolscanMonitor:
    def __init__(self, alerts, observer=None, watchlist=None, tracked=None, key='', client=None):
        self.alerts = alerts
        self.observer = observer
        self.watchlist = watchlist
        self.tracked = tracked
        self.client = client or SolscanClient(key)
        self.lock = threading.Lock()
        self.enabled = False
        self.expires = None
        self.generation = 0
        self.last_poll = 0
        self.offset = 0
        self.error = None if self.client.key else 'Connect Solscan in Settings before monitoring'
        self.checked = self.skipped = 0
        self.valuation_error = None

    def set_key(self, key):
        with self.lock:
            self.client = SolscanClient(key)
            self.generation += 1
            self.last_poll = 0
            self.error = None if key else 'Connect Solscan in Settings before monitoring'

    def control(self, enabled, minutes=0):
        if type(enabled) is not bool or type(minutes) is not int or not 0 <= minutes <= 1440:
            raise ValueError('Invalid monitor duration')
        with self.lock:
            self.enabled = enabled and bool(self.client.key)
            self.expires = time.time() + minutes * 60 if self.enabled and minutes else None
            self.generation += 1
        return self.status()

    @contextmanager
    def alert_gate(self, generation):
        with self.lock:
            yield self.enabled and generation == self.generation and (not self.expires or time.time() < self.expires)

    def active(self, generation):
        with self.alert_gate(generation) as allowed:
            return allowed

    def status(self):
        with self.lock:
            if self.expires and time.time() >= self.expires:
                self.enabled = False
            return {'enabled': self.enabled, 'expires_at': self.expires, 'error': self.error, 'checked': self.checked, 'skipped': self.skipped, 'coverage': 'Solscan sampled Solana discovery and metadata; blockchain mint verification', 'market_cap_rule': 'Solscan market cap and token creation timestamp', 'valuation_error': self.valuation_error}

    def poll(self):
        state = self.status()
        if not state['enabled'] or time.monotonic() - self.last_poll < 60:
            return
        with self.lock:
            generation, client = self.generation, self.client
            self.last_poll = time.monotonic()
        self.checked = self.skipped = 0
        self.error = self.valuation_error = None
        try:
            latest = client.get('token/latest', page=1, page_size=20)
            if not isinstance(latest, list):
                raise ValueError('Invalid Solscan discovery response')
            records = {item['address']: item for item in latest if isinstance(item, dict) and isinstance(item.get('address'), str)}
            watched = [address for chain, address in (self.watchlist() if self.watchlist else []) if chain == 'solana']
            tracked = [item['address'] for item in (self.tracked() if self.tracked else []) if item.get('data_source') == 'Solscan']
            extra = list(dict.fromkeys(watched + tracked[self.offset:self.offset + 20]))
            self.offset = (self.offset + 20) % max(1, len(tracked))
            for address in extra:
                if not self.active(generation):
                    return
                item = client.get('token/meta', address=address)
                if not isinstance(item, dict) or item.get('address') != address:
                    raise ValueError('Solscan metadata address mismatch')
                records[address] = item
            if not self.active(generation):
                return
            samples = {}
            try:
                samples = solana_supplies(list(records))
            except Exception as error:
                self.valuation_error = 'Blockchain verification unavailable: ' + type(error).__name__
            captured = time.time()
            for address, item in records.items():
                if not self.active(generation):
                    return
                fields = metadata_fields(item, captured)
                sample = samples.get(address)
                if sample:
                    fields.update(sample)
                    if type(item.get('decimals')) is int and item['decimals'] == sample['onchain_decimals']:
                        fields['verification_status'] = 'Mint and decimals confirmed; price and market cap from Solscan'
                    else:
                        fields['verification_status'] = 'Solscan decimals differ from confirmed mint; alert withheld'
                else:
                    fields['verification_status'] = 'Mint verification unavailable; alert withheld'
                self.observer('solana', address, fields)
                if sample and type(item.get('decimals')) is int and item['decimals'] == sample['onchain_decimals']:
                    self.alerts.evaluate('solana', address, {'market_cap_usd': fields['market_cap_usd'], 'token_created_at': fields['token_created_at'], 'source': 'Solscan; independent confirmed mint verification', 'creation_source': 'Solscan'}, captured, gate=lambda: self.alert_gate(generation))
                self.skipped += 1
        except Exception as error:
            self.error = str(error) if isinstance(error, ValueError) else 'Solscan unavailable: ' + type(error).__name__
