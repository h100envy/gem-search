import time
import unittest
from data_quality import current_cap, mint_status
from gem_mcp import token_view
from onchain import parse_supplies


class DataQualityTests(unittest.TestCase):
    def test_invalid_and_stale_values_are_unavailable(self):
        now = time.time()
        for sample in [None, now - 181, now + 60, float('nan')]:
            record = {'market_cap_usd': 100, 'market_cap_updated_at': sample}
            self.assertIsNone(current_cap(record))
            self.assertIsNone(token_view(record)['market_cap_usd'])
        for value in [float('nan'), float('inf'), -1, True, '100']:
            self.assertIsNone(current_cap({'market_cap_usd': value, 'market_cap_updated_at': now}))
        self.assertEqual(current_cap({'market_cap_usd': 100, 'market_cap_updated_at': now}), 100)

    def test_old_confirmation_is_unavailable(self):
        record = {'verification_status': 'Mint and decimals confirmed', 'onchain_supply_sampled_at': time.time() - 181}
        self.assertEqual(mint_status(record), 'unavailable')
        record['onchain_supply_sampled_at'] = time.time()
        self.assertEqual(mint_status(record), 'confirmed')

    def test_untrusted_account_owner_is_rejected(self):
        account = {'owner': 'other', 'executable': False, 'data': {'parsed': {'type': 'mint', 'info': {'supply': '100', 'decimals': 0, 'isInitialized': True}}}}
        self.assertEqual(parse_supplies({'result': {'context': {'slot': 1}, 'value': [account]}}, ['mint']), {})
