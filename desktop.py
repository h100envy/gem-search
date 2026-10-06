import argparse
import json
import os
import sys
import threading
import time
from pathlib import Path
from urllib.parse import quote
from PySide6.QtCore import Qt, QTimer, QUrl, QLockFile
from PySide6.QtGui import QAction, QColor, QIcon, QPainter, QPixmap, QDesktopServices
from PySide6.QtWidgets import QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QComboBox, QLineEdit, QTabWidget, QTableWidget, QTableWidgetItem, QHeaderView, QSystemTrayIcon, QMenu, QCheckBox, QMessageBox
from alerts import TokenAlerts
from desktop_store import DesktopStore
from token_monitor import TokenMonitor


def icon():
    pixmap = QPixmap(64, 64)
    pixmap.fill(QColor('#14231b'))
    painter = QPainter(pixmap)
    painter.setPen(QColor('#c6eb94'))
    painter.setBrush(QColor('#c6eb94'))
    painter.drawEllipse(18, 18, 28, 28)
    painter.end()
    return QIcon(pixmap)


def money(value):
    try:
        return '${:,.2f}'.format(float(value)) if value is not None else 'Unavailable'
    except (ValueError, TypeError):
        return 'Unavailable'


def stamp(value):
    return time.strftime('%H:%M:%S', time.localtime(value)) if value else 'Not sampled'


class DesktopWindow(QMainWindow):
    def __init__(self, store, background=True):
        super().__init__()
        self.store = store
        self.alerts = TokenAlerts(store.connect)
        self.monitor = TokenMonitor(self.alerts, store.record, store.watchlist)
        self.stop = threading.Event()
        self.quitting = False
        self.tables = {}
        self.setWindowTitle('Gem Search · Token Monitor')
        self.setWindowIcon(icon())
        self.resize(1240, 800)
        container = QWidget()
        self.setCentralWidget(container)
        layout = QVBoxLayout(container)
        layout.setContentsMargins(28, 24, 28, 24)
        title = QLabel('TOKEN MONITOR')
        title.setObjectName('title')
        layout.addWidget(title)
        layout.addWidget(QLabel('Discover tokens. Follow the evidence. Keep every alert.'))
        controls = QHBoxLayout()
        self.duration = QComboBox()
        for label, minutes in [('Until I stop', 0), ('15 minutes', 15), ('1 hour', 60), ('2 hours', 120)]:
            self.duration.addItem(label, minutes)
        controls.addWidget(self.duration)
        for label, callback in [('Start monitoring', self.start_monitor), ('Stop', self.stop_monitor), ('Test desktop notification', self.test_notification)]:
            button = QPushButton(label)
            button.clicked.connect(callback)
            controls.addWidget(button)
        controls.addStretch()
        layout.addLayout(controls)
        self.status_label = QLabel()
        layout.addWidget(self.status_label)
        self.tabs = QTabWidget()
        layout.addWidget(self.tabs, 1)
        self.search = QLineEdit()
        self.search.setPlaceholderText('Search token name, chain or address')
        self.search.textChanged.connect(self.refresh)
        for name, headings in [('Live tokens', ['Token', 'Chain', 'Address', 'Market cap', 'Net inflow · 5m', 'Flow sampled', 'First detected']), ('Triggered alerts', ['Time', 'Chain', 'Token address', 'Trigger', 'Value']), ('Watchlist', ['Token', 'Chain', 'Address', 'Market cap', 'Net inflow · 5m', 'Flow sampled', 'First detected'])]:
            page = QWidget()
            box = QVBoxLayout(page)
            if name == 'Live tokens':
                box.addWidget(self.search)
            table = QTableWidget(0, len(headings))
            table.setHorizontalHeaderLabels(headings)
            table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
            table.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
            table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
            table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
            table.horizontalHeader().setStretchLastSection(True)
            table.verticalHeader().hide()
            table.setAlternatingRowColors(True)
            table.cellDoubleClicked.connect(lambda row, column, target=table: self.inspect(target, row))
            box.addWidget(table)
            if name != 'Triggered alerts':
                actions = QHBoxLayout()
                copy = QPushButton('Copy selected address')
                copy.clicked.connect(lambda checked=False, target=table: self.copy_address(target))
                watch = QPushButton('Watch selected token' if name == 'Live tokens' else 'Remove from watchlist')
                watch.clicked.connect(lambda checked=False, target=table, add=name == 'Live tokens': self.watch_selected(target, add))
                actions.addWidget(copy)
                actions.addWidget(watch)
                actions.addStretch()
                box.addLayout(actions)
            self.tables[name] = table
            self.tabs.addTab(page, name)
        settings_page = QWidget()
        settings = QVBoxLayout(settings_page)
        settings.addWidget(QLabel('ALERT RULES\nNet swap inflow: buys minus sells exceed $100,000 over five minutes.\nMarket cap: $40,000 before token age five minutes requires a token creation source.'))
        self.notifications = QCheckBox('Show notifications on this computer')
        self.notifications.setChecked(store.get('notifications', True))
        self.notifications.toggled.connect(lambda value: store.set('notifications', value))
        settings.addWidget(self.notifications)
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
        self.tabs.addTab(settings_page, 'Settings')
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
        self.refresh()

    def worker(self):
        while not self.stop.wait(1):
            try:
                self.monitor.poll()
            except Exception as error:
                self.monitor.error = 'Monitor unavailable: ' + type(error).__name__

    def persist_session(self):
        state = self.monitor.status()
        self.store.set('session', {'enabled': state['enabled'], 'expires_at': state['expires_at']})

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
        selected = table.item(table.currentRow(), 0)
        selected_key = selected.data(Qt.ItemDataRole.UserRole) if selected else None
        table.setRowCount(len(records))
        for index, record in enumerate(records):
            for column, value in enumerate(values(record)):
                item = QTableWidgetItem(str(value))
                item.setToolTip(str(value))
                item.setData(Qt.ItemDataRole.UserRole, record)
                table.setItem(index, column, item)
            if selected_key and selected_key.get('chain') == record.get('chain') and selected_key.get('address') == record.get('address'):
                table.selectRow(index)

    def refresh(self):
        state = self.monitor.status()
        self.status_label.setText(('MONITORING' if state['enabled'] else 'STOPPED') + ' · ' + str(state['checked']) + ' flow samples checked · ' + str(state['skipped']) + ' incomplete samples skipped' + (' · ' + state['error'] if state['error'] else ''))
        self.persist_session()
        tokens = self.store.tokens()
        query = self.search.text().lower()
        values = lambda r: [r['name'], r['chain'], r['address'], money(r.get('market_cap_usd')), money(r.get('net_inflow_m5_usd')), stamp(r.get('flow_updated_at')), stamp(r.get('first_seen'))]
        self.fill_table(self.tables['Live tokens'], [r for r in tokens if query in (r['name'] + r['chain'] + r['address']).lower()], values)
        watched = set(self.store.watchlist())
        self.fill_table(self.tables['Watchlist'], [r for r in tokens if (r['chain'], r['address']) in watched], values)
        alerts = self.alerts.recent()
        self.fill_table(self.tables['Triggered alerts'], alerts, lambda r: [stamp(r['captured_at']), r['chain'], r['address'], 'Net inflow > $100k / 5m' if r['rule'] == 'net_inflow_100k_5m' else 'Market cap $40k before 5m', money(r['value_usd'])])
        for alert in sorted(alerts, key=lambda r: r['id']):
            if alert['id'] <= self.cursor:
                continue
            if self.notifications.isChecked():
                title = 'Net inflow above $100,000' if alert['rule'] == 'net_inflow_100k_5m' else 'Early $40,000 market cap'
                self.tray.showMessage(title, alert['chain'] + ' · ' + money(alert['value_usd']) + '\n' + alert['address'], QSystemTrayIcon.MessageIcon.Information, 10000)
            self.cursor = alert['id']
            self.store.set('notification_cursor', self.cursor)

    def selected(self, table):
        item = table.item(table.currentRow(), 0)
        return item.data(Qt.ItemDataRole.UserRole) if item else None

    def copy_address(self, table):
        record = self.selected(table)
        if record:
            QApplication.clipboard().setText(record['address'])

    def watch_selected(self, table, add):
        record = self.selected(table)
        if not record:
            return
        try:
            (self.store.watch if add else self.store.unwatch)(record['chain'], record['address'])
            self.refresh()
        except ValueError as error:
            QMessageBox.information(self, 'Watchlist', str(error))

    def add_watch(self):
        try:
            self.store.watch(self.chain_input.text().strip(), self.address_input.text().strip())
            self.address_input.clear()
            self.refresh()
        except ValueError as error:
            QMessageBox.information(self, 'Watchlist', str(error))

    def inspect(self, table, row):
        item = table.item(row, 0)
        if not item:
            return
        record = item.data(Qt.ItemDataRole.UserRole)
        QMessageBox.information(self, 'Token evidence', json.dumps(record, indent=2))

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
        self.quitting = True
        self.stop_monitor()
        self.stop.set()
        self.tray.hide()
        QApplication.instance().quit()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir')
    parser.add_argument('--smoke-test')
    args = parser.parse_args()
    application = QApplication(sys.argv[:1])
    application.setQuitOnLastWindowClosed(False)
    application.setApplicationName('Gem Search')
    application.setStyle('Fusion')
    application.setStyleSheet('QWidget{background:#101a15;color:#e6efe6;font-size:13px}QLabel#title{font-size:30px;font-weight:700;color:#c6eb94}QPushButton{background:#284333;border:1px solid #496652;padding:10px;border-radius:6px}QPushButton:hover{background:#355b44}QLineEdit,QComboBox{background:#1a2a20;border:1px solid #415647;padding:10px}QTabBar::tab{padding:14px 24px;background:#17261c}QTabBar::tab:selected{background:#35533d;color:#d0efab}QTableWidget{background:#15241b;alternate-background-color:#1b2c20;gridline-color:#2a4030;selection-background-color:#365940}QHeaderView::section{background:#233b2a;color:#c8e0bc;padding:10px;border:none}QCheckBox{spacing:10px}QMessageBox{background:#14221a}')
    directory = Path(args.data_dir) if args.data_dir else Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'GemSearch'
    store = DesktopStore(directory)
    lock = QLockFile(str(directory / 'desktop.lock'))
    if not lock.tryLock(100):
        QMessageBox.information(None, 'Gem Search is already running', 'Open Gem Search from its system tray icon.')
        return
    window = DesktopWindow(store, background=not bool(args.smoke_test))
    window.show()
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
    sys.exit(application.exec())


if __name__ == '__main__':
    try:
        main()
    except Exception:
        import traceback
        error_path = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'GemSearch'
        error_path.mkdir(parents=True, exist_ok=True)
        (error_path / 'desktop-error.log').write_text(traceback.format_exc(), encoding='utf-8')
        raise
