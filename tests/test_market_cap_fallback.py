import unittest
from token_monitor import select_market_caps


class MarketCapTests(unittest.TestCase):
    def test_uses_reported_cap_from_highest_liquidity_matching_pair(self):
        pairs = [{'chainId': 'solana', 'baseToken': {'address': 'abc'}, 'marketCap': cap, 'liquidity': {'usd': liquidity}} for cap, liquidity in [(40000, 1000), (42000, 2000)]]
        result = select_market_caps(pairs, 'solana', ['abc'])
        self.assertEqual(result['abc']['market_cap_usd'], 42000)
        self.assertEqual(result['abc']['market_cap_source'], 'DexScreener')

    def test_rejects_fdv_wrong_chain_quote_token_and_invalid_cap(self):
        pairs = [{'chainId': 'solana', 'baseToken': {'address': 'abc'}, 'fdv': 50000}, {'chainId': 'base', 'baseToken': {'address': 'abc'}, 'marketCap': 50000}, {'chainId': 'solana', 'baseToken': {'address': 'other'}, 'quoteToken': {'address': 'abc'}, 'marketCap': 50000}, {'chainId': 'solana', 'baseToken': {'address': 'abc'}, 'marketCap': float('nan')}]
        self.assertEqual(select_market_caps(pairs, 'solana', ['abc']), {})
