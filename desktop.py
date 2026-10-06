import argparse
import json
import os
import sys
import threading
import time
import queue
from pathlib import Path
from urllib.parse import quote
from PySide6.QtCore import Qt, QTimer, QUrl, QLockFile, QAbstractTableModel, QObject, Signal
from PySide6.QtGui import QAction, QColor, QIcon, QPainter, QPixmap, QDesktopServices
from PySide6.QtWidgets import QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QComboBox, QLineEdit, QTabWidget, QTableView, QHeaderView, QSystemTrayIcon, QMenu, QCheckBox, QMessageBox, QScrollArea
from alerts import TokenAlerts
from desktop_store import DesktopStore
from token_monitor import TokenMonitor


def icon():
    pixmap = QPixmap(64, 64)
    pixmap.fill(QColor('#101114'))
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    for color, x, y in [('#4285F4', 14, 14), ('#EA4335', 34, 14), ('#FBBC05', 14, 34), ('#34A853', 34, 34)]:
        painter.setPen(QColor(color))
        painter.setBrush(QColor(color))
        painter.drawEllipse(x, y, 16, 16)
    painter.end()
    return QIcon(pixmap)


def money(value):
    try:
        return '${:,.2f}'.format(float(value)) if value is not None else 'Unavailable'
    except (ValueError, TypeError):
        return 'Unavailable'


def stamp(value):
    return time.strftime('%H:%M:%S', time.localtime(value)) if value else 'Not sampled'


class StoreSignals(QObject):
    snapshot = Signal(object)
    error = Signal(str)
    finished = Signal()


class TokenTableModel(QAbstractTableModel):
    def __init__(self, headings, parent=None):
        super().__init__(parent)
        self.headings = headings
        self.records = []
        self.cells = []

    def rowCount(self, parent=None):
        return 0 if parent is not None and parent.isValid() else len(self.records)

    def columnCount(self, parent=None):
        return 0 if parent is not None and parent.isValid() else len(self.headings)

    def data(self, index, role=Qt.ItemDataRole.DisplayRole):
        if not index.isValid():
            return None
        if role == Qt.ItemDataRole.DisplayRole:
            return self.cells[index.row()][index.column()]
        if role == Qt.ItemDataRole.ToolTipRole:
            record = self.records[index.row()]
            if index.column() == 0:
                return record.get('name', '') + '\n' + record['address']
            if self.headings[index.column()] == 'Reported market cap':
                return str(record.get('market_cap_source', 'Not sampled')) + '\nSampled: ' + stamp(record.get('market_cap_updated_at'))
            if self.headings[index.column()] == 'Supply valuation (FD)':
                return str(record.get('onchain_valuation_method', 'Not sampled')) + '\nPrice source: ' + str(record.get('onchain_price_source') or 'Not sampled') + '\nSampled: ' + stamp(record.get('onchain_valuation_sampled_at'))
            return self.cells[index.row()][index.column()]
        if role == Qt.ItemDataRole.UserRole:
            return self.records[index.row()]

    def headerData(self, section, orientation, role=Qt.ItemDataRole.DisplayRole):
        if role == Qt.ItemDataRole.DisplayRole and orientation == Qt.Orientation.Horizontal:
            return self.headings[section]

    def replace(self, records, values):
        cells = [[str(value) for value in values(record)] for record in records]
        if self.records == records and self.cells == cells:
            return False
        self.beginResetModel()
        self.records = records
        self.cells = cells
        self.endResetModel()
        return True


class TokenTable(QTableView):
    def rowCount(self):
        return self.model().rowCount()


class DesktopWindow(QMainWindow):
    def __init__(self, store, background=True):
        super().__init__()
        self.store = store
        self.alerts = TokenAlerts(store.connect)
        self.monitor = TokenMonitor(self.alerts, store.record, store.watchlist, store.tokens)
        self.stop = threading.Event()
        self.background = background
        self.pending_store = queue.Queue()
        self.store_snapshot = {'tokens': [], 'alerts': [], 'watchlist': []}
        self.saved_session = store.get('session', {})
        self.store_signals = StoreSignals(self)
        self.store_signals.snapshot.connect(self.accept_snapshot, Qt.ConnectionType.QueuedConnection)
        self.store_signals.error.connect(lambda message: QMessageBox.information(self, 'Local data', message))
        self.store_signals.finished.connect(QApplication.instance().quit, Qt.ConnectionType.QueuedConnection)
        self.quitting = False
        self.tables = {}
        self.pages = {}
        self.page_labels = {}
        self.page_buttons = {}
        self.total_counts = {}
        self.setWindowTitle('Gem Search · Token Monitor')
        self.setWindowIcon(icon())
        self.resize(1320, 850)
        self.setMinimumSize(1000, 620)
        self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, background and store.get('keep_on_top', True))
        container = QWidget()
        self.setCentralWidget(container)
        layout = QVBoxLayout(container)
        layout.setContentsMargins(16, 12, 16, 12)
        layout.setSpacing(8)
        header = QHBoxLayout()
        title = QLabel('<span style="color:#4285F4">G</span><span style="color:#EA4335">e</span><span style="color:#FBBC05">m</span> <span style="color:#34A853">Search</span>')
        title.setObjectName('title')
        header.addWidget(title)
        header.addStretch()
        tagline = QLabel('YOUR TOKEN RADAR')
        tagline.setObjectName('muted')
        header.addWidget(tagline)
        layout.addLayout(header)
        summary = QHBoxLayout()
        summary.setSpacing(16)
        self.metrics = {}
        for label, key, color in [('DISCOVERED TOKENS', 'tokens', '#4285F4'), ('SAVED ALERTS', 'alerts', '#EA4335'), ('WATCHED TOKENS', 'watched', '#FBBC05'), ('FLOW SAMPLES', 'samples', '#34A853')]:
            card = QWidget()
            card.setObjectName('card')
            card.setStyleSheet('QWidget#card{border-top:3px solid ' + color + ';}')
            card_box = QVBoxLayout(card)
            card_box.setContentsMargins(12, 6, 12, 6)
            label_widget = QLabel(label)
            label_widget.setObjectName('muted')
            value = QLabel('0')
            value.setObjectName('metric')
            card_box.addWidget(label_widget)
            card_box.addWidget(value)
            self.metrics[key] = value
            summary.addWidget(card)
        layout.addLayout(summary)
        controls = QHBoxLayout()
        self.duration = QComboBox()
        for label, minutes in [('Until I stop', 0), ('15 minutes', 15), ('1 hour', 60), ('2 hours', 120)]:
            self.duration.addItem(label, minutes)
        controls.addWidget(QLabel('Monitor for'))
        controls.addWidget(self.duration)
        keep_on_top = QCheckBox('Keep on top')
        keep_on_top.setChecked(store.get('keep_on_top', True))
        keep_on_top.toggled.connect(self.set_on_top)
        controls.addWidget(keep_on_top)
        controls.addStretch()
        self.control_buttons = {}
        for label, callback, style in [('Start monitoring', self.start_monitor, 'primary'), ('Stop', self.stop_monitor, 'stop')]:
            button = QPushButton(label)
            button.setObjectName(style)
            self.control_buttons[style] = button
            button.clicked.connect(callback)
            controls.addWidget(button)
        layout.addLayout(controls)
        self.status_label = QLabel()
        self.status_label.setWordWrap(True)
        self.status_label.setObjectName('status')
        layout.addWidget(self.status_label)
        self.tabs = QTabWidget()
        layout.addWidget(self.tabs, 1)
        self.search = QLineEdit()
        self.search.setPlaceholderText('Search token name, chain or address')
        self.search.textChanged.connect(self.filter_changed)
        for name, headings in [('Live tokens', ['Token / address', 'Chain', 'Supply valuation (FD)', 'Reported market cap', 'Net inflow · 5m', 'Flow sampled']), ('Triggered alerts', ['Time', 'Chain', 'Token address', 'Trigger', 'Value']), ('Watchlist', ['Token / address', 'Chain', 'Supply valuation (FD)', 'Reported market cap', 'Net inflow · 5m', 'Flow sampled'])]:
            page = QWidget()
            box = QVBoxLayout(page)
            box.setContentsMargins(10, 8, 10, 8)
            box.setSpacing(8)
            if name == 'Live tokens':
                box.addWidget(self.search)
            table = TokenTable()
            table.setModel(TokenTableModel(headings, table))
            table.setSelectionBehavior(QTableView.SelectionBehavior.SelectRows)
            table.setSelectionMode(QTableView.SelectionMode.SingleSelection)
            table.setEditTriggers(QTableView.EditTrigger.NoEditTriggers)
            table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
            table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Fixed)
            table.setColumnWidth(1, 75)
            table.horizontalHeader().setStretchLastSection(True)
            table.verticalHeader().setDefaultSectionSize(50)
            table.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
            table.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
            table.setShowGrid(False)
            table.setWordWrap(True)
            table.verticalHeader().hide()
            table.setAlternatingRowColors(True)
            table.doubleClicked.connect(lambda index, target=table: self.inspect(target, index.row()))
            box.addWidget(table)
            actions = QHBoxLayout()
            if name != 'Triggered alerts':
                copy = QPushButton('Copy address')
                copy.clicked.connect(lambda checked=False, target=table: self.copy_address(target))
                watch = QPushButton('Watch token' if name == 'Live tokens' else 'Unwatch')
                watch.clicked.connect(lambda checked=False, target=table, add=name == 'Live tokens': self.watch_selected(target, add))
                actions.addWidget(copy)
                actions.addWidget(watch)
                market = QPushButton('Chart')
                market.clicked.connect(lambda checked=False, target=table: self.open_market(target))
                actions.addWidget(market)
                explorer = QPushButton('Solscan')
                explorer.clicked.connect(lambda checked=False, target=table: self.open_explorer(target))
                actions.addWidget(explorer)
            actions.addStretch()
            page_label = QLabel()
            actions.addWidget(page_label)
            previous = QPushButton('Previous')
            previous.clicked.connect(lambda checked=False, target=name: self.turn_page(target, -1))
            following = QPushButton('Next')
            following.clicked.connect(lambda checked=False, target=name: self.turn_page(target, 1))
            actions.addWidget(previous)
            actions.addWidget(following)
            box.addLayout(actions)
            self.page_labels[name] = page_label
            self.page_buttons[name] = (previous, following)
            self.tables[name] = table
            self.tabs.addTab(page, name)
        settings_page = QWidget()
        settings = QVBoxLayout(settings_page)
        settings.addWidget(QLabel('ALERT RULES\nNet swap inflow: buys minus sells exceed $100,000 over five minutes.\nMarket cap: $40,000 before token age five minutes requires a token creation source.'))
        self.notifications = QCheckBox('Show notifications on this computer')
        self.notifications.setChecked(store.get('notifications', True))
        self.notifications.toggled.connect(lambda value: self.save_setting('notifications', value))
        settings.addWidget(self.notifications)
        settings.addWidget(QLabel('VALUATION\nSolana mint supply comes directly from the chain at confirmed commitment.\nSupply valuation (FD) uses minted supply multiplied by the selected pool USD price.\nPrice is supplied by DexScreener; circulating supply is not verified.\nReported market cap is separate. Samples older than three minutes are marked stale.\nWatched tokens refresh each poll; saved tokens refresh in rotating batches.\nThe Solscan button opens the selected Solana token for direct comparison.'))
        test = QPushButton('Test desktop notification')
        test.clicked.connect(self.test_notification)
        settings.addWidget(test)
        settings.addWidget(QLabel('ADD A WATCHED TOKEN'))
        self.chain_input = QLineEdit()
        self.chain_input.setPlaceholderText('GeckoTerminal network ID: solana, eth, base, bsc…')
        self.address_input = QLineEdit()
        self.address_input.setPlaceholderText('Token contract address')
        settings.addWidget(self.chain_input)
        settings.addWidget(self.address_input)
        add = QPushButton('Add token to watchlist')
        add.clicked.connect(self.add_watch)
        settings.addWidget(add)
        settings.addWidget(QLabel('COVERAGE\nDiscovery samples the latest 20 GeckoTerminal pools across supported networks.\nNet inflow is calculated from complete indexed swap samples. Missing data stays unavailable.\nPool creation time and fully diluted valuation are not used as token age or market cap.\nThe $40k launch rule is not automatically active without token creation data.'))
        settings.addWidget(QLabel('Closing this window keeps monitoring in the system tray. Quit stops monitoring.\nUntil I stop and timed deadlines are retained when the app is reopened.\nMonitoring cannot run while your computer is asleep or powered off.'))
        settings.addWidget(QLabel('Local data: ' + str(store.directory)))
        settings.addStretch()
        settings_scroll = QScrollArea()
        settings_scroll.setWidgetResizable(True)
        settings_scroll.setWidget(settings_page)
        self.tabs.addTab(settings_scroll, 'Settings')
        self.tabs.currentChanged.connect(self.refresh)
        self.tray = QSystemTrayIcon(icon(), self)
        self.tray.setToolTip('Gem Search Token Monitor')
        menu = QMenu()
        for label, callback in [('Open monitor', self.reopen), ('Start monitoring', self.start_monitor), ('Stop monitoring', self.stop_monitor), ('Quit', self.quit_app)]:
            action = QAction(label, self)
            action.triggered.connect(callback)
            menu.addAction(action)
        self.tray.setContextMenu(menu)
        self.tray.activated.connect(lambda reason: self.reopen() if reason == QSystemTrayIcon.ActivationReason.DoubleClick else None)
        self.tray.messageClicked.connect(lambda: self.show_alert_history())
        if background:
            self.tray.show()
        session = store.get('session', {})
        if session.get('enabled') and (not session.get('expires_at') or session['expires_at'] > time.time()):
            self.monitor.control(True)
            self.monitor.expires = session.get('expires_at')
        self.cursor = store.get('notification_cursor', max([r['id'] for r in self.alerts.recent()] or [0]))
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.refresh)
        self.timer.start(2000)
        if background:
            threading.Thread(target=self.worker, daemon=True).start()
            threading.Thread(target=self.snapshot_worker, daemon=True).start()
        self.refresh()

    def worker(self):
        while not self.stop.wait(1):
            try:
                self.monitor.poll()
            except Exception as error:
                self.monitor.error = 'Monitor unavailable: ' + type(error).__name__

    def persist_session(self):
        state = self.monitor.status()
        session = {'enabled': state['enabled'], 'expires_at': state['expires_at']}
        if session != self.saved_session:
            self.saved_session = session
            self.save_setting('session', session)

    def save_setting(self, key, value):
        self.run_store(self.store.set, key, value)

    def run_store(self, action, *args):
        if self.background:
            self.pending_store.put((action, args))
        else:
            action(*args)

    def snapshot_worker(self):
        while not self.stop.is_set():
            try:
                while not self.pending_store.empty():
                    action, args = self.pending_store.get_nowait()
                    action(*args)
                    if self.stop.is_set():
                        return
                snapshot = {'tokens': self.store.tokens(), 'alerts': self.alerts.recent(), 'watchlist': self.store.watchlist()}
                self.store_signals.snapshot.emit(snapshot)
            except Exception as error:
                self.store_signals.error.emit('Local data operation failed: ' + type(error).__name__)
            self.stop.wait(1)

    def accept_snapshot(self, snapshot):
        self.store_snapshot = snapshot
        self.refresh()

    def start_monitor(self):
        self.monitor.control(True, self.duration.currentData())
        self.persist_session()
        self.refresh()

    def stop_monitor(self):
        self.monitor.control(False)
        self.persist_session()
        self.refresh()

    def test_notification(self):
        if not QSystemTrayIcon.isSystemTrayAvailable() or not QSystemTrayIcon.supportsMessages():
            QMessageBox.information(self, 'Desktop notifications', 'System tray notifications are unavailable on this machine.')
            return
        self.tray.showMessage('Gem Search test', 'This is a test notification, not a token alert.', QSystemTrayIcon.MessageIcon.Information, 10000)

    def fill_table(self, table, records, values):
        name = next(name for name, target in self.tables.items() if target is table)
        self.total_counts[name] = len(records)
        size = max(1, table.viewport().height() // 50)
        page = min(self.pages.get(name, 0), max(0, (len(records) - 1) // size))
        self.pages[name] = page
        start = page * size
        previous, following = self.page_buttons[name]
        previous.setEnabled(page > 0)
        following.setEnabled(start + size < len(records))
        self.page_labels[name].setText(str(start + 1 if records else 0) + ' to ' + str(min(start + size, len(records))) + ' of ' + str(len(records)))
        records = records[start:start + size]
        selected_key = self.selected(table)
        scroll = table.verticalScrollBar().value()
        if not table.model().replace(records, values):
            return
        for index, record in enumerate(records):
            if selected_key and selected_key.get('chain') == record.get('chain') and selected_key.get('address') == record.get('address'):
                table.selectRow(index)
                break
        table.verticalScrollBar().setValue(scroll)

    def refresh(self):
        state = self.monitor.status()
        self.status_label.setText(('MONITORING' if state['enabled'] else 'STOPPED') + ' · ' + str(state['checked']) + ' flow samples checked · ' + str(state['skipped']) + ' incomplete samples skipped' + (' · ' + state['error'] if state['error'] else '') + (' · ' + state.get('valuation_error', '') if state.get('valuation_error') else ''))
        self.persist_session()
        snapshot = self.store_snapshot if self.background else {'tokens': self.store.tokens(), 'alerts': self.alerts.recent(), 'watchlist': self.store.watchlist()}
        tokens = snapshot['tokens']
        self.metrics['tokens'].setText(str(len(tokens)))
        self.metrics['alerts'].setText(str(len(snapshot['alerts'])))
        self.metrics['watched'].setText(str(len(snapshot['watchlist'])))
        self.metrics['samples'].setText(str(state['checked']))
        self.control_buttons['primary'].setEnabled(not state['enabled'])
        self.control_buttons['stop'].setEnabled(state['enabled'])
        query = self.search.text().lower()
        values = lambda r: [r['name'], r['chain'].upper(), self.valuation_cell(r), self.cap_cell(r), money(r.get('net_inflow_m5_usd')), stamp(r.get('flow_updated_at'))]
        self.fill_table(self.tables['Live tokens'], [r for r in tokens if query in (r['name'] + r['chain'] + r['address']).lower()], values)
        watched = set(snapshot['watchlist'])
        self.fill_table(self.tables['Watchlist'], [r for r in tokens if (r['chain'], r['address']) in watched], values)
        alerts = snapshot['alerts']
        self.fill_table(self.tables['Triggered alerts'], alerts, lambda r: [stamp(r['captured_at']), r['chain'], r['address'], 'Net inflow > $100k / 5m' if r['rule'] == 'net_inflow_100k_5m' else 'Market cap $40k before 5m', money(r['value_usd'])])
        for alert in sorted(alerts, key=lambda r: r['id']):
            if alert['id'] <= self.cursor:
                continue
            if self.notifications.isChecked():
                title = 'Net inflow above $100,000' if alert['rule'] == 'net_inflow_100k_5m' else 'Early $40,000 market cap'
                self.tray.showMessage(title, alert['chain'] + ' · ' + money(alert['value_usd']) + '\n' + alert['address'], QSystemTrayIcon.MessageIcon.Information, 10000)
            self.cursor = alert['id']
            self.save_setting('notification_cursor', self.cursor)

    def selected(self, table):
        index = table.currentIndex()
        return table.model().data(index, Qt.ItemDataRole.UserRole) if index.isValid() else None

    def filter_changed(self):
        self.pages['Live tokens'] = 0
        self.refresh()

    def turn_page(self, name, direction):
        self.pages[name] = max(0, self.pages.get(name, 0) + direction)
        self.refresh()

    def set_on_top(self, enabled):
        self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, enabled)
        self.show()
        self.raise_()
        self.save_setting('keep_on_top', enabled)

    def cap_cell(self, record):
        value = record.get('market_cap_usd')
        if value is None:
            return 'Awaiting provider'
        sampled = record.get('market_cap_updated_at') or 0
        return money(value) + (' · STALE' if time.time() - sampled > 180 else '')

    def valuation_cell(self, record):
        if record['chain'] != 'solana':
            return 'Solana only'
        value = record.get('onchain_valuation_usd')
        if value is None:
            return 'Waiting for supply + price'
        sampled = record.get('onchain_valuation_sampled_at') or 0
        return money(value) + (' · STALE' if time.time() - sampled > 180 else '')

    def open_explorer(self, table):
        record = self.selected(table)
        if record and record['chain'] == 'solana':
            QDesktopServices.openUrl(QUrl('https://solscan.io/token/' + quote(record['address'], safe='')))
        elif record:
            QMessageBox.information(self, 'Solscan', 'Solscan covers Solana tokens. This token is on ' + record['chain'] + '.')

    def copy_address(self, table):
        record = self.selected(table)
        if record:
            QApplication.clipboard().setText(record['address'])

    def open_market(self, table):
        record = self.selected(table)
        if record:
            QDesktopServices.openUrl(QUrl('https://www.geckoterminal.com/' + quote(record['chain'], safe='') + '/tokens/' + quote(record['address'], safe='')))

    def watch_selected(self, table, add):
        record = self.selected(table)
        if not record:
            return
        try:
            self.run_store(self.store.watch if add else self.store.unwatch, record['chain'], record['address'])
            self.refresh()
        except ValueError as error:
            QMessageBox.information(self, 'Watchlist', str(error))

    def add_watch(self):
        try:
            self.run_store(self.store.watch, self.chain_input.text().strip(), self.address_input.text().strip())
            self.address_input.clear()
            self.refresh()
        except ValueError as error:
            QMessageBox.information(self, 'Watchlist', str(error))

    def inspect(self, table, row):
        if row < 0 or row >= table.model().rowCount():
            return
        record = table.model().records[row]
        QMessageBox.information(self, record.get('name', 'Token details'), '\n\n'.join(['Network: ' + record['chain'], 'Address: ' + record['address'], 'Reported market cap: ' + money(record.get('market_cap_usd')), 'Reported provider: ' + record.get('market_cap_source', 'Not sampled'), 'Reported cap sampled: ' + stamp(record.get('market_cap_updated_at')), 'Supply valuation (FD): ' + money(record.get('onchain_valuation_usd')), 'Minted supply: ' + record.get('onchain_supply', 'Not sampled'), 'Confirmed chain slot: ' + str(record.get('onchain_slot', 'Not sampled')), 'USD price used: ' + record.get('onchain_price_usd', 'Not sampled'), 'Price provider: ' + str(record.get('onchain_price_source') or 'Not sampled'), 'Price pool: ' + str(record.get('onchain_price_pool') or 'Not sampled'), 'Pool liquidity reported: ' + money(record.get('onchain_price_liquidity_usd')), 'Valuation sampled: ' + stamp(record.get('onchain_valuation_sampled_at')), 'Method: ' + record.get('onchain_valuation_method', 'Not sampled'), 'Net inflow over five minutes: ' + money(record.get('net_inflow_m5_usd'))]))

    def show_alert_history(self):
        self.tabs.setCurrentIndex(1)
        self.reopen()

    def reopen(self):
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def closeEvent(self, event):
        if self.quitting or not QSystemTrayIcon.isSystemTrayAvailable():
            self.quit_app()
            event.accept()
        else:
            self.hide()
            event.ignore()

    def quit_app(self):
        if self.quitting:
            return
        self.quitting = True
        self.stop_monitor()
        self.tray.hide()
        if self.background:
            self.status_label.setText('Saving your session and closing...')
            self.pending_store.put((self.finish_quit, ()))
        else:
            self.finish_quit()
            QApplication.instance().quit()

    def finish_quit(self):
        self.stop.set()
        self.store_signals.finished.emit()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir')
    parser.add_argument('--smoke-test')
    parser.add_argument('--responsiveness-test')
    args = parser.parse_args()
    if args.responsiveness_test:
        os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
    application = QApplication(sys.argv[:1])
    application.setQuitOnLastWindowClosed(False)
    application.setApplicationName('Gem Search')
    application.setStyle('Fusion')
    application.setStyleSheet('''
        QWidget{background:#101114;color:#e8eaed;font-family:"Segoe UI";font-size:13px}
        QLabel#title{font-size:24px;font-weight:700;background:transparent}
        QLabel#muted{color:#9aa0a6;font-size:11px;font-weight:600;background:transparent}
        QLabel#metric{font-size:18px;font-weight:600;background:transparent}
        QWidget#card{background:#1b1d22;border:1px solid #2c3038;border-radius:12px}
        QLabel#status{color:#b8c4d9;padding:12px;background:#191e28;border-radius:8px}
        QPushButton{background:#23262d;border:1px solid #3b404a;padding:10px 18px;border-radius:8px;font-weight:600}
        QPushButton:hover{background:#303540;border-color:#4285F4}
        QPushButton#primary{background:#4285F4;color:#fff;border:none}
        QPushButton#primary:hover{background:#5a95f5}
        QPushButton#stop{color:#ff8a80;border-color:#62322e}
        QPushButton:disabled{background:#202229;color:#747b86;border-color:#30343b}
        QLineEdit,QComboBox{background:#1b1d22;border:1px solid #383d47;padding:10px;border-radius:8px}
        QLineEdit:focus{border-color:#4285F4}
        QTabWidget::pane{border:1px solid #30343b;background:#15171b;border-radius:10px}
        QTabBar::tab{padding:8px 16px;background:transparent;color:#9aa0a6;border-bottom:3px solid transparent;font-weight:600}
        QTabBar::tab:selected{color:#8ab4f8;border-bottom-color:#4285F4}
        QTableView{background:#17191e;alternate-background-color:#1c1f25;border:none;selection-background-color:#243859;selection-color:#fff}
        QTableView::item{padding:8px;border-bottom:1px solid #292d35}
        QHeaderView::section{background:#20232a;color:#9aa0a6;padding:12px;border:none;font-weight:600}
        QCheckBox{spacing:10px;padding:6px}
        QScrollBar:vertical{background:#17191e;width:10px;margin:0}
        QScrollBar::handle:vertical{background:#434a56;min-height:30px;border-radius:5px}
        QScrollBar::add-line:vertical,QScrollBar::sub-line:vertical{height:0}
        QMenu{background:#20232a;border:1px solid #383d47;padding:6px}
        QMenu::item{padding:8px 20px}
        QMenu::item:selected{background:#243859}
        QMessageBox{background:#17191e}
    ''')
    directory = Path(args.data_dir) if args.data_dir else Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'GemSearch'
    store = DesktopStore(directory)
    if args.responsiveness_test:
        from desktop_checks import seed_responsiveness_data
        seed_responsiveness_data(store)
    lock = QLockFile(str(directory / 'desktop.lock'))
    if not lock.tryLock(100):
        QMessageBox.information(None, 'Gem Search is already running', 'Open Gem Search from its system tray icon.')
        return
    window = DesktopWindow(store, background=not bool(args.smoke_test))
    available = application.primaryScreen().availableGeometry()
    window.resize(min(1320, available.width() - 32), min(850, available.height() - 32))
    window.move(available.left() + 16, available.top() + 16)
    window.show()
    if not args.smoke_test and not args.responsiveness_test:
        QTimer.singleShot(250, window.reopen)
    if args.responsiveness_test:
        from desktop_checks import run_responsiveness_check
        check_timer = run_responsiveness_check(application, window, store, args.responsiveness_test)
    if args.smoke_test:
        store.record('base', '0x' + 'a' * 40, {'name': 'Fixture token · test data', 'market_cap_usd': 42000, 'net_inflow_m5_usd': 125000, 'flow_updated_at': time.time()})
        store.watch('base', '0x' + 'a' * 40)
        window.alerts.evaluate('base', '0x' + 'a' * 40, {'net_inflow_m5_usd': 125000})
        window.refresh()
        assert window.tables['Live tokens'].rowCount() == 1
        assert window.tables['Watchlist'].rowCount() == 1
        assert window.tables['Triggered alerts'].rowCount() == 1
        window.search.setText('no-match')
        assert window.tables['Live tokens'].rowCount() == 0
        window.search.clear()
        window.start_monitor()
        assert store.get('session')['enabled']
        window.stop_monitor()
        assert not store.get('session')['enabled']
        application.processEvents()
        window.grab().save(args.smoke_test)
        Path(args.smoke_test).with_suffix('.json').write_text(json.dumps({'passed': True, 'checks': ['live tokens', 'watchlist', 'alert history', 'search', 'persisted start and stop', 'native widget rendering']}))
        window.quit_app()
        return
    result = application.exec()
    if args.responsiveness_test:
        result = 0 if json.loads(Path(args.responsiveness_test).read_text())['passed'] else 1
    sys.exit(result)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        import traceback
        error_path = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'GemSearch'
        error_path.mkdir(parents=True, exist_ok=True)
        (error_path / 'desktop-error.log').write_text(traceback.format_exc(), encoding='utf-8')
        raise
