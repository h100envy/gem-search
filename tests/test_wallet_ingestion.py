import json
import tempfile
import unittest
from desktop_store import DesktopStore
from wallet_ingestion import WalletIngestion, balance_events


WALLET = '11111111111111111111111111111111'
MINT = 'So11111111111111111111111111111111111111112'
POOL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'


def transaction(signature='signature', before='100', after='250'):
    def balance(amount):
        return {'accountIndex': 1, 'mint': MINT, 'owner': WALLET, 'uiTokenAmount': {'amount': amount, 'decimals': 2}}
    return {'slot': 123, 'blockTime': 1000, 'transaction': {'signatures': [signature], 'message': {'accountKeys': [{'pubkey': WALLET, 'signer': True}]}}, 'meta': {'err': None, 'preTokenBalances': [balance(before)], 'postTokenBalances': [balance(after)]}}


class WalletIngestionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = DesktopStore(self.directory.name)

    def test_exact_delta_and_unknown_classification(self):
        event = balance_events(transaction(), 'signature')[0]
        self.assertEqual(event['delta'], '1.50')
        self.assertEqual(event['delta_raw'], '150')
        self.assertEqual(event['classification'], 'Unknown')
        self.assertNotIn('side', event)
        self.assertNotIn('usd', event)

    def test_transfer_remains_balance_change(self):
        self.assertEqual(balance_events(transaction(), 'signature')[0]['kind'], 'Token balance change')

    def test_unsigned_pool_owner_is_not_wallet(self):
        tx = transaction()
        tx['transaction']['message']['accountKeys'][0]['signer'] = False
        self.assertEqual(balance_events(tx, 'signature'), [])

    def test_failed_transaction_has_no_events(self):
        tx = transaction()
        tx['meta']['err'] = {'InstructionError': [0, 'Custom']}
        self.assertEqual(balance_events(tx, 'signature'), [])

    def test_no_balance_change(self):
        self.assertEqual(balance_events(transaction(after='100'), 'signature'), [])

    def test_negative_delta(self):
        self.assertEqual(balance_events(transaction(after='0'), 'signature')[0]['delta'], '-1.00')

    def test_created_account(self):
        tx = transaction()
        tx['meta']['preTokenBalances'] = []
        self.assertEqual(balance_events(tx, 'signature')[0]['delta_raw'], '250')

    def test_closed_account(self):
        tx = transaction()
        tx['meta']['postTokenBalances'] = []
        self.assertEqual(balance_events(tx, 'signature')[0]['delta_raw'], '-100')

    def test_decimal_change_rejected(self):
        tx = transaction()
        tx['meta']['postTokenBalances'][0]['uiTokenAmount']['decimals'] = 3
        with self.assertRaises(ValueError):
            balance_events(tx, 'signature')

    def test_owner_change_rejected(self):
        tx = transaction()
        tx['meta']['postTokenBalances'][0]['owner'] = POOL
        with self.assertRaises(ValueError):
            balance_events(tx, 'signature')

    def test_large_integer_precision(self):
        tx = transaction(before='0', after=str(2 ** 64 - 1))
        self.assertEqual(balance_events(tx, 'signature')[0]['delta'], '184467440737095516.15')

    def test_restart_and_duplicate_protection(self):
        request = lambda method, params: [{'signature': 'signature', 'err': None}] if method == 'getSignaturesForAddress' else transaction()
        collector = WalletIngestion(self.store, request)
        collector.discover(POOL)
        collector.process('signature')
        restarted = WalletIngestion(self.store, request)
        restarted.discover(POOL)
        restarted.process('signature')
        self.assertEqual(restarted.snapshot()['counts'], {'complete': 1})
        self.assertEqual(len(restarted.snapshot()['events']), 1)

    def test_checkpoint_pagination_survives_restart(self):
        collector = WalletIngestion(self.store, lambda method, params: [{'signature': 'old', 'err': None}])
        collector.discover(POOL)
        collector.request = lambda method, params: [{'signature': 'new' + str(i), 'err': None} for i in range(100)]
        collector.discover(POOL)
        with self.store.connect() as con:
            row = con.execute('SELECT * FROM wallet_cursors').fetchone()
            self.assertEqual(row['tip'], 'old')
            self.assertEqual(row['before_signature'], 'new99')
        calls = []
        def request(method, params):
            calls.append(params)
            return [{'signature': 'middle', 'err': None}]
        WalletIngestion(self.store, request).discover(POOL)
        self.assertEqual(calls[0][1]['before'], 'new99')
        self.assertEqual(calls[0][1]['until'], 'old')
        with self.store.connect() as con:
            row = con.execute('SELECT * FROM wallet_cursors').fetchone()
            self.assertEqual(row['tip'], 'new0')
            self.assertIsNone(row['before_signature'])

    def test_missing_transaction_remains_retryable(self):
        collector = WalletIngestion(self.store, lambda method, params: [{'signature': 'signature'}] if method == 'getSignaturesForAddress' else None)
        collector.discover(POOL)
        collector.process('signature')
        self.assertEqual(collector.snapshot()['counts'], {'pending': 1})
        with self.store.connect() as con:
            row = con.execute('SELECT * FROM wallet_transactions').fetchone()
            self.assertEqual(row['attempts'], 1)
            self.assertGreater(row['retry_at'], 0)

    def test_signature_mismatch_not_stored_as_success(self):
        collector = WalletIngestion(self.store, lambda method, params: [{'signature': 'signature'}] if method == 'getSignaturesForAddress' else transaction('other'))
        collector.discover(POOL)
        collector.process('signature')
        self.assertEqual(collector.snapshot()['counts'], {'pending': 1})
        self.assertEqual(collector.snapshot()['events'], [])

    def test_invalid_discovery_does_not_move_checkpoint(self):
        collector = WalletIngestion(self.store, lambda method, params: {'error': 'bad'})
        with self.assertRaises(ValueError):
            collector.discover(POOL)
        with self.store.connect() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM wallet_cursors').fetchone()[0], 0)

    def test_stopped_collector_makes_no_requests(self):
        collector = WalletIngestion(self.store, lambda method, params: self.fail('Unexpected request'))
        collector.poll(lambda: False)

    def test_only_watched_solana_pool_collected(self):
        self.store.watch('solana', MINT)
        self.store.record('solana', MINT, {'market_pair': POOL})
        calls = []
        collector = WalletIngestion(self.store, lambda method, params: calls.append((method, params)) or [])
        collector.poll()
        self.assertEqual(calls[0][1][0], POOL)
        self.assertEqual(calls[0][1][1]['commitment'], 'finalized')
        self.assertEqual(collector.state['pools'], 1)

    def test_desktop_displays_events_and_verifiable_transaction(self):
        from PySide6.QtWidgets import QApplication
        from desktop import DesktopWindow
        app = QApplication.instance() or QApplication([])
        collector = WalletIngestion(self.store, lambda method, params: [{'signature': 'signature'}] if method == 'getSignaturesForAddress' else transaction())
        collector.discover(POOL)
        collector.process('signature')
        window = DesktopWindow(self.store, background=False)
        try:
            model = window.wallet_table.model()
            self.assertEqual(model.rowCount(), 1)
            self.assertEqual(model.cells[0][1], WALLET)
            self.assertEqual(model.cells[0][3], '1.50')
            self.assertEqual(model.cells[0][4], 'Unknown')
            self.assertEqual(model.records[0]['signature'], 'signature')
            self.assertIn('1 collected', window.wallet_status.text())
            window.refresh()
            self.assertEqual(model.rowCount(), 1)
        finally:
            window.quit_app()
            window.deleteLater()
            app.processEvents()


if __name__ == '__main__':
    unittest.main()
