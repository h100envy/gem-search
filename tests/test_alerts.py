import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
from alerts import TokenAlerts


class AlertTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = app.DATA, app.DB
        app.DATA = Path(self.temp.name)
        app.DB = app.DATA / 'test.sqlite'
        app.init()
        self.alerts = TokenAlerts(app.connect)

    def tearDown(self):
        app.DATA, app.DB = self.old
        self.temp.cleanup()

    def test_exact_inflow_boundary_and_repeated_crossings(self):
        self.assertEqual(self.alerts.evaluate('base', 'a', {'net_inflow_m5_usd': 100000}), [])
        self.assertEqual(len(self.alerts.evaluate('base', 'a', {'net_inflow_m5_usd': 100001})), 1)
        self.assertEqual(self.alerts.evaluate('base', 'a', {'net_inflow_m5_usd': 200000}), [])
        self.alerts.evaluate('base', 'a', {'net_inflow_m5_usd': 1000})
        self.assertEqual(len(self.alerts.evaluate('base', 'a', {'net_inflow_m5_usd': 120000})), 1)

    def test_token_creation_required_and_strict_age(self):
        self.assertEqual(self.alerts.evaluate('solana', 'a', {'market_cap_usd': 40000, 'pair_created_at': 100}, 200), [])
        self.assertEqual(self.alerts.evaluate('solana', 'a', {'market_cap_usd': 40000, 'token_created_at': 100}, 400), [])
        self.assertEqual(len(self.alerts.evaluate('solana', 'a', {'market_cap_usd': 40000, 'token_created_at': 100}, 399)), 1)

    def test_chain_isolation_and_restart_deduplication(self):
        self.alerts.evaluate('base', 'a', {'net_inflow_m5_usd': 110000})
        other = TokenAlerts(app.connect)
        self.assertEqual(other.evaluate('base', 'a', {'net_inflow_m5_usd': 110000}), [])
        self.assertEqual(len(other.evaluate('ethereum', 'a', {'net_inflow_m5_usd': 110000})), 1)

    def test_missing_invalid_values_do_not_reset_crossing(self):
        self.alerts.evaluate('base', 'a', {'net_inflow_m5_usd': 110000})
        for value in [None, float('nan'), float('inf'), True, '110000']:
            self.assertEqual(self.alerts.evaluate('base', 'a', {'net_inflow_m5_usd': value}), [])
        self.assertEqual(self.alerts.evaluate('base', 'a', {'net_inflow_m5_usd': 110000}), [])
