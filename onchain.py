import json
import math
import re
import time
from decimal import Decimal, InvalidOperation
from urllib.request import Request, urlopen


def solana_supplies(addresses):
    addresses = list(dict.fromkeys(address for address in addresses if re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}', address)))[:100]
    if not addresses:
        return {}
    body = {'jsonrpc': '2.0', 'id': 1, 'method': 'getMultipleAccounts', 'params': [addresses, {'encoding': 'jsonParsed', 'commitment': 'confirmed'}]}
    request = Request('https://api.mainnet-beta.solana.com', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'User-Agent': 'GemSearch'})
    with urlopen(request, timeout=8) as response:
        raw = response.read(2000001)
    if len(raw) > 2000000:
        raise ValueError('Response exceeds limit')
    return parse_supplies(json.loads(raw), addresses)


def parse_supplies(response, addresses):
    result = response.get('result', {})
    if not isinstance(result, dict):
        raise ValueError('Invalid RPC result')
    accounts = result.get('value')
    slot = result.get('context', {}).get('slot')
    if not isinstance(accounts, list) or len(accounts) != len(addresses) or type(slot) is not int or slot < 0:
        raise ValueError('Invalid RPC account response')
    samples = {}
    for address, account in zip(addresses, accounts):
        if not isinstance(account, dict):
            continue
        parsed = (account.get('data') or {}).get('parsed', {}) if isinstance(account.get('data'), dict) else {}
        info = parsed.get('info', {})
        amount, decimals = info.get('supply'), info.get('decimals')
        if parsed.get('type') != 'mint' or info.get('isInitialized') is not True or not isinstance(amount, str) or not amount.isdigit() or type(decimals) is not int or not 0 <= decimals <= 255:
            continue
        if int(amount) > 2 ** 64 - 1:
            continue
        supply = Decimal(amount).scaleb(-decimals)
        samples[address] = {'onchain_supply': str(supply), 'onchain_supply_raw': amount, 'onchain_decimals': decimals, 'onchain_slot': slot, 'onchain_supply_sampled_at': time.time(), 'onchain_supply_source': 'Solana RPC · confirmed'}
    return samples


def supply_valuation(supply, quote):
    fields = dict(supply)
    try:
        amount = Decimal(supply['onchain_supply'])
        price = Decimal(str(quote.get('price_usd')))
        value = amount * price
        if not amount.is_finite() or not price.is_finite() or amount <= 0 or price <= 0 or not math.isfinite(float(value)):
            return fields
    except (KeyError, InvalidOperation, ValueError, TypeError, OverflowError):
        return fields
    fields.update(onchain_valuation_usd=float(value), onchain_valuation_sampled_at=time.time(), onchain_price_usd=str(price), onchain_price_source=quote.get('price_source'), onchain_price_sampled_at=quote.get('price_sampled_at'), onchain_price_pool=quote.get('price_pool_address'), onchain_price_liquidity_usd=quote.get('price_liquidity_usd'), onchain_valuation_method='Current minted supply multiplied by pool USD price; not verified circulating market cap')
    return fields
