import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from desktop_store import DesktopStore


class DesktopStoreTests(unittest.TestCase):
    def test_settings_watchlist_and_partial_snapshots_survive_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            store = DesktopStore(directory)
            store.set('session', {'enabled': True, 'expires_at': 123456})
            store.watch('base', '0x' + 'a' * 40)
            store.record('base', '0x' + 'a' * 40, {'name': 'Example', 'market_cap_usd': 42000})
            store.record('base', '0x' + 'a' * 40, {'net_inflow_m5_usd': 123000})
            reopened = DesktopStore(directory)
            self.assertEqual(reopened.get('session')['expires_at'], 123456)
            self.assertEqual(len(reopened.watchlist()), 1)
            token = reopened.tokens()[0]
            self.assertEqual(token['market_cap_usd'], 42000)
            self.assertEqual(token['net_inflow_m5_usd'], 123000)
            reopened.unwatch('base', '0x' + 'a' * 40)
            self.assertEqual(reopened.watchlist(), [])
            self.assertEqual(len(reopened.tokens()), 1)

    def test_watchlist_rejects_path_and_url_values(self):
        with tempfile.TemporaryDirectory() as directory:
            store = DesktopStore(directory)
            for chain, address in [('https://x', 'test'), ('base', '../secret'), ('base', 'x?key=y')]:
                with self.assertRaises(ValueError):
                    store.watch(chain, address)
