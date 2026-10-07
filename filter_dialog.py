import math
from PySide6.QtWidgets import QDialog, QVBoxLayout, QHBoxLayout, QGridLayout, QLabel, QLineEdit, QComboBox, QCheckBox, QPushButton, QMessageBox
from token_filters import DEFAULTS, RANGES
from chains import CHAINS


class FilterDialog(QDialog):
    def __init__(self, settings, exchanges, parent=None):
        super().__init__(parent)
        self.setWindowTitle('Customize filters')
        self.setMinimumWidth(520)
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel('Solana  ·  Liquidity ≥ $10,000  ·  Market cap ≥ $40,000'))
        self.chain = QComboBox()
        self.chain.addItem('All supported chains', '')
        for chain in CHAINS:
            self.chain.addItem(chain.capitalize(), chain)
        layout.addWidget(self.chain)
        options = QHBoxLayout()
        self.timeframe = QComboBox()
        for label, value in [('5M', 'm5'), ('1H', 'h1'), ('6H', 'h6'), ('24H', 'h24')]:
            self.timeframe.addItem(label, value)
        self.sort = QComboBox()
        for label, value in [('Market cap', 'cap'), ('Liquidity', 'liquidity'), ('Volume', 'volume'), ('Transactions', 'transactions'), ('Gainers', 'change'), ('New pairs', 'newest'), ('Name', 'name')]:
            self.sort.addItem(label, value)
        self.dex = QComboBox()
        self.dex.addItem('All exchanges', '')
        for exchange in sorted(set(exchanges)):
            self.dex.addItem(exchange, exchange)
        options.addWidget(self.timeframe)
        options.addWidget(self.sort)
        options.addWidget(self.dex)
        layout.addLayout(options)
        grid = QGridLayout()
        grid.addWidget(QLabel('Metric'), 0, 0)
        grid.addWidget(QLabel('Minimum'), 0, 1)
        grid.addWidget(QLabel('Maximum'), 0, 2)
        self.fields = {}
        for row, (key, label) in enumerate(RANGES, 1):
            grid.addWidget(QLabel(label), row, 0)
            for column, bound in [(1, 'min'), (2, 'max')]:
                name = key + '_' + bound
                field = QLineEdit()
                field.setPlaceholderText('No limit')
                self.fields[name] = field
                grid.addWidget(field, row, column)
        layout.addLayout(grid)
        self.suffixes = QLineEdit()
        self.suffixes.setPlaceholderText('Address suffixes, separated by commas')
        self.labels = QLineEdit()
        self.labels.setPlaceholderText('Pair labels, separated by commas')
        layout.addWidget(self.suffixes)
        layout.addWidget(self.labels)
        self.confirmed = QCheckBox('Verified token account only')
        self.boosted = QCheckBox('Boosted only')
        layout.addWidget(self.confirmed)
        layout.addWidget(self.boosted)
        layout.addWidget(QLabel('Filters use the selected pair. Pair age is not token age.\nTrader counts, ads and proprietary trending scores are unavailable.'))
        buttons = QHBoxLayout()
        reset = QPushButton('Reset')
        reset.clicked.connect(lambda: self.load(DEFAULTS))
        cancel = QPushButton('Cancel')
        cancel.clicked.connect(self.reject)
        apply = QPushButton('Apply')
        apply.clicked.connect(self.apply)
        buttons.addWidget(reset)
        buttons.addStretch()
        buttons.addWidget(cancel)
        buttons.addWidget(apply)
        layout.addLayout(buttons)
        self.load(settings)

    def load(self, settings):
        for key, field in self.fields.items():
            value = settings.get(key)
            field.setText(str(value) if value is not None else '')
        for combo, key in [(self.timeframe, 'timeframe'), (self.sort, 'sort'), (self.dex, 'dex'), (self.chain, 'chain')]:
            index = combo.findData(settings.get(key, DEFAULTS.get(key, '')))
            combo.setCurrentIndex(max(0, index))
        self.suffixes.setText(settings.get('suffixes', ''))
        self.labels.setText(settings.get('labels', ''))
        self.confirmed.setChecked(settings.get('confirmed_only', False))
        self.boosted.setChecked(settings.get('boosted_only', False))

    def apply(self):
        result = {'chain': self.chain.currentData(), 'timeframe': self.timeframe.currentData(), 'sort': self.sort.currentData(), 'dex': self.dex.currentData(), 'suffixes': self.suffixes.text().strip(), 'labels': self.labels.text().strip(), 'confirmed_only': self.confirmed.isChecked(), 'boosted_only': self.boosted.isChecked()}
        try:
            for key, field in self.fields.items():
                if field.text().strip():
                    value = float(field.text().replace(',', ''))
                    if not math.isfinite(value) or (not key.startswith('change_') and value < 0):
                        raise ValueError()
                    result[key] = value
            result['liquidity_min'] = max(10000, result.get('liquidity_min', 10000))
            result['cap_min'] = max(40000, result.get('cap_min', 40000))
            for key, label in RANGES:
                if key + '_min' in result and key + '_max' in result and result[key + '_min'] > result[key + '_max']:
                    raise ValueError()
        except ValueError:
            QMessageBox.information(self, 'Filter values', 'Enter finite numbers with minimum no greater than maximum.')
            return
        self.result_settings = result
        self.accept()
