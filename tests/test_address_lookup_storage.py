import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from desktop_store import DesktopStore
from token_lookup import lookup_key, lookup_token
from storage_budget import StorageBudget


ADDRESS = '5JeAj2QsfgijDjmjmddBgpMvt1BAK84EVV5LNNZTpump'


def pair(address=ADDRESS, chain='solana'):
    return {'chainId': chain, 'pairAddress': '89XsRx6tijdkLqD7NSbY7x9XiZF5GdCmctDiL5HVh7Mi', 'baseToken': {'address': address, 'name': 'si.com'}, 'priceUsd': '0.000033', 'marketCap': 33000, 'liquidity': None, 'txns': {'h24': {'buys': 2, 'sells': 1}}}


class LookupTests(unittest.TestCase):
    def test_exact_address_case_is_preserved(self):
        calls = []
        rows = lookup_token(' ' + ADDRESS + ' ', fetch=lambda path: calls.append(path) or [pair()], verify_solana=lambda addresses: {})
        self.assertEqual(calls, ['tokens/v1/solana/' + ADDRESS])
        self.assertEqual(rows[0]['address'], ADDRESS)
        self.assertEqual(rows[0]['market_cap_usd'], 33000)
        self.assertIsNone(rows[0]['liquidity_usd'])

    def test_lookup_does_not_apply_scanner_thresholds(self):
        row = lookup_token(ADDRESS, fetch=lambda path: [pair()], verify_solana=lambda addresses: {})[0]
        self.assertEqual(row['name'], 'si.com')
        self.assertLess(row['market_cap_usd'], 40000)

    def test_missing_pair_can_still_verify_mint(self):
        rows = lookup_token(ADDRESS, fetch=lambda path: [], verify_solana=lambda addresses: {ADDRESS: {'onchain_supply': '1000000000'}})
        self.assertEqual(rows[0]['onchain_supply'], '1000000000')
        self.assertIsNone(rows[0]['market_cap_usd'])
        self.assertTrue(rows[0]['verification_status'].startswith('Mint account confirmed'))

    def test_wrong_token_pair_is_not_used(self):
        row = lookup_token(ADDRESS, fetch=lambda path: [pair('So11111111111111111111111111111111111111112')], verify_solana=lambda addresses: {})[0]
        self.assertIsNone(row['market_cap_usd'])

    def test_evm_search_returns_chain_specific_matches(self):
        address = '0x' + 'A' * 40
        rows = lookup_token(address, fetch=lambda path: {'pairs': [pair(address, 'base'), pair(address, 'ethereum')]}, verify_evm=lambda chain, addresses: {})
        self.assertEqual({row['chain'] for row in rows}, {'base', 'ethereum'})
        self.assertEqual({row['address'] for row in rows}, {address.lower()})

    def test_invalid_address_does_not_request(self):
        with self.assertRaises(ValueError):
            lookup_token('not an address', fetch=lambda path: self.fail('Unexpected request'))

    def test_verification_outage_preserves_quote(self):
        def fail(addresses):
            raise OSError('offline')
        row = lookup_token(ADDRESS, fetch=lambda path: [pair()], verify_solana=fail)[0]
        self.assertEqual(row['market_cap_usd'], 33000)
        self.assertEqual(row['verification_status'], 'Token verification delayed')

    def test_desktop_search_shows_exact_token_despite_filters(self):
        from PySide6.QtWidgets import QApplication
        from desktop import DesktopWindow
        app = QApplication.instance() or QApplication([])
        with tempfile.TemporaryDirectory() as directory:
            store = DesktopStore(directory)
            store.set('token_filters', {'chain': 'base', 'buys_min': 1000})
            window = DesktopWindow(store, background=False)
            row = lookup_token(ADDRESS, fetch=lambda path: [pair()], verify_solana=lambda addresses: {})[0]
            try:
                with patch('desktop.lookup_token', return_value=[row]) as fetch:
                    window.search.setText(ADDRESS)
                    window.lookup_timer.stop()
                    window.lookup_address()
                    deadline = time.monotonic() + 5
                    while not window.lookup_records and time.monotonic() < deadline:
                        app.processEvents()
                        time.sleep(0.01)
                self.assertEqual(fetch.call_args.args[0], ADDRESS)
                self.assertEqual(window.lookup_panel.title.text(), 'si.com')
                self.assertIn('below $40k', window.lookup_label.toolTip())
                self.assertIn('liquidity unavailable', window.lookup_label.toolTip())
                self.assertTrue(window.tables['Live tokens'].isHidden())
                self.assertTrue(window.scanner_footer.isHidden())
                self.assertEqual(window.tables['Live tokens'].model().rowCount(), 0)
                window.watch_lookup()
                self.assertIn(('solana', ADDRESS), store.watchlist())
                window.accept_lookup({'generation': window.lookup_generation - 1, 'records': []})
                self.assertEqual(len(window.lookup_records), 1)
                empty = dict(row, name=ADDRESS, market_pair=None, market_cap_usd=None, verification_status='Token verification unavailable')
                window.accept_lookup({'generation': window.lookup_generation, 'records': [empty]})
                self.assertEqual(window.lookup_panel.title.text(), 'No supported token found')
                self.assertTrue(window.lookup_watch.isHidden())
                self.assertTrue(window.lookup_details.isHidden())
                self.assertFalse(window.lookup_retry.isHidden())
                self.assertNotIn('Unavailable', window.lookup_label.text())
                window.accept_lookup({'generation': window.lookup_generation, 'records': [], 'error': 'offline'})
                self.assertEqual(window.lookup_panel.title.text(), 'Could not load token')
                window.search.clear()
                self.assertEqual(window.lookup_records, [])
                self.assertTrue(window.lookup_panel.isHidden())
            finally:
                window.quit_app()
                window.lookup_timer.stop()
                window.deleteLater()
                app.processEvents()


class StorageTests(unittest.TestCase):
    def test_reservation_shrinks_as_data_grows(self):
        with tempfile.TemporaryDirectory() as directory:
            budget = StorageBudget(directory, limit=2_000_000)
            state = budget.maintain()
            self.assertEqual(state['used'], 0)
            self.assertEqual(budget.reserve.stat().st_size, 2_000_000)
            (Path(directory) / 'history.dat').write_bytes(b'x' * 100000)
            state = budget.maintain()
            self.assertEqual(state['used'], 100000)
            self.assertEqual(budget.reserve.stat().st_size, 1_900_000)
            self.assertGreater(state['reserved'], 0)

    def test_low_disk_space_does_not_create_reservation(self):
        with tempfile.TemporaryDirectory() as directory:
            budget = StorageBudget(directory, limit=2_000_000)
            with patch('storage_budget.shutil.disk_usage') as usage:
                usage.return_value.free = 0
                with self.assertRaises(OSError):
                    budget.maintain()
            self.assertFalse(budget.reserve.exists())

    def test_full_budget_blocks_ingestion(self):
        with tempfile.TemporaryDirectory() as directory:
            budget = StorageBudget(directory, limit=2_000_000)
            budget.maintain()
            with self.assertRaises(OSError):
                budget.require_space(2_000_000)

    def test_full_store_rolls_back_writes_but_allows_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            store = DesktopStore(directory)
            store.storage.limit = 100_000
            store.storage.reserve.write_bytes(b'x')
            with self.assertRaises(OSError):
                store.set('should_not_commit', 'payload')
            self.assertIsNone(store.get('should_not_commit'))


if __name__ == '__main__':
    unittest.main()
