import json
import threading
import time
from pathlib import Path
from PySide6.QtCore import QTimer


def seed_responsiveness_data(store):
    rows = []
    for index in range(2000):
        address = '0x' + format(index, '040x')
        payload = {'chain': 'base', 'address': address, 'name': 'Fixture token ' + str(index), 'first_seen': time.time(), 'market_cap_usd': 40000 + index, 'market_cap_source': 'Fixture provider', 'market_cap_updated_at': time.time(), 'net_inflow_m5_usd': index * 100, 'flow_updated_at': time.time()}
        rows.append(('base', address, time.time(), json.dumps(payload)))
    with store.connect() as con:
        con.executemany('INSERT OR REPLACE INTO desktop_tokens VALUES (?,?,?,?)', rows)


def run_responsiveness_check(application, window, store, output):
    window.monitor.poll = lambda: None
    state = {'started': time.monotonic(), 'last': time.monotonic(), 'max_gap_ms': 0, 'heartbeats': 0, 'loaded': False, 'lock_started': False, 'write_queued': False}
    locked = threading.Event()
    released = threading.Event()
    timer = QTimer(window)

    def hold_database():
        with store.connect() as con:
            con.execute('BEGIN IMMEDIATE')
            locked.set()
            time.sleep(2)
        released.set()

    def tick():
        now = time.monotonic()
        state['max_gap_ms'] = max(state['max_gap_ms'], (now - state['last']) * 1000)
        state['last'] = now
        state['heartbeats'] += 1
        if window.tables['Live tokens'].rowCount() == 2000:
            state['loaded'] = True
        if state['loaded'] and not state['lock_started']:
            state['lock_started'] = True
            threading.Thread(target=hold_database, daemon=True).start()
        if locked.is_set() and not state['write_queued']:
            state['write_queued'] = True
            window.save_setting('responsiveness_probe', True)
            window.search.setText('Fixture token 1999')
            state['search_works'] = window.tables['Live tokens'].rowCount() == 1
            window.search.clear()
            table = window.tables['Live tokens']
            table.selectRow(1999)
            expected_address = table.model().records[1999]['address']
            window.copy_address(table)
            state['copy_works'] = application.clipboard().text() == expected_address and len(expected_address) == 42
        if now - state['started'] < 8:
            return
        timer.stop()
        state['database_lock_released'] = released.is_set()
        state['queued_write_saved'] = store.get('responsiveness_probe') is True
        state['passed'] = all(state.get(key) for key in ['loaded', 'search_works', 'copy_works', 'database_lock_released', 'queued_write_saved']) and state['max_gap_ms'] < 500 and state['heartbeats'] > 100
        result = Path(output)
        result.parent.mkdir(parents=True, exist_ok=True)
        result.write_text(json.dumps(state, indent=2), encoding='utf-8')
        window.grab().save(str(result.with_suffix('.png')))
        window.quit_app()

    timer.timeout.connect(tick)
    timer.start(20)
    return timer
