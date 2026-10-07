import json
import time
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from solscan_monitor import SolscanAccessError, SolscanClient, SolscanMonitor, metadata_fields


ADDRESS = 'So11111111111111111111111111111111111111112'


class SolscanTests(unittest.TestCase):
    def test_free_key_routes_metadata_to_documented_free_endpoint(self):
        response = Mock()
        response.read.return_value = json.dumps({'success': True, 'data': {'address': ADDRESS}}).encode()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        client = SolscanClient('fake-key')
        with patch('solscan_monitor.urlopen', side_effect=[HTTPError('https://pro-api.solscan.io/v2.0/token/meta', 401, '', {}, None), response, response]) as opened:
            client.get('token/meta', address=ADDRESS)
            client.get('token/meta', address=ADDRESS)
        self.assertTrue(client.free_access)
        self.assertTrue(opened.call_args_list[1].args[0].full_url.startswith('https://pro-api.solscan.io/playground/token/meta?'))
        self.assertTrue(opened.call_args_list[2].args[0].full_url.startswith('https://pro-api.solscan.io/playground/token/meta?'))
        with self.assertRaises(SolscanAccessError):
            client.get('token/latest')

    def test_saved_tokens_refresh_when_discovery_access_is_rejected(self):
        client = Mock(key='fake-key', free_access=True)
        client.get.side_effect = [SolscanAccessError(401, 'Discovery unavailable'), {'address': ADDRESS, 'decimals': 9, 'market_cap': 45000}]
        observer, alerts = Mock(), Mock()
        monitor = SolscanMonitor(alerts, observer, tracked=lambda: [{'chain': 'solana', 'address': ADDRESS, 'market_cap_source': 'Legacy'}], client=client)
        monitor.control(True)
        with patch('solscan_monitor.solana_supplies', return_value={}):
            monitor.poll()
        self.assertEqual(observer.call_args.args[2]['data_source'], 'Solscan')
        self.assertIn('Free Solscan access connected', monitor.error)
        alerts.evaluate.assert_not_called()

    def test_only_solscan_endpoint_with_header_credential(self):
        response = Mock()
        response.read.return_value = json.dumps({'success': True, 'data': []}).encode()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch('solscan_monitor.urlopen', return_value=response) as opened:
            self.assertEqual(SolscanClient('fake-test-key').get('token/latest', page=1, page_size=20), [])
        request = opened.call_args.args[0]
        self.assertTrue(request.full_url.startswith('https://pro-api.solscan.io/v2.0/token/latest?'))
        self.assertNotIn('fake-test-key', request.full_url)
        self.assertEqual(request.get_header('Token'), 'fake-test-key')

    def test_missing_key_never_requests_network(self):
        with patch('solscan_monitor.urlopen') as opened:
            with self.assertRaisesRegex(ValueError, 'Connect Solscan'):
                SolscanClient('').get('token/latest')
            opened.assert_not_called()
        monitor = SolscanMonitor(Mock())
        self.assertFalse(monitor.control(True)['enabled'])

    def test_missing_fields_clear_old_provider_values(self):
        fields = metadata_fields({'address': ADDRESS, 'market_cap': float('nan'), 'price': True, 'created_time': -1}, 100)
        self.assertIsNone(fields['market_cap_usd'])
        self.assertIsNone(fields['price_usd'])
        self.assertIsNone(fields['token_created_at'])
        self.assertIsNone(fields['net_inflow_m5_usd'])
        self.assertEqual(fields['data_source'], 'Solscan')

    def monitor(self):
        client = Mock(key='fake-key')
        client.get.return_value = [{'address': ADDRESS, 'decimals': 9, 'market_cap': 45000, 'price': 1, 'created_time': time.time() - 20}]
        observer, alerts = Mock(), Mock()
        monitor = SolscanMonitor(alerts, observer, client=client)
        monitor.control(True)
        return monitor, observer, alerts

    def test_chain_checks_do_not_replace_solscan_cap_or_price(self):
        monitor, observer, alerts = self.monitor()
        with patch('solscan_monitor.solana_supplies', return_value={ADDRESS: {'onchain_decimals': 9, 'onchain_supply': '999999', 'onchain_slot': 10}}):
            monitor.poll()
        fields = observer.call_args.args[2]
        self.assertEqual(fields['market_cap_usd'], 45000)
        self.assertEqual(fields['price_usd'], 1)
        self.assertIsNone(fields['onchain_valuation_usd'])
        self.assertNotIn('net_inflow_m5_usd', alerts.evaluate.call_args.args[2])
        self.assertEqual(alerts.evaluate.call_args.args[2]['creation_source'], 'Solscan')

    def test_mismatch_withholds_alert(self):
        monitor, observer, alerts = self.monitor()
        with patch('solscan_monitor.solana_supplies', return_value={ADDRESS: {'onchain_decimals': 6}}):
            monitor.poll()
        alerts.evaluate.assert_not_called()
        self.assertIn('differ', observer.call_args.args[2]['verification_status'])

    def test_unavailable_chain_withholds_alert(self):
        monitor, observer, alerts = self.monitor()
        with patch('solscan_monitor.solana_supplies', side_effect=TimeoutError):
            monitor.poll()
        alerts.evaluate.assert_not_called()
        self.assertEqual(observer.call_args.args[2]['market_cap_usd'], 45000)
        self.assertIn('unavailable', observer.call_args.args[2]['verification_status'])

    def test_stop_during_discovery_discards_results(self):
        monitor, observer, alerts = self.monitor()
        monitor.client.get.side_effect = lambda *args, **kwargs: (monitor.control(False), [])[1]
        with patch('solscan_monitor.solana_supplies') as chain:
            monitor.poll()
        observer.assert_not_called()
        alerts.evaluate.assert_not_called()
        chain.assert_not_called()

    def test_timed_expiry_stops(self):
        monitor, _, _ = self.monitor()
        monitor.expires = time.time() - 1
        self.assertFalse(monitor.status()['enabled'])
