import json
import time
from decimal import Decimal, localcontext
from urllib.request import Request, urlopen
from chains import address_key


def rpc(method, params):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    request = Request('https://solana-rpc.publicnode.com', data=body, headers={'Content-Type': 'application/json', 'User-Agent': 'GemSearch'})
    with urlopen(request, timeout=8) as response:
        raw = response.read(4000001)
    if len(raw) > 4000000:
        raise ValueError('Transaction response exceeds limit')
    response = json.loads(raw)
    if isinstance(response, dict) and isinstance(response.get('error'), dict):
        raise ValueError('Transaction RPC error ' + str(response['error'].get('code')) + ': ' + str(response['error'].get('message'))[:180])
    if not isinstance(response, dict) or response.get('error') or 'result' not in response:
        raise ValueError('Transaction RPC rejected request')
    return response['result']


def balance_events(transaction, signature):
    meta = transaction.get('meta')
    if not isinstance(meta, dict) or meta.get('err') is not None:
        return []
    message = transaction.get('transaction', {}).get('message', {})
    keys = message.get('accountKeys', [])
    signers = {key.get('pubkey') for key in keys if isinstance(key, dict) and key.get('signer') is True}
    balances = {}
    owners = {}
    decimals = {}
    for side in ('preTokenBalances', 'postTokenBalances'):
        rows = meta.get(side)
        if not isinstance(rows, list):
            raise ValueError('Token balance metadata missing')
        for row in rows:
            index, mint = row.get('accountIndex'), row.get('mint')
            amount = row.get('uiTokenAmount') or {}
            raw, places = amount.get('amount'), amount.get('decimals')
            if type(index) is not int or index < 0 or not address_key('solana', mint) or not isinstance(raw, str) or not raw.isdigit() or type(places) is not int or not 0 <= places <= 255:
                raise ValueError('Invalid token balance')
            key = (index, mint)
            owner = row.get('owner')
            if owner:
                if key in owners and owners[key] != owner:
                    raise ValueError('Token owner changed')
                owners[key] = owner
            if key in decimals and decimals[key] != places:
                raise ValueError('Token decimals changed')
            decimals[key] = places
            balances.setdefault(key, {})[side] = int(raw)
    totals = {}
    for key, amounts in balances.items():
        owner = owners.get(key)
        if owner not in signers or not address_key('solana', owner):
            continue
        identity = (owner, key[1], decimals[key])
        totals[identity] = totals.get(identity, 0) + amounts.get('postTokenBalances', 0) - amounts.get('preTokenBalances', 0)
    events = []
    with localcontext() as context:
        context.prec = 100
        for (owner, mint, places), delta in totals.items():
            if delta:
                events.append({'signature': signature, 'wallet': owner, 'mint': mint, 'delta_raw': str(delta), 'delta': str(Decimal(delta).scaleb(-places)), 'decimals': places, 'slot': transaction['slot'], 'block_time': transaction.get('blockTime'), 'classification': 'Unknown', 'kind': 'Token balance change'})
    return events


class WalletIngestion:
    def __init__(self, store, request=rpc):
        self.store = store
        self.request = request
        self.last_poll = 0
        self.rotation = 0
        with store.connect() as con:
            con.executescript('''
            CREATE TABLE IF NOT EXISTS wallet_cursors (pool TEXT PRIMARY KEY,tip TEXT,before_signature TEXT,pending_tip TEXT,updated REAL);
            CREATE TABLE IF NOT EXISTS wallet_transactions (signature TEXT PRIMARY KEY,state TEXT NOT NULL DEFAULT 'pending',payload TEXT,attempts INTEGER NOT NULL DEFAULT 0,retry_at REAL NOT NULL DEFAULT 0,error TEXT);
            CREATE TABLE IF NOT EXISTS wallet_pool_transactions (pool TEXT,signature TEXT,PRIMARY KEY(pool,signature));
            CREATE TABLE IF NOT EXISTS wallet_balance_events (signature TEXT,wallet TEXT,mint TEXT,payload TEXT,PRIMARY KEY(signature,wallet,mint));
            ''')
        self.state = {'error': None, 'sampled_at': None, 'pools': 0}

    def discover(self, pool):
        with self.store.connect() as con:
            row = con.execute('SELECT * FROM wallet_cursors WHERE pool=?', (pool,)).fetchone()
        cursor = dict(row) if row else {}
        options = {'commitment': 'finalized', 'limit': 100}
        if cursor.get('before_signature'):
            options['before'] = cursor['before_signature']
        if cursor.get('tip'):
            options['until'] = cursor['tip']
        rows = self.request('getSignaturesForAddress', [pool, options])
        if not isinstance(rows, list) or any(not isinstance(row, dict) or not isinstance(row.get('signature'), str) for row in rows):
            raise ValueError('Invalid signature response')
        pending_tip = cursor.get('pending_tip') or (rows[0]['signature'] if rows else cursor.get('tip'))
        complete = not cursor.get('tip') or len(rows) < 100 or any(row['signature'] == cursor.get('tip') for row in rows)
        with self.store.connect() as con:
            for row in rows:
                signature = row['signature']
                con.execute('INSERT OR IGNORE INTO wallet_transactions(signature,state) VALUES (?,?)', (signature, 'failed' if row.get('err') is not None else 'pending'))
                con.execute('INSERT OR IGNORE INTO wallet_pool_transactions VALUES (?,?)', (pool, signature))
            con.execute('INSERT OR REPLACE INTO wallet_cursors VALUES (?,?,?,?,?)', (pool, pending_tip if complete else cursor.get('tip'), None if complete else rows[-1]['signature'], None if complete else pending_tip, time.time()))

    def process(self, signature):
        try:
            transaction = self.request('getTransaction', [signature, {'encoding': 'jsonParsed', 'commitment': 'finalized', 'maxSupportedTransactionVersion': 1}])
            if transaction is None:
                raise ValueError('Transaction not available yet')
            if not isinstance(transaction, dict) or type(transaction.get('slot')) is not int or not isinstance(transaction.get('meta'), dict):
                raise ValueError('Invalid transaction response')
            if signature not in transaction.get('transaction', {}).get('signatures', []):
                raise ValueError('Transaction signature mismatch')
            events = balance_events(transaction, signature)
            with self.store.connect() as con:
                con.execute('UPDATE wallet_transactions SET state=?,payload=?,error=NULL WHERE signature=?', ('failed' if transaction['meta'].get('err') is not None else 'complete', json.dumps(transaction), signature))
                for event in events:
                    con.execute('INSERT OR REPLACE INTO wallet_balance_events VALUES (?,?,?,?)', (signature, event['wallet'], event['mint'], json.dumps(event)))
        except (ValueError, OSError, KeyError, TypeError) as error:
            with self.store.connect() as con:
                con.execute('UPDATE wallet_transactions SET attempts=attempts+1,retry_at=?,error=? WHERE signature=?', (time.time() + 60, type(error).__name__, signature))
            self.state['error'] = 'Transactions queued for retry: ' + str(error)[:200]

    def poll(self, active=lambda: True):
        if not active() or time.monotonic() - self.last_poll < 15:
            return
        self.last_poll = time.monotonic()
        self.state['error'] = None
        watched = {address for chain, address in self.store.watchlist() if chain == 'solana'}
        pools = list(dict.fromkeys(row.get('market_pair') for row in self.store.tokens() if row.get('chain') == 'solana' and row['address'] in watched and address_key('solana', row.get('market_pair'))))
        self.state['pools'] = len(pools)
        if pools:
            pool = pools[self.rotation % len(pools)]
            self.rotation += 1
            try:
                self.discover(pool)
                self.state['sampled_at'] = time.time()
            except (ValueError, OSError) as error:
                self.state['error'] = 'Pool collection delayed: ' + type(error).__name__
        with self.store.connect() as con:
            pending = [row[0] for row in con.execute("SELECT signature FROM wallet_transactions WHERE state='pending' AND retry_at<=? ORDER BY attempts,rowid LIMIT 6", (time.time(),))]
        for signature in pending:
            if not active():
                return
            self.process(signature)

    def snapshot(self):
        with self.store.connect() as con:
            counts = dict(con.execute('SELECT state,COUNT(*) FROM wallet_transactions GROUP BY state').fetchall())
            events = [json.loads(row[0]) for row in con.execute('SELECT payload FROM wallet_balance_events ORDER BY rowid DESC LIMIT 100')]
        return {'status': dict(self.state), 'counts': counts, 'events': events}
