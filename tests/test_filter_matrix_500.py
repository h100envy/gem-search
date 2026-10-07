import tempfile
import time
import unittest
from unittest.mock import patch
from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication, QPushButton
from chains import CHAINS
from desktop import DesktopWindow
from desktop_store import DesktopStore
from filter_dialog import FilterDialog
from token_filters import DEFAULTS, RANGES, activity_values, matches
from dex_monitor import select_pairs


WINDOWS = ['m5', 'h1', 'h6', 'h24']
NOW = 1700000000


def record():
    row = {'name': 'Fixture', 'chain': 'solana', 'address': 'fixture', 'market_cap_usd': 50000, 'market_cap_updated_at': NOW, 'liquidity_usd': 15000, 'statistics_sampled_at': NOW, 'fdv_usd': 150000, 'pair_created_at': (NOW - 5400) * 1000}
    for window in WINDOWS:
        row.update({f'buy_count_{window}': 150, f'sell_count_{window}': 0, f'volume_{window}_usd': 150, f'price_change_{window}_pct': 0})
    return row


class RangeMatrix(unittest.TestCase):
    pass


def range_case(metric, window, variant):
    def test(self):
        row = record()
        lower, upper = {'liquidity': (10000, 20000), 'cap': (40000, 80000), 'fdv': (100000, 200000), 'age': (1, 2), 'change': (-10, 10)}.get(metric, (100, 200))
        values = [lower - 1, lower, (lower + upper) / 2, upper, upper + 1, None, float('nan'), float('inf'), True, (lower + upper) / 2]
        value = values[variant]
        field = {'liquidity': 'liquidity_usd', 'cap': 'market_cap_usd', 'fdv': 'fdv_usd', 'age': 'pair_created_at', 'transactions': f'buy_count_{window}', 'buys': f'buy_count_{window}', 'sells': f'sell_count_{window}', 'volume': f'volume_{window}_usd', 'change': f'price_change_{window}_pct'}[metric]
        row[field] = (NOW - value * 3600) * 1000 if metric == 'age' and type(value) in (int, float) else value
        if variant == 9:
            row['statistics_sampled_at'] = NOW - 181
        settings = dict(DEFAULTS, timeframe=window, **{metric + '_min': lower, metric + '_max': upper})
        with patch('token_filters.time.time', return_value=NOW):
            self.assertEqual(matches(row, settings), variant in [1, 2, 3])
    return test


for metric, label in RANGES:
    for window in WINDOWS:
        for variant in range(10):
            setattr(RangeMatrix, f'test_{metric}_{window}_{variant:02d}', range_case(metric, window, variant))


class DisplayMatrix(unittest.TestCase):
    pass


def display_case(window, metric, variant):
    def test(self):
        row = record()
        field = {'buys': 'buy_count_', 'sells': 'sell_count_', 'volume': 'volume_', 'change': 'price_change_'}[metric] + window + ('_usd' if metric == 'volume' else '_pct' if metric == 'change' else '')
        row[field] = 123
        expected = 123
        if variant == 1:
            row[field] = None
            other = WINDOWS[(WINDOWS.index(window) + 1) % 4]
            row[field.replace(window, other)] = 9999
            expected = None
        elif variant == 2:
            row[field] = float('nan')
            expected = None
        elif variant == 3:
            row['statistics_sampled_at'] = NOW - 181
            expected = None
        elif variant == 4:
            row[field] = -5 if metric == 'change' else 0
            expected = row[field]
        with patch('token_filters.time.time', return_value=NOW):
            self.assertEqual(activity_values(row, window)[metric], expected)
    return test


for window in WINDOWS:
    for metric in ['buys', 'sells', 'volume', 'change']:
        for variant in range(5):
            setattr(DisplayMatrix, f'test_{window}_{metric}_{variant}', display_case(window, metric, variant))


class WorkflowMatrix(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = DesktopStore(self.temporary.name)
        self.window = None

    def tearDown(self):
        if self.window:
            self.window.quit_app()
            self.window.deleteLater()
            self.app.processEvents()
        self.temporary.cleanup()

    def edit(self, action, chain):
        def click():
            dialog = self.app.activeModalWidget()
            self.assertIsInstance(dialog, FilterDialog)
            dialog.chain.setCurrentIndex(dialog.chain.findData(chain))
            dialog.timeframe.setCurrentIndex(dialog.timeframe.findData('h24'))
            dialog.fields['buys_min'].setText('1000')
            if action == 'reset':
                next(button for button in dialog.findChildren(QPushButton) if button.text() == 'Reset').click()
            next(button for button in dialog.findChildren(QPushButton) if button.text() == ('Cancel' if action == 'cancel' else 'Apply')).click()
        QTimer.singleShot(5, click)
        self.window.filter_button.click()


def workflow_case(chain, action):
    def test(self):
        count = 120 if action == 'pagination' else 2
        for index in range(count):
            address = 'fixture-' + str(index) if chain == 'solana' else '0x' + format(index + 1, '040x')
            self.store.record(chain, address, {'name': 'Fixture ' + str(index), 'data_source': 'DexScreener', 'market_cap_usd': 50000 + index, 'market_cap_updated_at': time.time(), 'liquidity_usd': 20000, 'statistics_sampled_at': time.time(), 'buy_count_h24': 2000 if index % 2 == 0 else 100, 'sell_count_h24': 1, 'buy_count_m5': 2 if index % 2 == 0 else 1500, 'sell_count_m5': 3})
        initial = dict(DEFAULTS, buys_min=1000, chain=chain)
        if action in ['cancel', 'reset']:
            self.store.set('token_filters', initial)
        self.window = DesktopWindow(self.store, background=False)
        if action == 'pagination':
            combo = self.window.page_sizes['Live tokens']
            combo.setCurrentIndex(combo.findData(100))
            self.assertEqual(self.window.tables['Live tokens'].rowCount(), 100)
            self.window.page_buttons['Live tokens'][1].click()
            self.assertEqual(self.window.tables['Live tokens'].rowCount(), 20)
        self.edit(action, chain)
        model = self.window.tables['Live tokens'].model()
        expected = count if action == 'reset' else count // 2
        self.assertEqual(model.rowCount(), expected)
        if action != 'reset':
            for cells in model.cells:
                self.assertGreaterEqual(int(cells[7]), 1000)
        self.assertEqual(model.headings[7], 'Buys 24H')
        if action == 'cancel':
            self.assertEqual(self.window.applied_filters, initial)
        if action == 'pagination':
            self.assertEqual(self.window.pages['Live tokens'], 0)
        if action == 'persistence':
            self.window.quit_app()
            self.window = DesktopWindow(self.store, background=False)
            self.assertEqual(self.window.applied_filters['buys_min'], 1000)
            self.assertEqual(self.window.tables['Live tokens'].rowCount(), 1)
        self.window.background = True
        self.window.accept_snapshot({'tokens': self.store.tokens(), 'alerts': [], 'watchlist': []})
        self.assertEqual(self.window.tables['Live tokens'].rowCount(), expected)
        self.window.background = False
    return test


for chain in CHAINS:
    for action in ['apply', 'reset', 'cancel', 'pagination', 'persistence']:
        setattr(WorkflowMatrix, f'test_{chain}_{action}', workflow_case(chain, action))


class PairMatrix(unittest.TestCase):
    pass


def pair_case(chain, variant):
    def test(self):
        address = 'So11111111111111111111111111111111111111112' if chain == 'solana' else '0x' + 'a' * 40
        pair = {'chainId': chain, 'baseToken': {'address': address}, 'pairAddress': 'pair', 'marketCap': 50000, 'fdv': 90000, 'liquidity': {'usd': 20000}, 'priceUsd': '0.00001', 'volume': {'m5': 20}, 'txns': {'m5': {'buys': 3, 'sells': 1}}}
        if variant == 0:
            pair['marketCap'] = None
        elif variant == 1:
            pair['marketCap'] = float('nan')
        elif variant == 2:
            pair['marketCap'] = True
        elif variant == 3:
            pair['priceUsd'] = 'NaN'
        else:
            pair['chainId'] = 'unsupported'
        result = select_pairs([pair], {address}, time.time(), chain)
        if variant == 4:
            self.assertEqual(result, {})
        else:
            fields = result[address]
            self.assertIsNone(fields['net_inflow_m5_usd'])
            self.assertIsNone(fields['market_cap_usd'] if variant < 3 else fields['price_usd'])
            self.assertEqual(fields['fdv_usd'], 90000)
    return test


for chain in ['solana', 'ethereum', 'base', 'bsc']:
    for variant in range(5):
        setattr(PairMatrix, f'test_{chain}_{variant}', pair_case(chain, variant))
