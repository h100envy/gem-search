import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
from alerts import TokenAlerts
from telegram_alerts import TelegramDelivery


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.old = app.DATA, app.DB
        app.DATA = self.root
        app.DB = self.root / 'test.sqlite'
        app.init()
        self.alerts = TokenAlerts(app.connect)
        self.delivery = TelegramDelivery(app.connect, self.root)
        (self.root / '.env.telegram').write_text('TELEGRAM_BOT_TOKEN=123:test_token\nTELEGRAM_CHAT_ID=123\n')
        self.alerts.evaluate('base', 'a', {'net_inflow_m5_usd': 120000})

    def tearDown(self):
        app.DATA, app.DB = self.old
        self.temp.cleanup()

    def test_send_and_persistent_deduplication(self):
        with patch('telegram_alerts.urlopen', return_value=io.BytesIO(json.dumps({'ok': True}).encode())) as request:
            self.delivery.tick()
            TelegramDelivery(app.connect, self.root).tick()
        self.assertEqual(request.call_count, 1)
        self.assertEqual(self.delivery.status()['deliveries'], {'sent': 1})

    def test_ambiguous_delivery_is_not_retried(self):
        with patch('telegram_alerts.urlopen', side_effect=TimeoutError) as request:
            self.delivery.tick()
            self.delivery.tick()
        self.assertEqual(request.call_count, 1)
        self.assertEqual(self.delivery.status()['deliveries'], {'uncertain': 1})
