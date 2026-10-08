import json
import re
import time
from decimal import Decimal, localcontext
from urllib.request import Request, urlopen
from chains import EVM, address_key


def rpc(chain, calls):
    req = Request('https://' + EVM[chain][1] + '.publicnode.com', data=json.dumps(calls).encode(), headers={'Content-Type': 'application/json', 'User-Agent': 'GemSearch'})
    with urlopen(req, timeout=8) as response:
        raw = response.read(2000001)
    if len(raw) > 2000000:
        raise ValueError('RPC response exceeds limit')
    rows = json.loads(raw)
    if not isinstance(rows, list):
        raise ValueError('Invalid RPC batch')
    results = {}
    for row in rows:
        if isinstance(row, dict) and type(row.get('id')) is int and 'error' not in row:
            if row['id'] in results:
                raise ValueError('Duplicate RPC response')
            results[row['id']] = row.get('result')
    return results


def word(value):
    return int(value, 16) if isinstance(value, str) and re.fullmatch(r'0x[0-9a-fA-F]{64}', value) else None


def evm_supplies(chain, addresses):
    addresses = list(dict.fromkeys(key[1] for address in addresses if (key := address_key(chain, address))))[:20]
    if not addresses:
        return {}
    context = rpc(chain, [{'jsonrpc': '2.0', 'id': 1, 'method': 'eth_chainId', 'params': []}, {'jsonrpc': '2.0', 'id': 2, 'method': 'eth_blockNumber', 'params': []}])
    if context.get(1) != hex(EVM[chain][0]) or not isinstance(context.get(2), str) or not re.fullmatch(r'0x[0-9a-fA-F]+', context[2]):
        raise ValueError('RPC network or block mismatch')
    block = context[2]
    calls = []
    for index, address in enumerate(addresses):
        calls.append({'jsonrpc': '2.0', 'id': index * 3, 'method': 'eth_getCode', 'params': [address, block]})
        for offset, selector in [(1, '0x18160ddd'), (2, '0x313ce567')]:
            calls.append({'jsonrpc': '2.0', 'id': index * 3 + offset, 'method': 'eth_call', 'params': [{'to': address, 'data': selector}, block]})
    return parse_evm(rpc(chain, calls), addresses, block)


def parse_evm(results, addresses, block):
    samples = {}
    for index, address in enumerate(addresses):
        code = results.get(index * 3)
        supply, decimals = word(results.get(index * 3 + 1)), word(results.get(index * 3 + 2))
        if not isinstance(code, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})+', code) or supply is None or decimals is None or decimals > 255:
            continue
        with localcontext() as context:
            context.prec = 100
            amount = str(Decimal(supply).scaleb(-decimals))
        samples[address] = {'onchain_supply_raw': str(supply), 'onchain_supply': amount, 'onchain_decimals': decimals, 'onchain_block': int(block, 16), 'onchain_supply_sampled_at': time.time(), 'verification_status': 'Token contract confirmed; USD value not independently verified'}
    return samples
