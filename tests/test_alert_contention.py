import tempfile
import threading
import time
import unittest
from alerts import TokenAlerts
from desktop_store import DesktopStore
from token_monitor import TokenMonitor


class AlertContentionTests(unittest.TestCase):
    def test_stop_remains_responsive_and_cancels_alert_waiting_for_database(self):
        with tempfile.TemporaryDirectory() as directory:
            store = DesktopStore(directory)
            alerts = TokenAlerts(store.connect)
            monitor = TokenMonitor(alerts)
            monitor.control(True)
            generation = monitor.generation
            entered = threading.Event()
            errors = []

            def evaluate():
                entered.set()
                try:
                    alerts.evaluate('base', 'abc', {'net_inflow_m5_usd': 125000}, gate=lambda: monitor.alert_gate(generation))
                except Exception as error:
                    errors.append(error)

            with store.connect() as blocker:
                blocker.execute('BEGIN IMMEDIATE')
                worker = threading.Thread(target=evaluate)
                worker.start()
                self.assertTrue(entered.wait(1))
                time.sleep(0.05)
                started = time.monotonic()
                monitor.control(False)
                self.assertLess(time.monotonic() - started, 0.5)
            worker.join(2)
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(alerts.recent(), [])
