import tempfile
import time
import unittest
from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication, QPushButton
from desktop import DesktopWindow
from desktop_store import DesktopStore
from filter_dialog import FilterDialog


class FilterWorkflowTests(unittest.TestCase):
    def test_apply_changes_rows_and_displayed_window_then_survives_refresh(self):
        app = QApplication.instance() or QApplication([])
        with tempfile.TemporaryDirectory() as directory:
            store = DesktopStore(directory)
            for address, daily, recent in [('daily', 1200, 2), ('recent', 500, 1500)]:
                store.record('solana', address, {'name': address, 'data_source': 'DexScreener', 'market_cap_usd': 50000, 'market_cap_updated_at': time.time(), 'liquidity_usd': 10000, 'statistics_sampled_at': time.time(), 'buy_count_h24': daily, 'sell_count_h24': 1, 'buy_count_m5': recent, 'sell_count_m5': 3, 'volume_h24_usd': 200000, 'volume_m5_usd': 100, 'price_change_h24_pct': -5, 'price_change_m5_pct': 10})
                store.watch('solana', address)
            window = DesktopWindow(store, background=False)
            def apply(timeframe):
                def click():
                    dialog = app.activeModalWidget()
                    self.assertIsInstance(dialog, FilterDialog)
                    dialog.timeframe.setCurrentIndex(dialog.timeframe.findData(timeframe))
                    dialog.fields['buys_min'].setText('1000')
                    next(button for button in dialog.findChildren(QPushButton) if button.text() == 'Apply').click()
                QTimer.singleShot(50, click)
                window.open_filters()
            apply('h24')
            model = window.tables['Live tokens'].model()
            self.assertEqual([r['address'] for r in model.records], ['daily'])
            self.assertEqual(model.cells[0][7], '1200 / 1')
            self.assertEqual(model.headings[7], 'B/S 24H')
            self.assertEqual(model.cells[0][5], '-5.00%')
            self.assertIn('1 matching tokens', window.filter_summary_label.text())
            self.assertEqual(store.get('token_filters')['buys_min'], 1000)
            window.background = True
            window.accept_snapshot({'tokens': store.tokens(), 'alerts': [], 'watchlist': store.watchlist()})
            self.assertEqual([r['address'] for r in model.records], ['daily'])
            self.assertEqual(model.cells[0][7], '1200 / 1')
            window.background = False
            apply('m5')
            self.assertEqual([r['address'] for r in model.records], ['recent'])
            self.assertEqual(model.headings[7], 'B/S 5M')
            self.assertEqual(model.cells[0][7], '1500 / 3')
            self.assertEqual(window.tables['Watchlist'].rowCount(), 1)
            window.quit_app()
            reopened = DesktopWindow(store, background=False)
            self.assertEqual(reopened.tables['Live tokens'].model().cells[0][7], '1500 / 3')
            self.assertEqual(reopened.applied_filters['timeframe'], 'm5')
            reopened.quit_app()
