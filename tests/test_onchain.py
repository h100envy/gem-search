import unittest
from onchain import parse_supplies, supply_valuation
from token_monitor import select_market_caps


class OnchainTests(unittest.TestCase):
    def response(self, amount='1000000000000000', decimals=6, kind='mint'):
        return {'result': {'context': {'slot': 123}, 'value': [{'data': {'parsed': {'type': kind, 'info': {'supply': amount, 'decimals': decimals, 'isInitialized': True}}}}]}}

    def test_raw_mint_supply_and_decimals_are_preserved(self):
        sample = parse_supplies(self.response(), ['mint'])['mint']
        self.assertEqual(sample['onchain_supply'], '1000000000.000000')
        self.assertEqual(sample['onchain_slot'], 123)
        self.assertEqual(sample['onchain_supply_raw'], '1000000000000000')

    def test_wrong_account_type_and_invalid_supply_are_rejected(self):
        self.assertEqual(parse_supplies(self.response(kind='account'), ['mint']), {})
        self.assertEqual(parse_supplies(self.response(amount=str(2 ** 64)), ['mint']), {})
        self.assertEqual(parse_supplies(self.response(decimals=-1), ['mint']), {})

    def test_rpc_error_and_account_count_mismatch_are_rejected(self):
        with self.assertRaises(ValueError):
            parse_supplies({'error': {'code': 429}}, ['mint'])
        with self.assertRaises(ValueError):
            parse_supplies(self.response(), ['mint', 'other'])

    def test_valuation_uses_supply_and_price_not_provider_market_cap(self):
        sample = parse_supplies(self.response(), ['mint'])['mint']
        result = supply_valuation(sample, {'price_usd': '0.00004', 'market_cap_usd': 1, 'price_source': 'Fixture price'})
        self.assertEqual(result['onchain_valuation_usd'], 40000)
        self.assertNotIn('market_cap_usd', result)
        self.assertIn('not verified circulating', result['onchain_valuation_method'])

    def test_zero_supply_and_invalid_prices_do_not_create_a_value(self):
        for price in ['nan', '-1', None]:
            self.assertNotIn('onchain_valuation_usd', supply_valuation({'onchain_supply': '1000000'}, {'price_usd': price}))
        self.assertNotIn('onchain_valuation_usd', supply_valuation({'onchain_supply': '0'}, {'price_usd': '1'}))

    def test_price_without_reported_cap_or_liquidity_is_kept_with_missing_liquidity(self):
        result = select_market_caps([{'chainId': 'solana', 'baseToken': {'address': 'mint'}, 'priceUsd': '0.00004', 'pairAddress': 'pool'}], 'solana', ['mint'])['mint']
        self.assertEqual(result['price_usd'], '0.00004')
        self.assertIsNone(result['price_liquidity_usd'])
        self.assertNotIn('market_cap_usd', result)
