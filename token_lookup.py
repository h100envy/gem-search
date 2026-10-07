import time
from urllib.parse import quote
from chains import CHAINS, address_key
from dex_monitor import request, select_pairs
from onchain import solana_supplies
from evm_onchain import evm_supplies


def lookup_key(text, chain=''):
    text = text.strip()
    if text.startswith('0x'):
        return address_key(chain if chain in CHAINS[1:] else 'ethereum', text)
    return address_key('solana', text)


def lookup_token(text, chain='', fetch=request, verify_solana=solana_supplies, verify_evm=evm_supplies):
    key = lookup_key(text, chain)
    if not key:
        raise ValueError('Enter a valid token address')
    network, address = key
    if network == 'solana' or chain in CHAINS[1:]:
        pairs = fetch('tokens/v1/' + network + '/' + address)
        networks = [network]
    else:
        result = fetch('latest/dex/search?q=' + quote(address, safe=''))
        pairs = result.get('pairs') if isinstance(result, dict) else None
        networks = CHAINS[1:]
    records = []
    for network in networks:
        canonical = address_key(network, address)[1]
        fields = select_pairs(pairs, {canonical}, time.time(), network).get(canonical)
        if fields is None and network != 'solana':
            continue
        fields = fields or {'name': canonical, 'data_source': 'DexScreener', 'market_cap_usd': None, 'price_usd': None, 'liquidity_usd': None}
        fields.update(chain=network, address=canonical)
        try:
            samples = verify_solana([canonical]) if network == 'solana' else verify_evm(network, [canonical])
            if canonical in samples:
                fields.update(samples[canonical])
                fields['verification_status'] = 'Mint account confirmed; USD value not independently verified' if network == 'solana' else 'Token contract confirmed; USD value not independently verified'
            else:
                fields['verification_status'] = 'Token verification unavailable'
        except (OSError, ValueError):
            fields['verification_status'] = 'Token verification delayed'
        records.append(fields)
    return records
