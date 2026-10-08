import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from token_monitor import net_swaps


class SwapTests(unittest.TestCase):
    def trade(self, identity, kind, amount, stamp):
        return {'id': identity, 'attributes': {'kind': kind, 'volume_in_usd': str(amount), 'block_timestamp': datetime.fromtimestamp(stamp, timezone.utc).isoformat()}}

    def test_buys_minus_sells_with_window_and_deduplication(self):
        buy = self.trade('a', 'buy', 160000, 900)
        trades = [buy, buy, self.trade('b', 'sell', 40000, 950), self.trade('c', 'buy', 50000, 699)]
        self.assertEqual(net_swaps(trades, 1000), 120000)

    def test_truncated_active_window_is_not_alertable(self):
        self.assertIsNone(net_swaps([self.trade(str(i), 'buy', 1000, 950) for i in range(300)], 1000))

    def test_invalid_and_future_data_are_not_alertable(self):
        self.assertIsNone(net_swaps([self.trade('a', 'buy', float('nan'), 950)], 1000))
        self.assertIsNone(net_swaps([self.trade('a', 'buy', 50000, 1100)], 1000))

    def test_negative_net_is_preserved(self):
        self.assertEqual(net_swaps([self.trade('a', 'sell', 50000, 950)], 1000), -50000)
