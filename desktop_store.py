from contextlib import contextmanager
import json
import re
import sqlite3
import time
from pathlib import Path


from chains import EVM, address_key
from storage_budget import StorageBudget


class DesktopStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.db = self.directory / 'tokens.sqlite'
        self.storage = StorageBudget(self.directory)
        with self.connect() as con:
            con.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS desktop_settings (key TEXT PRIMARY KEY,payload TEXT);
            CREATE TABLE IF NOT EXISTS desktop_tokens (chain TEXT,address TEXT,updated REAL,payload TEXT,PRIMARY KEY(chain,address));
            CREATE TABLE IF NOT EXISTS desktop_watchlist (chain TEXT,address TEXT,PRIMARY KEY(chain,address));
            ''')

    @contextmanager
    def connect(self):
        con = sqlite3.connect(self.db, timeout=15)
        con.row_factory = sqlite3.Row
        try:
            with con:
                yield con
                if con.total_changes:
                    self.storage.require_space()
        finally:
            con.close()

    def get(self, key, default=None):
        with self.connect() as con:
            row = con.execute('SELECT payload FROM desktop_settings WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set(self, key, value):
        with self.connect() as con:
            con.execute('INSERT OR REPLACE INTO desktop_settings VALUES (?,?)', (key, json.dumps(value)))

    def record(self, chain, address, fields):
        with self.connect() as con:
            row = con.execute('SELECT payload FROM desktop_tokens WHERE chain=? AND address=?', (chain, address)).fetchone()
            payload = json.loads(row[0]) if row else {'chain': chain, 'address': address, 'name': address, 'first_seen': time.time()}
            payload.update(fields)
            con.execute('INSERT OR REPLACE INTO desktop_tokens VALUES (?,?,?,?)', (chain, address, time.time(), json.dumps(payload)))

    def tokens(self):
        with self.connect() as con:
            return [json.loads(r[0]) for r in con.execute('SELECT payload FROM desktop_tokens ORDER BY updated DESC LIMIT 2000')]

    def watchlist(self):
        with self.connect() as con:
            return [(r[0], r[1]) for r in con.execute('SELECT chain,address FROM desktop_watchlist')]

    def watch(self, chain, address):
        if chain in EVM:
            key = address_key(chain, address)
            if not key:
                raise ValueError('Enter a valid EVM token address')
            address = key[1]
        if not re.fullmatch(r'[a-z0-9_-]{1,40}', chain) or not re.fullmatch(r'[A-Za-z0-9:_-]{2,128}', address):
            raise ValueError('Enter a network ID and a token address')
        with self.connect() as con:
            if con.execute('SELECT COUNT(*) FROM desktop_watchlist').fetchone()[0] >= 20:
                raise ValueError('This release supports 20 watched tokens')
            con.execute('INSERT OR IGNORE INTO desktop_watchlist VALUES (?,?)', (chain, address))
        self.record(chain, address, {})

    def unwatch(self, chain, address):
        with self.connect() as con:
            con.execute('DELETE FROM desktop_watchlist WHERE chain=? AND address=?', (chain, address))
