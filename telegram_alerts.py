import json
import re
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class TelegramDelivery:
    def __init__(self, connect, root):
        self.connect = connect
        self.path = root / '.env.telegram'
        self.error = None
        with connect() as con:
            con.execute('CREATE TABLE IF NOT EXISTS alert_delivery (id INTEGER PRIMARY KEY, status TEXT, updated REAL)')
            con.execute("UPDATE alert_delivery SET status='uncertain' WHERE status='sending'")

    def config(self):
        values = {}
        if self.path.exists():
            for line in self.path.read_text().splitlines():
                key, sep, value = line.partition('=')
                if sep and key in ('TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'):
                    values[key] = value.strip()
        return values

    def status(self):
        config = self.config()
        with self.connect() as con:
            counts = {r[0]: r[1] for r in con.execute('SELECT status,COUNT(*) FROM alert_delivery GROUP BY status')}
        return {'configured': bool(config.get('TELEGRAM_BOT_TOKEN') and config.get('TELEGRAM_CHAT_ID')), 'error': self.error, 'deliveries': counts}

    def tick(self):
        config = self.config()
        token = config.get('TELEGRAM_BOT_TOKEN', '')
        chat = config.get('TELEGRAM_CHAT_ID', '')
        if not re.fullmatch(r'[0-9]+:[A-Za-z0-9_-]+', token) or not re.fullmatch(r'-?[0-9]+', chat):
            return
        with self.connect() as con:
            rows = con.execute('SELECT id,payload FROM token_alerts WHERE id NOT IN (SELECT id FROM alert_delivery) ORDER BY id LIMIT 5').fetchall()
        for row in rows:
            alert = json.loads(row['payload'])
            label = 'Net swap inflow over 5 minutes' if alert['rule'] == 'net_inflow_100k_5m' else 'Market cap reached before token age 5 minutes'
            text = label + '\n' + alert['chain'] + '\n' + alert['address'] + '\n$' + format(alert['value_usd'], ',.2f') + '\nSource: ' + str(alert.get('source', ''))
            body = json.dumps({'chat_id': chat, 'text': text, 'disable_notification': False}).encode()
            with self.connect() as con:
                cursor = con.execute("INSERT OR IGNORE INTO alert_delivery VALUES (?,'sending',?)", (row['id'], time.time()))
                if not cursor.rowcount:
                    continue
            state = 'uncertain'
            try:
                with urlopen(Request('https://api.telegram.org/bot' + token + '/sendMessage', data=body, headers={'Content-Type': 'application/json'}), timeout=15) as response:
                    result = json.loads(response.read(100000))
                if result.get('ok'):
                    state = 'sent'
                    self.error = None
                else:
                    state = 'rejected'
                    self.error = 'Telegram rejected delivery'
            except HTTPError:
                state = 'rejected'
                self.error = 'Telegram rejected delivery; check local configuration'
            except Exception:
                self.error = 'Telegram delivery uncertain; no automatic resend'
            with self.connect() as con:
                con.execute('UPDATE alert_delivery SET status=?,updated=? WHERE id=?', (state, time.time(), row['id']))
