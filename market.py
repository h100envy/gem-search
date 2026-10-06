import json
import re
import threading
import time
import queue
import shutil
import subprocess
from pathlib import Path
from urllib.request import Request, urlopen


class MarketRadar:
    def __init__(self, connect):
        self.connect = connect
        self.lock = threading.Lock()
        self.enabled = False
        self.expires = None
        self.error = None
        self.last_poll = 0
        self.pump_enabled = False
        self.pump_expires = None
        self.pump_error = None
        self.pump_connected = False
        self.pump_process = None
        with connect() as con:
            con.executescript('''
            CREATE TABLE IF NOT EXISTS market_watch (address TEXT PRIMARY KEY, created REAL);
            CREATE TABLE IF NOT EXISTS market_snapshots (id INTEGER PRIMARY KEY, address TEXT, captured REAL, payload TEXT);
            CREATE TABLE IF NOT EXISTS pump_events (id INTEGER PRIMARY KEY, fingerprint TEXT UNIQUE, captured REAL, payload TEXT);
            ''')

    def watch(self, address):
        if not isinstance(address, str) or not re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}', address):
            raise ValueError('Enter a valid Solana token address')
        with self.connect() as con:
            if con.execute('SELECT COUNT(*) FROM market_watch').fetchone()[0] >= 30 and not con.execute('SELECT 1 FROM market_watch WHERE address=?', (address,)).fetchone():
                raise ValueError('Watchlist limit is 30 tokens')
            con.execute('INSERT OR IGNORE INTO market_watch VALUES (?,?)', (address, time.time()))

    def control(self, enabled, minutes=0):
        if type(enabled) is not bool or type(minutes) is not int or not 0 <= minutes <= 1440:
            raise ValueError('Use a boolean enabled and duration from 0 to 1440 minutes')
        with self.lock:
            self.enabled = enabled
            self.expires = time.time() + minutes * 60 if enabled and minutes else None
        return self.status()

    def status(self):
        with self.lock:
            if self.expires and time.time() >= self.expires:
                self.enabled = False
            enabled, expires = self.enabled, self.expires
        with self.connect() as con:
            watches = [r[0] for r in con.execute('SELECT address FROM market_watch ORDER BY created')]
            snapshots = [json.loads(r[0]) for r in con.execute('SELECT payload FROM market_snapshots ORDER BY id DESC LIMIT 100')]
            pump_events = [json.loads(r[0]) for r in con.execute('SELECT payload FROM pump_events ORDER BY id DESC LIMIT 50')]
        return {'enabled': enabled, 'expires_at': expires, 'error': self.error, 'watchlist': watches, 'snapshots': snapshots,
                'pump': {'enabled': self.pump_enabled, 'connected': self.pump_connected, 'expires_at': self.pump_expires, 'error': self.pump_error, 'events': pump_events}}

    def pump_control(self, enabled, minutes=0):
        if type(enabled) is not bool or type(minutes) is not int or not 0 <= minutes <= 1440:
            raise ValueError('Use a boolean enabled and duration from 0 to 1440 minutes')
        with self.lock:
            self.pump_enabled = enabled
            self.pump_expires = time.time() + minutes * 60 if enabled and minutes else None
            if not enabled and self.pump_process:
                self.pump_process.terminate()
        return self.status()

    def pump_loop(self, stop):
        while not stop.wait(1):
            with self.lock:
                if self.pump_expires and time.time() >= self.pump_expires:
                    self.pump_enabled = False
                if not self.pump_enabled:
                    continue
            node = shutil.which('node') or shutil.which('node.exe')
            if not node and Path('/mnt/c/Program Files/nodejs/node.exe').exists():
                node = '/mnt/c/Program Files/nodejs/node.exe'
            if not node:
                self.pump_error = 'Node.js 22 or newer is required for the Pump feed'
                stop.wait(30)
                continue
            script = Path(__file__).resolve().parent / 'scripts/pump-feed.mjs'
            script_path = str(script)
            if node.endswith('.exe') and script_path.startswith('/mnt/'):
                script_path = script_path[5].upper() + ':/' + script_path[7:]
            try:
                with self.lock:
                    if not self.pump_enabled:
                        continue
                    process = subprocess.Popen([node, script_path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                    self.pump_process = process
                lines = queue.Queue(maxsize=1000)
                def read_lines():
                    for line in process.stdout:
                        try:
                            lines.put(line, timeout=1)
                        except queue.Full:
                            pass
                threading.Thread(target=read_lines, daemon=True).start()
                while process.poll() is None and not stop.is_set():
                    with self.lock:
                        active = self.pump_enabled and (not self.pump_expires or time.time() < self.pump_expires)
                    if not active:
                        self.pump_enabled = False
                        process.terminate()
                        break
                    try:
                        line = lines.get(timeout=1)
                    except queue.Empty:
                        continue
                    data = json.loads(line)
                    with self.lock:
                        if not self.pump_enabled or self.pump_expires and time.time() >= self.pump_expires:
                            continue
                        if data.get('connected'):
                            self.pump_connected = True
                            self.pump_error = None
                        elif data.get('error'):
                            self.pump_error = data['error']
                        elif data.get('mint'):
                            data['captured_at'] = time.time()
                            data['source'] = 'pumpportal'
                            fingerprint = data['mint'] + ':' + data['txType'] + ':' + data['signature']
                            with self.connect() as con:
                                con.execute('INSERT OR IGNORE INTO pump_events(fingerprint,captured,payload) VALUES (?,?,?)', (fingerprint, data['captured_at'], json.dumps(data)))
                                con.execute('DELETE FROM pump_events WHERE id NOT IN (SELECT id FROM pump_events ORDER BY id DESC LIMIT 10000)')
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=5)
            except Exception:
                self.pump_error = 'Pump feed unavailable'
            finally:
                self.pump_connected = False
                self.pump_process = None
            stop.wait(5)

    def poll(self):
        state = self.status()
        if not state['enabled'] or time.monotonic() - self.last_poll < 60:
            return
        self.last_poll = time.monotonic()
        addresses = state['watchlist']
        if not addresses:
            return
        url = 'https://api.dexscreener.com/tokens/v1/solana/' + ','.join(addresses)
        try:
            with urlopen(Request(url, headers={'User-Agent': 'GemSearch/0.3', 'Accept': 'application/json'}), timeout=15) as response:
                raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ValueError('Market response exceeds limit')
            pairs = json.loads(raw)
            if not isinstance(pairs, list):
                raise ValueError('Invalid market response')
            captured = time.time()
            with self.lock:
                if not self.enabled or self.expires and captured >= self.expires:
                    return
                with self.connect() as con:
                    for pair in pairs[:300]:
                        if not isinstance(pair, dict) or pair.get('chainId') != 'solana':
                            continue
                        address = (pair.get('baseToken') or {}).get('address')
                        if address not in addresses:
                            continue
                        snapshot = {'address': address, 'captured_at': captured, 'source': 'dexscreener', 'pair': pair}
                        con.execute('INSERT INTO market_snapshots(address,captured,payload) VALUES (?,?,?)', (address, captured, json.dumps(snapshot)))
                    con.execute('DELETE FROM market_snapshots WHERE id NOT IN (SELECT id FROM market_snapshots ORDER BY id DESC LIMIT 10000)')
            self.error = None
        except Exception as exc:
            self.error = 'Market feed unavailable: ' + type(exc).__name__
