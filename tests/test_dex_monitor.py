import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from alerts import TokenAlerts
from desktop_store import DesktopStore
from dex_monitor import DexMonitor, select_pairs
from data_quality import current_cap, mint_status


ADDRESS = 'So11111111111111111111111111111111111111112'


def pair(liquidity=10000, cap=50000):
    return {'chainId': 'solana', 'baseToken': {'address': ADDRESS, 'name': 'Fixture'}, 'pairAddress': 'pair', 'priceUsd': '0.00000042', 'marketCap': cap, 'fdv': 900000, 'liquidity': {'usd': liquidity}, 'volume': {'m5': 200000, 'h24': 400000}, 'txns': {'m5': {'buys': 100, 'sells': 1}}, 'pairCreatedAt': 1700000000000}


class DexMonitorTests(unittest.TestCase):
    def test_most_liquid_pair_and_no_fabricated_metrics(self):
        result = select_pairs([pair(10, 100000), pair(100, None)], {ADDRESS}, time.time())[ADDRESS]
        self.assertIsNone(result['market_cap_usd'])
        self.assertIsNone(result['net_inflow_m5_usd'])
        self.assertIsNone(result['volume_m1_usd'])
        self.assertIsNone(result['token_created_at'])
        self.assertEqual(result['price_usd'], 0.00000042)
        self.assertEqual(result['buy_count_m5'], 100)

    def test_scanner_replaces_old_pool_with_active_pool(self):
        from token_filters import DEFAULTS, matches
        from token_lookup import lookup_token
        old = dict(pair(), pairAddress='old-pool', marketCap=28363.41, liquidity=None)
        active = dict(pair(28203.32, 140567), pairAddress='active-pool')
        with tempfile.TemporaryDirectory() as directory:
            store = DesktopStore(directory)
            store.record('solana', ADDRESS, {'name': 'Fixture', 'market_pair': 'old-pool', 'market_cap_usd': 28363.41})
            monitor = DexMonitor(TokenAlerts(store.connect), store.record, store.watchlist, store.tokens)
            monitor.discovery_at = time.monotonic()
            monitor.control(True)
            with patch('dex_monitor.request', return_value={'pairs': [old, active]}) as fetch, patch('dex_monitor.solana_supplies', return_value={}):
                monitor.poll()
                fetch.assert_called_once_with('latest/dex/tokens/' + ADDRESS)
            record = store.tokens()[0]
            self.assertEqual(record['market_pair'], 'active-pool')
            self.assertEqual(record['market_cap_usd'], 140567)
            self.assertTrue(matches(record, DEFAULTS))
            lookup = lookup_token(ADDRESS, fetch=lambda path: [old, active], verify_solana=lambda addresses: {})[0]
            self.assertEqual(lookup['market_pair'], record['market_pair'])
            self.assertEqual(lookup['market_cap_usd'], record['market_cap_usd'])

    def test_public_feed_to_store_and_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            store = DesktopStore(Path(directory))
            alerts = TokenAlerts(store.connect)
            monitor = DexMonitor(alerts, store.record, store.watchlist, store.tokens)
            monitor.control(True)
            sample = {'onchain_supply_sampled_at': time.time(), 'onchain_decimals': 9, 'onchain_supply': 1000}
            def response(path):
                return {'pairs': [pair()]} if path.startswith('latest/dex/tokens/') else [{'chainId': 'solana', 'tokenAddress': ADDRESS}]
            with patch('dex_monitor.request', side_effect=response) as request, patch('dex_monitor.solana_supplies', return_value={ADDRESS: sample}):
                monitor.poll()
                self.assertEqual(len(store.tokens()), 1)
                self.assertEqual(current_cap(store.tokens()[0]), 50000)
                self.assertEqual(mint_status(store.tokens()[0]), 'confirmed')
                self.assertEqual(alerts.recent(), [])
                count = request.call_count
                monitor.last_poll = 0
                monitor.control(False)
                monitor.poll()
                self.assertEqual(request.call_count, count)

    def test_stop_during_request_prevents_write(self):
        with tempfile.TemporaryDirectory() as directory:
            store = DesktopStore(directory)
            monitor = DexMonitor(TokenAlerts(store.connect), store.record, store.watchlist, store.tokens)
            monitor.discovered = [ADDRESS]
            monitor.discovery_at = time.monotonic()
            monitor.control(True)
            def response(path):
                monitor.control(False)
                return [pair()]
            with patch('dex_monitor.request', side_effect=response):
                monitor.poll()
            self.assertEqual(store.tokens(), [])
