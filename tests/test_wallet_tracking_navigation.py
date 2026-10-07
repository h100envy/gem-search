import tempfile
import unittest
from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QDialog
from desktop import DesktopWindow
from desktop_store import DesktopStore
from wallet_ingestion import WalletIngestion, balance_events
from tests.test_wallet_ingestion import transaction, WALLET


class TrackingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = DesktopStore(self.directory.name)

    def test_tracking_persists_and_removal_preserves_history(self):
        collector = WalletIngestion(self.store)
        collector.track(WALLET, 'Example')
        self.assertEqual(WalletIngestion(self.store).tracked()[0]['name'], 'Example')
        collector.untrack(WALLET)
        self.assertEqual(collector.tracked(), [])

    def test_duplicate_wallet_is_not_added_twice(self):
        collector = WalletIngestion(self.store)
        collector.track(WALLET)
        collector.track(WALLET)
        self.assertEqual(len(collector.tracked()), 1)

    def test_invalid_wallet_is_rejected(self):
        with self.assertRaises(ValueError):
            WalletIngestion(self.store).track('../private')

    def test_incoming_unsigned_owner_is_included_when_tracked(self):
        tx = transaction()
        tx['transaction']['message']['accountKeys'][0]['signer'] = False
        self.assertEqual(balance_events(tx, 'signature'), [])
        self.assertEqual(balance_events(tx, 'signature', {WALLET})[0]['wallet'], WALLET)

    def test_native_sol_change_is_exact_and_includes_fees(self):
        tx = transaction()
        tx['meta'].update(preBalances=[1000000000], postBalances=[999995000])
        event = next(row for row in balance_events(tx, 'signature') if row['mint'] == 'SOL')
        self.assertEqual(event['delta'], '-0.000005000')
        self.assertIn('including fees', event['kind'])
        self.assertEqual(event['classification'], 'Unknown')

    def test_wallet_target_collects_without_token_watchlist(self):
        calls = []
        def request(method, params):
            calls.append((method, params))
            return [{'signature': 'signature'}] if method == 'getSignaturesForAddress' else transaction()
        collector = WalletIngestion(self.store, request)
        collector.track(WALLET)
        collector.poll()
        self.assertEqual(calls[0][1][0], WALLET)
        self.assertEqual(collector.snapshot()['counts']['complete'], 1)
        self.assertEqual(len(collector.snapshot()['wallet_events'][WALLET]), 1)

    def test_untracked_queue_does_not_keep_requesting(self):
        collector = WalletIngestion(self.store, lambda method, params: [{'signature': 'signature'}])
        collector.track(WALLET)
        collector.discover(WALLET)
        collector.untrack(WALLET)
        collector.request = lambda method, params: self.fail('Stopped wallet requested')
        collector.poll()
        self.assertEqual(collector.snapshot()['counts'], {'pending': 1})

    def test_cached_transaction_can_be_redecoded_for_new_wallet(self):
        tx = transaction()
        tx['transaction']['message']['accountKeys'][0]['signer'] = False
        collector = WalletIngestion(self.store, lambda method, params: [{'signature': 'signature'}] if method == 'getSignaturesForAddress' else tx)
        collector.discover(WALLET)
        collector.process('signature')
        self.assertEqual(collector.snapshot()['events'], [])
        collector.track(WALLET)
        collector.discover(WALLET)
        collector.request = lambda method, params: self.fail('Cached transaction requested again')
        collector.process('signature')
        self.assertEqual(len(collector.snapshot()['wallet_events'][WALLET]), 1)

    def test_backfill_does_not_replace_newer_events_with_older_events(self):
        def request(method, params):
            if method == 'getSignaturesForAddress':
                return [{'signature': 'newer'}, {'signature': 'older'}]
            tx = transaction(params[0])
            tx['slot'] = 200 if params[0] == 'newer' else 100
            return tx
        collector = WalletIngestion(self.store, request)
        collector.track(WALLET)
        collector.discover(WALLET)
        collector.process('newer')
        collector.process('older')
        snapshot = collector.snapshot()
        self.assertEqual(snapshot['events'][0]['signature'], 'newer')
        self.assertEqual(snapshot['wallet_events'][WALLET][0]['signature'], 'newer')


class NavigationTests(unittest.TestCase):
    def setUp(self):
        self.app = QApplication.instance() or QApplication([])
        self.directory = tempfile.TemporaryDirectory()
        self.store = DesktopStore(self.directory.name)
        self.window = DesktopWindow(self.store, background=False)
        self.window.show()
        self.window.activateWindow()
        self.app.processEvents()

    def tearDown(self):
        self.window.quit_app()
        self.window.deleteLater()
        self.app.processEvents()
        self.directory.cleanup()

    def test_escape_clears_search_and_returns_to_live_tokens(self):
        self.window.search.setText('example')
        self.window.search.setFocus()
        QTest.keyClick(self.window.search, Qt.Key.Key_Escape)
        self.app.processEvents()
        self.assertEqual(self.window.search.text(), '')
        self.window.tabs.setCurrentWidget(self.window.kol_page)
        self.window.kol_page.search.setFocus()
        QTest.keyClick(self.window.kol_page.search, Qt.Key.Key_Escape)
        self.app.processEvents()
        self.assertEqual(self.window.tabs.currentIndex(), 0)

    def test_escape_closes_dialog_without_clearing_parent_search(self):
        self.window.search.setText('example')
        dialog = QDialog(self.window)
        dialog.setModal(True)
        dialog.show()
        self.app.processEvents()
        QTest.keyClick(dialog, Qt.Key.Key_Escape)
        self.app.processEvents()
        self.assertFalse(dialog.isVisible())
        self.assertEqual(self.window.search.text(), 'example')

    def test_directory_wallet_tracking_populates_selector_and_can_stop(self):
        self.window.kol_page.search.setText('Cupsey')
        self.window.kol_page.table.selectRow(0)
        self.window.track_directory_wallet()
        self.assertEqual(self.window.tabs.currentIndex(), self.window.wallet_activity_tab)
        self.assertEqual(self.window.wallet_selector.currentText(), 'Cupsey')
        self.assertEqual(self.window.ingestion.tracked()[0]['name'], 'Cupsey')
        self.assertIn('1 tracked wallets', self.window.wallet_status.text())
        self.window.untrack_wallet()
        self.assertEqual(self.window.ingestion.tracked(), [])
        self.assertFalse(self.window.stop_wallet.isEnabled())


if __name__ == '__main__':
    unittest.main()
