import json
import math
import time


class TokenAlerts:
    def __init__(self, connect):
        self.connect = connect
        with connect() as con:
            con.executescript('''
            CREATE TABLE IF NOT EXISTS token_alerts (
              id INTEGER PRIMARY KEY, chain TEXT, address TEXT, rule TEXT,
              captured REAL, value REAL, payload TEXT);
            CREATE TABLE IF NOT EXISTS token_alert_state (
              chain TEXT, address TEXT, rule TEXT, active INTEGER,
              PRIMARY KEY(chain,address,rule));
            ''')

    def evaluate(self, chain, address, metrics, captured=None):
        captured = time.time() if captured is None else captured
        checks = {}
        inflow = metrics.get('net_inflow_m5_usd')
        if type(inflow) in (int, float) and math.isfinite(inflow):
            checks['net_inflow_100k_5m'] = (inflow > 100000, inflow)
        cap = metrics.get('market_cap_usd')
        created = metrics.get('token_created_at')
        if self.number(cap) and self.number(created) and 0 <= captured - created < 300:
            checks['market_cap_40k_before_5m'] = (cap >= 40000, cap)
        emitted = []
        with self.connect() as con:
            for rule, (active, value) in checks.items():
                previous = con.execute('SELECT active FROM token_alert_state WHERE chain=? AND address=? AND rule=?', (chain, address, rule)).fetchone()
                if active and (previous is None or not previous[0]):
                    alert = {'chain': chain, 'address': address, 'rule': rule, 'captured_at': captured, 'value_usd': value, 'source': metrics.get('source'), 'creation_source': metrics.get('creation_source')}
                    cursor = con.execute('INSERT INTO token_alerts(chain,address,rule,captured,value,payload) VALUES (?,?,?,?,?,?)', (chain, address, rule, captured, value, json.dumps(alert)))
                    alert['id'] = cursor.lastrowid
                    emitted.append(alert)
                con.execute('INSERT OR REPLACE INTO token_alert_state VALUES (?,?,?,?)', (chain, address, rule, int(active)))
            con.execute('DELETE FROM token_alerts WHERE id NOT IN (SELECT id FROM token_alerts ORDER BY id DESC LIMIT 10000)')
        return emitted

    @staticmethod
    def number(value):
        return type(value) in (int, float) and math.isfinite(value) and value >= 0

    def recent(self):
        with self.connect() as con:
            rows = con.execute('SELECT id,payload FROM token_alerts ORDER BY id DESC LIMIT 100').fetchall()
        return [dict(json.loads(row['payload']), id=row['id']) for row in rows]
