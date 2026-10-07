import argparse
import json
import os
import sys
import threading
import time
import queue
from pathlib import Path
from urllib.parse import quote
from PySide6.QtCore import Qt, QEvent, QTimer, QUrl, QLockFile, QAbstractTableModel, QObject, Signal
from PySide6.QtGui import QAction, QColor, QIcon, QPainter, QPixmap, QDesktopServices
from PySide6.QtWidgets import QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QComboBox, QLineEdit, QTabWidget, QTableView, QHeaderView, QSystemTrayIcon, QMenu, QCheckBox, QMessageBox, QScrollArea, QFileDialog, QListWidget, QPlainTextEdit
from market_metrics import current_flow
from data_quality import current_cap, current_value, mint_status
from alerts import TokenAlerts
from desktop_store import DesktopStore
from dex_monitor import DexMonitor
from desktop_credentials import load_key, save_key
from cielo_client import CieloClient
from kolscan_directory import bundled_wallets, read_wallets, SOURCE, CAPTURED


def icon():
    pixmap = QPixmap(64, 64)
    pixmap.fill(QColor('#101114'))
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    for color, x, y in [('#4285F4', 14, 14), ('#EA4335', 34, 14), ('#F58220', 14, 34), ('#34A853', 34, 34)]:
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


def compact(value):
    if value is None:
        return 'Unavailable'
    for scale, suffix in [(1000000000, 'B'), (1000000, 'M'), (1000, 'K')]:
        if abs(value) >= scale:
            return '${:.2f}{}'.format(value / scale, suffix)
    return money(value)


def price(value):
    if value is None:
        return 'Unavailable'
    return '$' + ('{:,.2f}'.format(value) if value >= 1 else '{:.10g}'.format(value))


def stamp(value):
    return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(value)) if value else 'Not sampled'


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
            if self.headings[index.column()] == 'Market cap':
                return str(record.get('market_cap_source', 'Not sampled')) + '\nSampled: ' + stamp(record.get('market_cap_updated_at'))
            if self.headings[index.column()] == 'Net 5m':
                return 'Indexed five-minute buy volume minus sell volume. Not transfers or liquidity deposits.\nSampled: ' + stamp(record.get('flow_updated_at'))
            if self.headings[index.column()] == 'Mint':
                return 'Mint metadata only; does not verify USD price or market cap.\nSampled: ' + stamp(record.get('onchain_supply_sampled_at'))
            return self.cells[index.row()][index.column()]
        if role == Qt.ItemDataRole.ForegroundRole and self.headings[index.column()] == 'Net 5m':
            flow = current_flow(self.records[index.row()])
            return QColor('#888888' if flow is None else '#34A853' if flow >= 0 else '#EA4335')
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


class KOLWalletPage(QWidget):
    def __init__(self, directory):
        super().__init__()
        self.path = Path(directory) / 'kol-wallets.json'
        self.imported = []
        self.page = 0
        box = QVBoxLayout(self)
        self.notice = QLabel('50 saved wallets · ' + CAPTURED + '\nDirectory snapshot. Live wallet trade tracking is unavailable.')
        self.notice.setWordWrap(True)
        box.addWidget(self.notice)
        self.search = QLineEdit()
        self.search.setPlaceholderText('Search KOL name or wallet address')
        self.search.textChanged.connect(self.filter_changed)
        box.addWidget(self.search)
        self.table = TokenTable()
        self.table.setModel(TokenTableModel(['KOL name', 'Wallet address', 'List source', 'Captured'], self.table))
        self.table.setSelectionBehavior(QTableView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QTableView.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QTableView.EditTrigger.NoEditTriggers)
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.table.verticalHeader().hide()
        self.table.verticalHeader().setDefaultSectionSize(40)
        self.table.setAlternatingRowColors(True)
        self.table.setShowGrid(False)
        self.table.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.table.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.table.doubleClicked.connect(lambda index: self.open_wallet('https://solscan.io/account/'))
        box.addWidget(self.table, 1)
        actions = QHBoxLayout()
        for label, callback in [('Copy wallet', self.copy_wallet), ('Explorer', lambda: self.open_wallet('https://solscan.io/account/')), ('Wallet profile', lambda: self.open_wallet('https://kolscan.io/account/')), ('Import list', self.import_list), ('Current leaderboard', lambda: QDesktopServices.openUrl(QUrl(SOURCE)))]:
            button = QPushButton(label)
            if label == 'Import list':
                button.setObjectName('orange')
            button.clicked.connect(callback)
            actions.addWidget(button)
        actions.addStretch()
        box.addLayout(actions)
        paging = QHBoxLayout()
        self.count = QLabel()
        paging.addWidget(self.count)
        paging.addStretch()
        self.previous = QPushButton('Previous')
        self.previous.clicked.connect(lambda: self.turn_page(-1))
        self.following = QPushButton('Next')
        self.following.clicked.connect(lambda: self.turn_page(1))
        paging.addWidget(self.previous)
        paging.addWidget(self.following)
        box.addLayout(paging)
        if self.path.exists():
            try:
                self.imported = read_wallets(self.path)
            except (OSError, ValueError) as error:
                self.notice.setText(self.notice.text() + '\nSaved import could not be loaded: ' + str(error))
        self.render()

    def render(self):
        wallets = {row['address']: row for row in self.imported}
        wallets.update({row['address']: row for row in bundled_wallets()})
        query = self.search.text().strip().casefold()
        rows = sorted((row for row in wallets.values() if query in (row['name'] + ' ' + row['address']).casefold()), key=lambda row: row['name'].casefold())
        size = max(1, (self.table.viewport().height() - 4) // 40)
        pages = max(1, (len(rows) + size - 1) // size)
        self.page = min(self.page, pages - 1)
        self.table.model().replace(rows[self.page * size:(self.page + 1) * size], lambda row: [row['name'], row['address'], 'Imported' if row['source'] == 'Imported list' else 'Saved', row['captured']])
        self.count.setText(str(len(rows)) + ' matching wallets / ' + str(len(wallets)) + ' saved · Page ' + str(self.page + 1) + ' of ' + str(pages))
        self.previous.setEnabled(self.page > 0)
        self.following.setEnabled(self.page + 1 < pages)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        QTimer.singleShot(0, self.render)

    def filter_changed(self):
        self.page = 0
        self.render()

    def turn_page(self, delta):
        self.page = max(0, self.page + delta)
        self.render()

    def selected(self):
        index = self.table.currentIndex()
        return self.table.model().records[index.row()] if index.isValid() else None

    def copy_wallet(self):
        row = self.selected()
        if row:
            QApplication.clipboard().setText(row['address'])

    def open_wallet(self, base):
        row = self.selected()
        if row:
            QDesktopServices.openUrl(QUrl(base + quote(row['address'], safe='')))

    def import_list(self):
        filename, unused = QFileDialog.getOpenFileName(self, 'Import Solana wallets', '', 'Wallet lists (*.csv *.json)')
        if not filename:
            return
        try:
            incoming = read_wallets(filename)
            merged = {row['address']: row for row in self.imported}
            merged.update({row['address']: row for row in incoming})
            if len(merged) > 10000:
                raise ValueError('This app supports up to 10,000 imported wallets')
            temporary = self.path.with_suffix('.tmp')
            temporary.write_text(json.dumps(list(merged.values()), ensure_ascii=False), encoding='utf-8')
            temporary.replace(self.path)
            self.imported = list(merged.values())
            self.filter_changed()
        except (OSError, ValueError) as error:
            QMessageBox.information(self, 'Wallet list', str(error))


class DesktopWindow(QMainWindow):
    def __init__(self, store, background=True):
        super().__init__()
        self.store = store
        self.alerts = TokenAlerts(store.connect)
        self.monitor = DexMonitor(self.alerts, store.record, store.watchlist, store.tokens, key=load_key(store.directory))
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
        self.page_sizes = {}
        self.total_counts = {}
        self.setWindowTitle('Gem Search · Token Monitor')
        self.setWindowIcon(icon())
        self.resize(1320, 850)
        self.setMinimumSize(1000, 620)
        self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, background and store.get('keep_on_top', False))
        container = QWidget()
        self.setCentralWidget(container)
        shell = QVBoxLayout(container)
        shell.setContentsMargins(0, 0, 0, 0)
        shell.setSpacing(0)
        bar = QWidget()
        bar.setObjectName('topbar')
        header = QHBoxLayout(bar)
        header.setContentsMargins(24, 12, 24, 12)
        brand = QLabel('Gem Search')
        brand.setObjectName('brand')
        header.addWidget(brand)
        accent = QLabel('<span style="color:#4285F4">●</span> <span style="color:#EA4335">●</span> <span style="color:#F58220">●</span> <span style="color:#34A853">●</span>')
        header.addWidget(accent)
        header.addStretch()
        self.control_buttons = {}
        for label, callback, style in [('Start monitoring', self.start_monitor, 'primary'), ('Stop', self.stop_monitor, 'stop')]:
            button = QPushButton(label)
            button.setObjectName(style)
            button.clicked.connect(callback)
            self.control_buttons[style] = button
            header.addWidget(button)
        shell.addWidget(bar)
        body = QHBoxLayout()
        body.setSpacing(0)
        sidebar = QWidget()
        sidebar.setObjectName('sidebar')
        sidebar.setFixedWidth(190)
        rail = QVBoxLayout(sidebar)
        rail.setContentsMargins(16, 28, 16, 20)
        label = QLabel('WORKSPACE')
        label.setObjectName('eyebrow')
        rail.addWidget(label)
        self.navigation = QListWidget()
        self.navigation.setObjectName('navigation')
        rail.addWidget(self.navigation, 1)
        rail.addWidget(QLabel('Solana'))
        body.addWidget(sidebar)
        workspace = QWidget()
        layout = QVBoxLayout(workspace)
        layout.setContentsMargins(28, 28, 28, 16)
        layout.setSpacing(16)
        self.page_title = QLabel('Live tokens')
        self.page_title.setObjectName('pageTitle')
        layout.addWidget(self.page_title)
        self.tabs = QTabWidget()
        self.tabs.tabBar().hide()
        layout.addWidget(self.tabs, 1)
        self.status_label = QLabel()
        self.status_label.setWordWrap(True)
        self.status_label.setObjectName('status')
        layout.addWidget(self.status_label)
        body.addWidget(workspace, 1)
        shell.addLayout(body, 1)
        self.duration = QComboBox()
        for label, minutes in [('Until I stop', 0), ('15 minutes', 15), ('1 hour', 60), ('2 hours', 120)]:
            self.duration.addItem(label, minutes)
        keep_on_top = QCheckBox('Keep on top')
        keep_on_top.setChecked(store.get('keep_on_top', False))
        keep_on_top.toggled.connect(self.set_on_top)
        self.minimize_outside = QCheckBox('Minimize when I click outside')
        self.minimize_outside.setChecked(store.get('minimize_on_deactivate', True))
        self.minimize_outside.toggled.connect(lambda value: self.save_setting('minimize_on_deactivate', value))
        self.search = QLineEdit()
        self.search.setPlaceholderText('Search token name, chain or address')
        self.search.textChanged.connect(self.filter_changed)
        self.token_sort = QComboBox()
        for label, value in [('Top market cap', 'cap'), ('Newest tokens', 'newest'), ('Name', 'name'), ('Top volume · 5m', 'volume')]:
            self.token_sort.addItem(label, value)
        self.token_sort.currentIndexChanged.connect(self.filter_changed)
        self.minimum_cap = QComboBox()
        for label, value in [('$40K and above', 40000), ('$1M and above', 1000000), ('$10M and above', 10000000), ('$100M and above', 100000000)]:
            self.minimum_cap.addItem(label, value)
        self.minimum_cap.currentIndexChanged.connect(self.filter_changed)
        self.confirmed_only = QCheckBox('Confirmed mint only')
        self.confirmed_only.toggled.connect(self.filter_changed)
        self.filter_panel = QWidget()
        filter_options = QHBoxLayout(self.filter_panel)
        filter_options.setContentsMargins(0, 0, 0, 0)
        filter_options.addWidget(QLabel('Sort'))
        filter_options.addWidget(self.token_sort)
        filter_options.addWidget(QLabel('Market cap'))
        filter_options.addWidget(self.minimum_cap)
        filter_options.addWidget(self.confirmed_only)
        self.filter_panel.hide()
        for name, headings in [('Live tokens', ['Token', 'Price', 'Market cap', 'Vol 24h', 'Vol 5m', 'Net 5m', 'Buys / sells', 'Liquidity', 'Mint', 'Time']), ('Triggered alerts', ['Time', 'Chain', 'Token address', 'Trigger', 'Value']), ('Watchlist', ['Token', 'Price', 'Market cap', 'Vol 24h', 'Vol 5m', 'Net 5m', 'Buys / sells', 'Liquidity', 'Mint', 'Time']), ('Saved tokens', ['Token / address', 'Chain', 'Historical source', 'Historical market cap', 'Saved price', 'Sample time'])]:
            page = QWidget()
            box = QVBoxLayout(page)
            box.setContentsMargins(10, 8, 10, 8)
            box.setSpacing(8)
            if name == 'Live tokens':
                self.connection_notice = QLabel()
                self.connection_notice.setWordWrap(True)
                box.addWidget(self.connection_notice)
                self.connection_button = QPushButton('Connect data')
                self.connection_button.clicked.connect(self.open_connection)
                box.addWidget(self.connection_button)
                search_controls = QHBoxLayout()
                search_controls.addWidget(self.search, 1)
                self.filter_button = QPushButton('Filter')
                self.filter_button.setCheckable(True)
                self.filter_button.toggled.connect(self.filter_panel.setVisible)
                search_controls.addWidget(self.filter_button)
                box.addLayout(search_controls)
                box.addWidget(self.filter_panel)
            if name == 'Saved tokens':
                history_notice = QLabel('Saved history from earlier versions. These values are historical provider data, excluded from live results and new alerts.')
                history_notice.setWordWrap(True)
                box.addWidget(history_notice)
            table = TokenTable()
            table.setModel(TokenTableModel(headings, table))
            table.setSelectionBehavior(QTableView.SelectionBehavior.SelectRows)
            table.setSelectionMode(QTableView.SelectionMode.SingleSelection)
            table.setEditTriggers(QTableView.EditTrigger.NoEditTriggers)
            table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
            table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Fixed)
            table.setColumnWidth(1, 75)
            table.horizontalHeader().setStretchLastSection(True)
            table.verticalHeader().setDefaultSectionSize(34)
            table.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
            table.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
            table.setShowGrid(False)
            table.setWordWrap(False)
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
                market = QPushButton('Open token')
                market.clicked.connect(lambda checked=False, target=table: self.open_market(target))
                actions.addWidget(market)
                explorer = QPushButton('Explorer')
                explorer.clicked.connect(lambda checked=False, target=table: self.open_explorer(target))
                actions.addWidget(explorer)
            actions.addStretch()
            page_size = QComboBox()
            page_size.setAccessibleName(name + ' rows per page')
            for count in (50, 100):
                page_size.addItem(str(count) + ' per page', count)
            page_size.setCurrentIndex(1 if store.get('page_size_' + name, 50) == 100 else 0)
            self.page_sizes[name] = page_size
            page_size.currentIndexChanged.connect(lambda index, target=name: self.change_page_size(target))
            actions.addWidget(page_size)
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
        self.kol_page = KOLWalletPage(store.directory)
        self.tabs.addTab(self.kol_page, 'Wallet directory')
        feed_page = QWidget()
        feed_box = QVBoxLayout(feed_page)
        feed_box.setSpacing(16)
        self.cielo_status = QLabel('Open your account activity and alert settings in your browser. In-app requests require a separate activity API key.')
        self.cielo_status.setWordWrap(True)
        feed_box.addWidget(self.cielo_status)
        feed_actions = QHBoxLayout()
        self.cielo_feed_button = QPushButton('Load activity')
        self.cielo_feed_button.setObjectName('primary')
        self.cielo_feed_button.clicked.connect(lambda: self.load_cielo_feed())
        feed_actions.addWidget(self.cielo_feed_button)
        wallet_feed = QPushButton('Load selected wallet')
        wallet_feed.clicked.connect(self.load_selected_cielo_wallet)
        feed_actions.addWidget(wallet_feed)
        for label, url in [('Account feed', 'https://app.cielo.finance/feed'), ('Account alerts', 'https://app.cielo.finance/settings/alerts')]:
            account_button = QPushButton(label)
            account_button.clicked.connect(lambda checked=False, target=url: QDesktopServices.openUrl(QUrl(target)))
            feed_box.addWidget(account_button)
        feed_actions.addStretch()
        feed_box.addLayout(feed_actions)
        self.cielo_output = QPlainTextEdit()
        self.cielo_output.setReadOnly(True)
        self.cielo_output.setPlaceholderText('Your activity response will appear here after a successful request. Live trade parsing remains under development.')
        feed_box.addWidget(self.cielo_output, 1)
        self.cielo_signals = StoreSignals(self)
        self.cielo_signals.snapshot.connect(self.accept_cielo_feed, Qt.ConnectionType.QueuedConnection)
        self.cielo_signals.error.connect(self.cielo_feed_error, Qt.ConnectionType.QueuedConnection)
        self.cielo_busy = False
        self.cielo_tab = self.tabs.addTab(feed_page, 'Wallet activity')
        mcp_page = QWidget()
        mcp_box = QVBoxLayout(mcp_page)
        mcp_box.setSpacing(16)
        mcp_intro = QLabel('Connect an MCP-compatible assistant to your local Gem Search data. The assistant launches this same application in read-only MCP mode. No second scanner is started.')
        mcp_intro.setWordWrap(True)
        mcp_box.addWidget(mcp_intro)
        mcp_privacy = QLabel('Only selected token, wallet, alert and status fields are returned. Credentials and strategy settings are excluded. Requested results may be sent to the model provider by your assistant. This local connection does not provide a public HTTPS endpoint.')
        mcp_privacy.setWordWrap(True)
        mcp_box.addWidget(mcp_privacy)
        mcp_box.addWidget(QLabel('Available tools: list_tokens, get_token, list_wallets, get_alerts, get_status'))
        mcp_actions = QHBoxLayout()
        mcp_copy = QPushButton('Copy connection setup')
        mcp_copy.setObjectName('primary')
        mcp_copy.clicked.connect(self.copy_mcp_setup)
        mcp_actions.addWidget(mcp_copy)
        self.mcp_test = QPushButton('Test connection')
        self.mcp_test.clicked.connect(self.test_mcp_connection)
        mcp_actions.addWidget(self.mcp_test)
        mcp_actions.addStretch()
        mcp_box.addLayout(mcp_actions)
        self.mcp_status = QLabel('Ready for a local assistant connection. Copy the setup into your assistant’s MCP server configuration.')
        self.mcp_status.setWordWrap(True)
        mcp_box.addWidget(self.mcp_status)
        mcp_box.addStretch()
        self.mcp_signals = StoreSignals(self)
        self.mcp_signals.snapshot.connect(self.accept_mcp_probe, Qt.ConnectionType.QueuedConnection)
        self.mcp_signals.error.connect(self.fail_mcp_probe, Qt.ConnectionType.QueuedConnection)
        self.tabs.addTab(mcp_page, 'Assistant connection')
        settings_page = QWidget()
        settings = QVBoxLayout(settings_page)
        settings.setSpacing(18)
        settings.addWidget(QLabel('ACTIVITY CONNECTION\nEnter your activity API key locally. API access is separate from your web account.'))
        self.cielo_key = QLineEdit()
        self.cielo_key.setEchoMode(QLineEdit.EchoMode.Password)
        self.cielo_key.setPlaceholderText('Enter your activity API key locally')
        settings.addWidget(self.cielo_key)
        cielo_save = QPushButton('Save activity connection')
        cielo_save.clicked.connect(self.connect_cielo)
        settings.addWidget(cielo_save)
        cielo_login = QPushButton('Open activity API portal')
        cielo_login.clicked.connect(lambda: QDesktopServices.openUrl(QUrl('https://build.cielo.finance')))
        settings.addWidget(cielo_login)
        self.cielo_connection = QLabel('Activity key saved locally' if load_key(store.directory, 'cielo') else 'Activity key not configured')
        settings.addWidget(self.cielo_connection)
        self.solscan_connection = QLabel('Token key saved locally' if load_key(store.directory) else 'Token key not configured')
        settings.addWidget(self.solscan_connection)
        settings.addWidget(QLabel('TOKEN CONNECTION\nEnter your token data key locally. Market values are reported values, not independently verified USD valuations.'))
        self.solscan_key = QLineEdit()
        self.solscan_key.setEchoMode(QLineEdit.EchoMode.Password)
        self.solscan_key.setPlaceholderText('Enter your token API key locally')
        settings.addWidget(self.solscan_key)
        connect = QPushButton('Save token connection')
        connect.clicked.connect(self.connect_solscan)
        settings.addWidget(connect)
        settings.addWidget(QLabel('Monitoring duration'))
        settings.addWidget(self.duration)
        settings.addWidget(keep_on_top)
        settings.addWidget(self.minimize_outside)
        settings.addWidget(QLabel('NOTIFICATIONS\nReview triggered events in the alerts area. Complete live alert coverage is still under development.'))
        self.notifications = QCheckBox('Show notifications on this computer')
        self.notifications.setChecked(store.get('notifications', True))
        self.notifications.toggled.connect(lambda value: self.save_setting('notifications', value))
        settings.addWidget(self.notifications)
        test = QPushButton('Test desktop notification')
        test.clicked.connect(self.test_notification)
        settings.addWidget(test)
        settings.addWidget(QLabel('ADD A WATCHED TOKEN'))
        self.chain_input = QLineEdit()
        self.chain_input.setText('solana')
        self.chain_input.setReadOnly(True)
        self.address_input = QLineEdit()
        self.address_input.setPlaceholderText('Token contract address')
        settings.addWidget(self.chain_input)
        settings.addWidget(self.address_input)
        add = QPushButton('Add token to watchlist')
        add.clicked.connect(self.add_watch)
        settings.addWidget(add)
        settings.addWidget(QLabel('COVERAGE\nSolana only. Live coverage depends on your connection access. Some activity and alert features remain unavailable.'))
        settings.addWidget(QLabel('Closing this window keeps monitoring in the system tray. Quit stops monitoring.\nUntil I stop and timed deadlines are retained when the app is reopened.\nMonitoring cannot run while your computer is asleep or powered off.'))
        settings.addWidget(QLabel('Local data: ' + str(store.directory)))
        settings.addStretch()
        settings_scroll = QScrollArea()
        settings_scroll.setWidgetResizable(True)
        settings_scroll.setWidget(settings_page)
        self.tabs.addTab(settings_scroll, 'Settings')
        self.connection_tab = self.tabs.indexOf(settings_scroll)
        for index in range(self.tabs.count()):
            self.navigation.addItem(self.tabs.tabText(index))
        self.navigation.currentRowChanged.connect(self.tabs.setCurrentIndex)
        self.tabs.currentChanged.connect(self.navigation.setCurrentRow)
        self.tabs.currentChanged.connect(lambda index: self.page_title.setText(self.tabs.tabText(index)))
        self.tabs.currentChanged.connect(self.refresh)
        self.navigation.setCurrentRow(0)
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
                self.store.set('mcp_runtime', {'sampled_at': time.time(), 'monitoring': bool(self.monitor.status()['enabled'])})
                self.store_signals.snapshot.emit(snapshot)
            except Exception as error:
                self.store_signals.error.emit('Local data operation failed: ' + type(error).__name__)
            self.stop.wait(1)

    def accept_snapshot(self, snapshot):
        self.store_snapshot = snapshot
        self.refresh()

    def open_connection(self):
        self.tabs.setCurrentIndex(self.connection_tab)
        self.solscan_key.setFocus()

    def copy_mcp_setup(self):
        from gem_mcp import launch_config
        QApplication.clipboard().setText(json.dumps(launch_config(self.store.directory), indent=2))
        self.mcp_status.setText('Connection setup copied. Add it to your assistant’s MCP server configuration. No API keys are included.')

    def test_mcp_connection(self):
        from gem_mcp import launch_config, probe_connection
        self.mcp_test.setEnabled(False)
        self.mcp_status.setText('Testing the local MCP handshake and available tools...')
        config = launch_config(self.store.directory)
        def probe():
            try:
                self.mcp_signals.snapshot.emit(probe_connection(config))
            except Exception:
                self.mcp_signals.error.emit('The local MCP connection could not be verified. Check that the application and connection setup are current.')
        threading.Thread(target=probe, daemon=True).start()

    def accept_mcp_probe(self, result):
        self.mcp_test.setEnabled(True)
        self.mcp_status.setText('Connection verified. ' + str(result['tools']) + ' read-only tools available. No external assistant has been configured automatically.')

    def fail_mcp_probe(self, message):
        self.mcp_test.setEnabled(True)
        self.mcp_status.setText(message)

    def start_monitor(self):
        if not self.monitor.client.key:
            self.open_connection()
            return
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
        size = self.page_sizes[name].currentData()
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
        self.status_label.setText(('Monitoring' if state['enabled'] else 'Paused') + (' · Connection needs attention. See Settings.' if state['error'] else ' · Token refresh') + (' · Valuation unavailable' if state.get('valuation_error') else ''))
        self.status_label.setToolTip(str(state['checked']) + ' measured flow samples. ' + str(state['skipped']) + ' unavailable flow samples. Last successful response: ' + stamp(state.get('last_success_at')))
        self.persist_session()
        snapshot = self.store_snapshot if self.background else {'tokens': self.store.tokens(), 'alerts': self.alerts.recent(), 'watchlist': self.store.watchlist()}
        tokens = [r for r in snapshot['tokens'] if r.get('data_source') == 'DexScreener' and current_cap(r) is not None and current_cap(r) >= 40000 and (current_value(r, 'liquidity_usd', 'statistics_sampled_at') or 0) > 0]
        connected = bool(self.monitor.client.key)
        self.connection_notice.setText('A token connection is required. Add your key in Settings. Saved records remain available.' if not connected else 'No current tokens meet the $40,000 minimum with positive liquidity. Waiting for data.' if not tokens else '')
        self.connection_notice.setVisible(not connected or not tokens or bool(state['error']))
        feed_errors = [state.get(k) for k in ('error', 'ranking_error', 'flow_error') if state.get(k)]
        if feed_errors:
            self.connection_notice.setText(' | '.join(feed_errors))
            self.connection_notice.setVisible(True)
        self.connection_button.setVisible(not connected)
        self.control_buttons['primary'].setText('Start monitoring' if connected else 'Connect data')
        self.control_buttons['primary'].setEnabled(not state['enabled'])
        self.control_buttons['stop'].setEnabled(state['enabled'])
        query = self.search.text().lower()
        minimum = self.minimum_cap.currentData()
        filtered = [r for r in tokens if query in (r['name'] + r['chain'] + r['address']).lower() and (not minimum or (current_cap(r) is not None and current_cap(r) >= minimum)) and (not self.confirmed_only.isChecked() or mint_status(r) == 'confirmed')]
        if self.token_sort.currentData() == 'cap':
            filtered.sort(key=lambda r: (-(current_cap(r) if current_cap(r) is not None else -1), r['name'].casefold(), r['address']))
        elif self.token_sort.currentData() == 'newest':
            filtered.sort(key=lambda r: -(r.get('token_created_at') or 0))
        elif self.token_sort.currentData() == 'volume':
            filtered.sort(key=lambda r: -(current_value(r, 'volume_m5_usd', 'statistics_sampled_at') or 0))
        else:
            filtered.sort(key=lambda r: (r['name'].casefold(), r['address']))
        values = lambda r: [r['name'], price(current_value(r, 'price_usd', 'price_sampled_at')), self.cap_cell(r), compact(current_value(r, 'volume_h24_usd', 'statistics_sampled_at')), compact(current_value(r, 'volume_m5_usd', 'statistics_sampled_at')), compact(current_flow(r)), (str(int(r['buy_count_m5'])) + ' / ' + str(int(r['sell_count_m5']))) if current_value(r, 'buy_count_m5', 'statistics_sampled_at') is not None and current_value(r, 'sell_count_m5', 'statistics_sampled_at') is not None else 'Unavailable', compact(current_value(r, 'liquidity_usd', 'statistics_sampled_at')), self.valuation_cell(r), time.strftime('%H:%M:%S', time.localtime(r['market_cap_updated_at']))]
        self.fill_table(self.tables['Live tokens'], filtered, values)
        watched = set(snapshot['watchlist'])
        self.fill_table(self.tables['Watchlist'], [r for r in tokens if (r['chain'], r['address']) in watched], values)
        self.fill_table(self.tables['Saved tokens'], snapshot['tokens'], lambda r: [r['name'], r['chain'].upper(), r.get('market_cap_source', 'Unknown historical source'), money(r.get('market_cap_usd')), money(r.get('price_usd')), stamp(r.get('market_cap_updated_at'))])
        alerts = snapshot['alerts']
        self.fill_table(self.tables['Triggered alerts'], alerts, lambda r: [stamp(r['captured_at']), r['chain'], r['address'], 'Activity alert' if r['rule'] == 'net_inflow_100k_5m' else 'Token alert', money(r['value_usd'])])
        for alert in sorted(alerts, key=lambda r: r['id']):
            if alert['id'] <= self.cursor:
                continue
            if self.notifications.isChecked():
                title = 'Activity alert' if alert['rule'] == 'net_inflow_100k_5m' else 'Token alert'
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

    def change_page_size(self, name):
        self.pages[name] = 0
        self.save_setting('page_size_' + name, self.page_sizes[name].currentData())
        self.tables[name].verticalScrollBar().setValue(0)
        self.refresh()

    def set_on_top(self, enabled):
        self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, enabled)
        self.show()
        self.raise_()
        self.save_setting('keep_on_top', enabled)

    def cap_cell(self, record):
        value = current_cap(record)
        return compact(value) if value is not None else 'Unavailable'

    def valuation_cell(self, record):
        return {'confirmed': 'Confirmed', 'mismatch': 'Mismatch', 'pending': 'Pending', 'unavailable': 'Unavailable'}[mint_status(record)]

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
        self.open_explorer(table)

    def connect_cielo(self):
        key = self.cielo_key.text().strip()
        if not key:
            QMessageBox.information(self, 'Cielo', 'Enter your Cielo key in this local password field.')
            return
        try:
            save_key(self.store.directory, key, 'cielo')
            self.cielo_key.clear()
            self.cielo_connection.setText('Activity key saved locally. Load activity to test access.')
            self.cielo_connection.setStyleSheet('color:#188038')
        except (ValueError, OSError):
            QMessageBox.information(self, 'Cielo', 'The local credential could not be saved.')

    def load_selected_cielo_wallet(self):
        wallet = self.kol_page.selected()
        if not wallet:
            self.tabs.setCurrentWidget(self.kol_page)
            QMessageBox.information(self, 'Select wallet', 'Select a wallet in the directory, then use Load selected wallet in Cielo feed.')
            return
        self.load_cielo_feed(wallet['address'])

    def load_cielo_feed(self, wallet=''):
        if self.cielo_busy:
            return
        key = load_key(self.store.directory, 'cielo')
        if not key:
            self.open_connection()
            self.cielo_key.setFocus()
            return
        self.tabs.setCurrentIndex(self.cielo_tab)
        self.cielo_busy = True
        self.cielo_feed_button.setEnabled(False)
        self.cielo_status.setText('Loading wallet activity...')
        def fetch():
            try:
                self.cielo_signals.snapshot.emit(CieloClient(key).feed(wallet))
            except Exception as error:
                self.cielo_signals.error.emit(str(error) if isinstance(error, ValueError) else 'Cielo feed could not be loaded')
        threading.Thread(target=fetch, daemon=True).start()

    def accept_cielo_feed(self, result):
        self.cielo_busy = False
        self.cielo_feed_button.setEnabled(True)
        self.cielo_status.setText('Activity response received. Live trade parsing remains under development.')
        self.cielo_output.setPlainText(json.dumps(result, indent=2, ensure_ascii=False))

    def cielo_feed_error(self, message):
        self.cielo_busy = False
        self.cielo_feed_button.setEnabled(True)
        self.cielo_status.setText(message)

    def connect_solscan(self):
        key = self.solscan_key.text().strip()
        if not key:
            QMessageBox.information(self, 'Solscan connection', 'Enter your API key locally in Settings.')
            return
        try:
            save_key(self.store.directory, key)
            self.monitor.set_key(key)
            self.solscan_key.clear()
            self.solscan_connection.setText('Token key saved locally')
            self.status_label.setText('Credential saved securely on this Windows account. Start monitoring to check access.')
        except (ValueError, OSError) as error:
            QMessageBox.information(self, 'Solscan connection', str(error))

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
        QMessageBox.information(self, record.get('name', 'Token details'), '\n\n'.join(['Network: ' + record['chain'], 'Address: ' + record['address'], 'Current reported market cap: ' + money(current_cap(record)), 'Current reported price: ' + price(current_value(record, 'price_usd', 'price_sampled_at')), 'Sampled: ' + stamp(record.get('market_cap_updated_at')), 'Mint metadata check: ' + self.valuation_cell(record) + '. Does not verify USD value.', 'Confirmed minted supply: ' + str(record.get('onchain_supply', 'Not sampled')), 'Confirmed chain slot: ' + str(record.get('onchain_slot', 'Not sampled')), 'Verification sampled: ' + stamp(record.get('onchain_supply_sampled_at')), 'Token creation time from Solscan: ' + stamp(record.get('token_created_at')), 'Net flow · 5m (buy USD minus sell USD): ' + money(current_flow(record))]))

    def show_alert_history(self):
        self.tabs.setCurrentIndex(1)
        self.reopen()

    def reopen(self):
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def event(self, event):
        if event.type() == QEvent.Type.WindowDeactivate and getattr(self, 'background', False) and hasattr(self, 'minimize_outside') and self.minimize_outside.isChecked():
            QTimer.singleShot(150, self.minimize_if_inactive)
        return super().event(event)

    def minimize_if_inactive(self):
        if not self.quitting and self.minimize_outside.isChecked() and self.isVisible() and not self.isActiveWindow() and QApplication.activeModalWidget() is None and QApplication.activePopupWidget() is None:
            self.showMinimized()

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
    parser.add_argument('--settings', action='store_true')
    parser.add_argument('--mcp', action='store_true')
    args = parser.parse_args()
    if args.mcp:
        from gem_mcp import run_server
        directory = Path(args.data_dir) if args.data_dir else Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'GemSearch'
        run_server(directory)
        return
    if args.responsiveness_test:
        os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
    application = QApplication(sys.argv[:1])
    application.setQuitOnLastWindowClosed(False)
    application.setApplicationName('Gem Search')
    application.setStyle('Fusion')
    application.setStyleSheet('''
        QWidget{background:#101114;color:#e7e9ed;font-family:"Segoe UI";font-size:13px}
        QLabel{background:transparent}
        QPlainTextEdit{background:#101114;color:#e7e9ed;border:1px solid #30343b;border-radius:12px;padding:12px}
        QWidget#topbar{background:#17191d;border-bottom:1px solid #30343b}
        QLabel#brand{font-size:17px;font-weight:600;background:transparent}
        QLabel#pageTitle{font-size:32px;font-weight:600;letter-spacing:-1px;background:transparent}
        QLabel#eyebrow{color:#86868b;font-size:10px;font-weight:600;padding-bottom:12px}
        QWidget#sidebar{background:#1c1e23;border-right:1px solid #30343b}
        QListWidget#navigation{background:transparent;border:none;outline:none;font-size:13px}
        QListWidget#navigation::item{padding:12px 10px;margin-bottom:4px;border-radius:8px}
        QListWidget#navigation::item:selected{background:#263753;color:#e7e9ed}
        QListWidget#navigation::item:hover{background:#252930}
        QLabel#status{color:#a3a9b3;font-size:11px;padding:8px 0;background:transparent}
        QPushButton{background:#101114;border:1px solid #30343b;padding:8px 14px;border-radius:16px;font-weight:500}
        QPushButton:hover{background:#30343b}
        QPushButton#primary{background:#4285F4;color:#ffffff;border:none}
        QPushButton#orange{background:#F58220;color:#101114;border:none}
        QPushButton#orange:hover{background:#ff993d}
        QPushButton#primary:hover{background:#2168d8}
        QPushButton#stop{background:transparent;color:#d93025;border:1px solid #30343b}
        QPushButton#stop:disabled{color:#9b9ba1;border-color:#30343b}
        QPushButton:disabled{background:#1c1e23;color:#9b9ba1;border-color:#30343b}
        QLineEdit,QComboBox{background:#1c1e23;border:1px solid #30343b;padding:10px 12px;border-radius:10px;selection-background-color:#4285F4}
        QLineEdit:focus{border-color:#4285F4}
        QTabWidget::pane{border:none;background:transparent}
        QTableView{background:#101114;alternate-background-color:#17191d;border:1px solid #30343b;border-radius:12px;selection-background-color:#263753;selection-color:#e7e9ed}
        QTableView::item{padding:8px;border-bottom:1px solid #252930}
        QHeaderView::section{background:#1c1e23;color:#a3a9b3;padding:12px 8px;border:none;font-size:11px;font-weight:500}
        QCheckBox{spacing:10px;padding:6px}
        QScrollBar:vertical{background:#1c1e23;width:8px;margin:0}
        QScrollBar::handle:vertical{background:#b5b5ba;min-height:30px;border-radius:4px}
        QScrollBar::add-line:vertical,QScrollBar::sub-line:vertical{height:0}
        QMenu{background:#101114;border:1px solid #30343b;padding:6px}
        QMenu::item{padding:8px 20px}
        QMenu::item:selected{background:#263753}
        QMessageBox{background:#1c1e23}
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
    if args.settings:
        window.open_connection()
    if not args.smoke_test and not args.responsiveness_test:
        QTimer.singleShot(250, window.reopen)
    if args.responsiveness_test:
        from desktop_checks import run_responsiveness_check
        check_timer = run_responsiveness_check(application, window, store, args.responsiveness_test)
    if args.smoke_test:
        store.record('base', '0x' + 'a' * 40, {'data_source': 'DexScreener', 'name': 'Fixture token · test data', 'liquidity_usd': 10000, 'statistics_sampled_at': time.time(), 'market_cap_usd': 42000, 'market_cap_updated_at': time.time(), 'price_usd': 0.000042, 'price_sampled_at': time.time(), 'net_inflow_m5_usd': 125000, 'flow_method': 'indexed_buy_minus_sell_5m', 'flow_updated_at': time.time()})
        store.watch('base', '0x' + 'a' * 40)
        window.alerts.evaluate('base', '0x' + 'a' * 40, {'net_inflow_m5_usd': 125000})
        store.record('solana', 'historical-fixture', {'name': 'Historical fixture', 'market_cap_usd': 50000, 'market_cap_source': 'Legacy fixture'})
        window.refresh()
        assert window.connection_notice.isVisible()
        window.start_monitor()
        assert window.monitor.status()['enabled']
        window.stop_monitor()
        window.tabs.setCurrentIndex(0)
        assert window.total_counts['Saved tokens'] == 2
        assert window.tables['Live tokens'].rowCount() == 1
        assert window.tables['Watchlist'].rowCount() == 1
        assert window.tables['Triggered alerts'].rowCount() == 1
        window.search.setText('no-match')
        assert window.tables['Live tokens'].rowCount() == 0
        window.search.clear()
        window.monitor.set_key('fixture-key-no-network')
        window.start_monitor()
        assert store.get('session')['enabled']
        window.stop_monitor()
        assert not store.get('session')['enabled']
        window.tabs.setCurrentWidget(window.kol_page)
        application.processEvents()
        window.kol_page.search.setText('Cupsey')
        assert window.kol_page.table.rowCount() == 1
        window.kol_page.table.selectRow(0)
        window.kol_page.copy_wallet()
        assert application.clipboard().text() == '2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f'
        window.kol_page.search.clear()
        assert window.kol_page.following.isEnabled()
        first_page = list(window.kol_page.table.model().records)
        window.kol_page.turn_page(1)
        assert window.kol_page.table.model().records != first_page
        window.kol_page.turn_page(-1)
        application.processEvents()
        window.grab().save(args.smoke_test)
        Path(args.smoke_test).with_suffix('.json').write_text(json.dumps({'passed': True, 'checks': ['live tokens', 'watchlist', 'alert history', 'search', 'persisted start and stop', 'KOL search', 'wallet clipboard', 'KOL pagination', 'native widget rendering']}))
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
