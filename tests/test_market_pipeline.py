import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from desktop_store import DesktopStore
from alerts import TokenAlerts
from market_metrics import statistics_fields, current_flow
from solscan_monitor import SolscanClient, SolscanAccessError, SolscanMonitor


ADDRESS = 'So11111111111111111111111111111111111111112'


class MarketPipelineTests(unittest.TestCase):
    def test_buy_minus_sell_supports_zero_and_negative_flow(self):
        now = time.time()
        for buy, sell in [(200000, 50000), (0, 0), (100, 200)]:
            fields = statistics_fields({'buy_volume_5m': buy, 'sell_volume_5m': sell}, now)
            self.assertEqual(current_flow(fields), buy - sell)
            self.assertIsNone(current_flow(dict(fields, flow_updated_at=now - 181)))
        for data in [{'volume_5m': 999999}, {'buy_volume_5m': 100}, {'buy_volume_5m': float('nan'), 'sell_volume_5m': 1}, {'buy_volume_5m': True, 'sell_volume_5m': 1}]:
            self.assertIsNone(current_flow(statistics_fields(data, now)))
        self.assertIsNone(current_flow({'net_inflow_m5_usd': 999999, 'flow_updated_at': now}))

    def test_request_budget_and_server_cooldown_prevent_flooding(self):
        client = SolscanClient('fixture')
        client.retry_at = time.monotonic() + 60
        with patch('solscan_monitor.urlopen') as opened:
            with self.assertRaises(SolscanAccessError):
                client.get('token/meta', address=ADDRESS)
            opened.assert_not_called()
        client.retry_at = 0
        with patch('solscan_monitor.urlopen', side_effect=HTTPError('https://pro-api.solscan.io', 429, '', {'Retry-After': '120'}, None)) as opened:
            for _ in range(2):
                with self.assertRaises(SolscanAccessError):
                    client.get('token/meta', address=ADDRESS)
            self.assertEqual(opened.call_count, 1)
            self.assertGreater(client.retry_at - time.monotonic(), 119)

    def test_ranked_feed_reaches_store_flow_and_alerts(self):
        with tempfile.TemporaryDirectory() as directory:
            store = DesktopStore(Path(directory))
            alerts = TokenAlerts(store.connect)
            client = SolscanClient('fixture')
            row = {'address': ADDRESS, 'name': 'Fixture', 'decimals': 9, 'market_cap': 45000, 'price': 0.000045, 'created_time': time.time() - 30, 'volume_1m': 10000, 'volume_5m': 250000, 'buy_volume_5m': 200000, 'sell_volume_5m': 50000}
            monitor = SolscanMonitor(alerts, store.record, tracked=lambda: [], client=client)
            monitor.control(True)
            with patch.object(client, 'top_tokens', return_value=[row]), patch('solscan_monitor.solana_supplies', return_value={ADDRESS: {'onchain_decimals': 9, 'onchain_supply_sampled_at': time.time()}}):
                monitor.poll()
                monitor.last_poll = 0
                monitor.poll()
            token = store.tokens()[0]
            self.assertEqual(current_flow(token), 150000)
            self.assertEqual(token['market_cap_usd'], 45000)
            self.assertEqual(len(alerts.recent()), 2)
            self.assertEqual(monitor.checked, 1)
            self.assertIsNone(monitor.ranking_error)
