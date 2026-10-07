import math
import time


def fresh(sampled, now=None):
    return type(sampled) in (int, float) and math.isfinite(sampled) and 0 <= (time.time() if now is None else now) - sampled <= 180


def current_value(record, field, timestamp):
    value = record.get(field)
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 and fresh(record.get(timestamp)) else None


def current_cap(record):
    return current_value(record, 'market_cap_usd', 'market_cap_updated_at')


def mint_status(record):
    if not fresh(record.get('onchain_supply_sampled_at')):
        return 'unavailable'
    status = str(record.get('verification_status', ''))
    return 'confirmed' if status.startswith(('Mint and decimals confirmed', 'Mint account confirmed')) else 'mismatch' if 'differ' in status else 'pending'
