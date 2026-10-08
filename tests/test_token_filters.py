import time
import unittest
from token_filters import DEFAULTS, matches, sort_key
from dex_monitor import select_pairs


class TokenFilterTests(unittest.TestCase):
    def record(self, **fields):
        now = time.time()
        return dict({'address': 'fixture', 'name': 'Fixture', 'market_cap_usd': 50000, 'market_cap_updated_at': now, 'liquidity_usd': 10000, 'statistics_sampled_at': now, 'pair_created_at': (now - 1800) * 1000, 'volume_m5_usd': 20000, 'buy_count_m5': 10, 'sell_count_m5': 5, 'price_change_m5_pct': -5, 'fdv_usd': 60000, 'dex_id': 'raydium'}, **fields)

    def test_liquidity_floor_and_missing_values(self):
        for liquidity in [None, 0, 9999.99, -1, float('nan')]:
            self.assertFalse(matches(self.record(liquidity_usd=liquidity), DEFAULTS))
        self.assertTrue(matches(self.record(liquidity_usd=10000), DEFAULTS))
        self.assertFalse(matches(self.record(statistics_sampled_at=time.time() - 181), DEFAULTS))

    def test_ranges_timeframe_and_unknown_metrics(self):
        settings = dict(DEFAULTS, timeframe='m5', volume_min=20000, volume_max=25000, age_max=1, transactions_min=15, change_min=-10, change_max=0, fdv_max=60000, dex='raydium')
        self.assertTrue(matches(self.record(), settings))
        self.assertFalse(matches(self.record(volume_m5_usd=19999), settings))
        self.assertFalse(matches(self.record(pair_created_at=None), settings))
        self.assertFalse(matches(self.record(price_change_m5_pct=None), settings))
        self.assertFalse(matches(self.record(dex_id='orca'), settings))
        self.assertFalse(matches(self.record(), dict(settings, timeframe='h24')))

    def test_pair_metrics_remain_distinct_from_token_creation_and_cap(self):
        address = 'So11111111111111111111111111111111111111112'
        pair = {'chainId': 'solana', 'baseToken': {'address': address}, 'pairAddress': 'pair', 'marketCap': 50000, 'fdv': 60000, 'liquidity': {'usd': 10000}, 'txns': {'h1': {'buys': 8, 'sells': 2}}, 'priceChange': {'h1': -9}, 'volume': {'h1': 12000}, 'dexId': 'orca', 'labels': ['CLMM'], 'boosts': {'active': 10}, 'pairCreatedAt': time.time() * 1000}
        fields = select_pairs([pair], {address}, time.time())[address]
        self.assertEqual(fields['transaction_count_h1'], 10)
        self.assertEqual(fields['price_change_h1_pct'], -9)
        self.assertEqual(fields['fdv_usd'], 60000)
        self.assertIsNone(fields['token_created_at'])
        fields['address'] = address
        self.assertTrue(matches(fields, dict(DEFAULTS, timeframe='h1', labels='CLMM', boosted_only=True)))

    def test_negative_change_sorts_ahead_of_unknown(self):
        rows = [self.record(address='missing', price_change_m5_pct=None), self.record(address='loser', price_change_m5_pct=-5), self.record(address='gainer', price_change_m5_pct=20)]
        rows.sort(key=lambda r: sort_key(r, {'sort': 'change', 'timeframe': 'm5'}))
        self.assertEqual([r['address'] for r in rows], ['gainer', 'loser', 'missing'])
