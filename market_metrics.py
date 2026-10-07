import math
from data_quality import fresh


def metric(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


def statistics_fields(data, captured):
    fields = {'statistics_sampled_at': captured, 'net_inflow_m5_usd': None, 'flow_updated_at': None, 'flow_method': None}
    for source, target in [('volume_1m', 'volume_m1_usd'), ('volume_5m', 'volume_m5_usd'), ('buy_volume_5m', 'buy_volume_m5_usd'), ('sell_volume_5m', 'sell_volume_m5_usd'), ('liquidity', 'liquidity_usd'), ('num_trade_5m', 'trades_m5')]:
        fields[target] = metric(data.get(source))
    for source, target in [('price_1m_change_pct', 'price_change_m1_pct'), ('price_5m_change_pct', 'price_change_m5_pct')]:
        value = data.get(source)
        fields[target] = value if type(value) in (int, float) and math.isfinite(value) else None
    buy, sell = fields['buy_volume_m5_usd'], fields['sell_volume_m5_usd']
    if buy is not None and sell is not None:
        net = buy - sell
        if math.isfinite(net):
            fields.update(net_inflow_m5_usd=net, flow_updated_at=captured, flow_method='indexed_buy_minus_sell_5m')
    return fields


def current_flow(record):
    value = record.get('net_inflow_m5_usd')
    return value if record.get('flow_method') == 'indexed_buy_minus_sell_5m' and type(value) in (int, float) and math.isfinite(value) and fresh(record.get('flow_updated_at')) else None
