import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
from market import MarketRadar


class MarketTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = app.DATA, app.DB
        app.DATA = Path(self.temp.name)
        app.DB = app.DATA / 'test.sqlite'
        app.init()
        self.radar = MarketRadar(app.connect)
        self.address = 'So11111111111111111111111111111111111111112'

    def tearDown(self):
        app.DATA, app.DB = self.old
        self.temp.cleanup()

    def test_validation_and_persistence(self):
        for address in ['../x', '', None, '0' * 44]:
            with self.assertRaises(ValueError):
                self.radar.watch(address)
        self.radar.watch(self.address)
        self.radar.watch(self.address)
        other = MarketRadar(app.connect)
        self.assertEqual(other.status()['watchlist'], [self.address])
        self.assertFalse(other.status()['enabled'])

    def test_deadline_and_manual_stop(self):
        with patch('market.time.time', return_value=100):
            self.radar.control(True, 1)
        with patch('market.time.time', return_value=160):
            self.assertFalse(self.radar.status()['enabled'])
        self.radar.control(True)
        self.assertTrue(self.radar.status()['enabled'])
        self.radar.control(False)
        self.assertFalse(self.radar.status()['enabled'])

    def test_snapshot_and_poll_throttle(self):
        self.radar.watch(self.address)
        self.radar.control(True)
        pair = {'chainId': 'solana', 'baseToken': {'address': self.address}, 'priceUsd': '1.2'}
        with patch('market.urlopen', return_value=io.BytesIO(json.dumps([pair]).encode())) as request:
            self.radar.poll()
            self.radar.poll()
        self.assertEqual(request.call_count, 1)
        self.assertEqual(len(self.radar.status()['snapshots']), 1)

    def test_stop_during_request_discards_response(self):
        self.radar.watch(self.address)
        self.radar.control(True)
        def response(*args, **kwargs):
            self.radar.control(False)
            return io.BytesIO(json.dumps([{'chainId': 'solana', 'baseToken': {'address': self.address}}]).encode())
        with patch('market.urlopen', side_effect=response):
            self.radar.poll()
        self.assertEqual(self.radar.status()['snapshots'], [])

    def test_pump_control_validation(self):
        for enabled, minutes in [(1, 0), (True, -1), (True, 1441), (True, '60')]:
            with self.assertRaises(ValueError):
                self.radar.pump_control(enabled, minutes)
        state = self.radar.pump_control(True, 1)
        self.assertTrue(state['pump']['enabled'])
        self.assertIsNotNone(state['pump']['expires_at'])
        self.assertFalse(self.radar.pump_control(False)['pump']['enabled'])

    def test_restart_rejects_previous_session_response(self):
        self.radar.watch(self.address)
        self.radar.control(True)
        def response(*args, **kwargs):
            self.radar.control(False)
            self.radar.control(True)
            return io.BytesIO(json.dumps([{'chainId': 'solana', 'baseToken': {'address': self.address}}]).encode())
        with patch('market.urlopen', side_effect=response):
            self.radar.poll()
        self.assertEqual(self.radar.status()['snapshots'], [])
