import math
import time
from data_quality import current_cap, current_value, fresh, mint_status


DEFAULTS = {'liquidity_min': 10000, 'cap_min': 40000, 'timeframe': 'h24', 'sort': 'cap'}
RANGES = [('liquidity', 'Liquidity ($)'), ('cap', 'Market cap ($)'), ('fdv', 'FDV ($)'), ('age', 'Pair age (hours)'), ('transactions', 'Transactions'), ('buys', 'Buys'), ('sells', 'Sells'), ('volume', 'Volume ($)'), ('change', 'Price change (%)')]


def matches(record, settings, now=None):
    now = time.time() if now is None else now
    timeframe = settings.get('timeframe', 'h24')
    values = {'cap': current_cap(record), 'liquidity': current_value(record, 'liquidity_usd', 'statistics_sampled_at'), 'fdv': current_value(record, 'fdv_usd', 'statistics_sampled_at')}
    created = record.get('pair_created_at')
    values['age'] = (now - created / 1000) / 3600 if type(created) in (int, float) and math.isfinite(created) and 0 < created <= now * 1000 else None
    for key in ['buys', 'sells', 'volume', 'change']:
        field = {'buys': 'buy_count_', 'sells': 'sell_count_', 'volume': 'volume_', 'change': 'price_change_'}[key] + timeframe
        field += '_usd' if key == 'volume' else '_pct' if key == 'change' else ''
        value = record.get(field)
        values[key] = value if type(value) in (int, float) and math.isfinite(value) and fresh(record.get('statistics_sampled_at'), now) and (key == 'change' or value >= 0) else None
    values['transactions'] = values['buys'] + values['sells'] if values['buys'] is not None and values['sells'] is not None else None
    if values['liquidity'] is None or values['liquidity'] < 10000 or values['cap'] is None or values['cap'] < 40000:
        return False
    if settings.get('chain') and record.get('chain') != settings['chain']:
        return False
    if settings.get('dex') and record.get('dex_id') != settings['dex']:
        return False
    if settings.get('confirmed_only') and mint_status(record) != 'confirmed':
        return False
    suffixes = [part.strip() for part in settings.get('suffixes', '').split(',') if part.strip()]
    if suffixes and not any(record['address'].endswith(part) for part in suffixes):
        return False
    labels = [part.strip().casefold() for part in settings.get('labels', '').split(',') if part.strip()]
    if labels and not set(labels).intersection(str(label).casefold() for label in record.get('pair_labels', [])):
        return False
    if settings.get('boosted_only') and not (record.get('active_boosts') or 0) > 0:
        return False
    for key, label in RANGES:
        lower, upper = settings.get(key + '_min'), settings.get(key + '_max')
        if lower is not None and (values[key] is None or values[key] < lower):
            return False
        if upper is not None and (values[key] is None or values[key] > upper):
            return False
    return True


def sort_key(record, settings):
    kind = settings.get('sort', 'cap')
    timeframe = settings.get('timeframe', 'h24')
    if kind == 'name':
        return (record.get('name', '').casefold(), record['address'])
    field = {'cap': 'market_cap_usd', 'liquidity': 'liquidity_usd', 'volume': 'volume_' + timeframe + '_usd', 'newest': 'pair_created_at', 'change': 'price_change_' + timeframe + '_pct', 'transactions': 'transaction_count_' + timeframe}.get(kind, 'market_cap_usd')
    value = record.get(field)
    valid = type(value) in (int, float) and math.isfinite(value)
    return (not valid, -value if valid else 0, record.get('name', '').casefold(), record['address'])
