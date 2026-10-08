import json
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from kolscan_directory import bundled_wallets, read_wallets, valid_address


class DirectoryTests(unittest.TestCase):
    def test_snapshot_contains_fifty_unique_valid_wallets(self):
        rows = bundled_wallets()
        self.assertEqual(len(rows), 50)
        self.assertEqual(len({row['address'] for row in rows}), 50)
        self.assertTrue(all(valid_address(row['address']) for row in rows))

    def test_csv_and_json_merge_duplicate_addresses(self):
        address = bundled_wallets()[0]['address']
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'wallets.csv'
            path.write_text('name,address\nFirst,' + address + '\nSecond,' + address + '\n', encoding='utf-8-sig')
            rows = read_wallets(path)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['name'], 'Second')
            path = path.with_suffix('.json')
            path.write_text(json.dumps(rows), encoding='utf-8')
            self.assertEqual(read_wallets(path), rows)

    def test_invalid_rows_are_rejected_atomically(self):
        address = bundled_wallets()[0]['address']
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'wallets.json'
            for bad in [{'name': 'Wrong', 'address': 'https://example.com'}, {'name': '', 'address': address}, {'name': 'Other chain', 'address': address, 'chain': 'ethereum'}, {'name': 'Short', 'address': '1' * 33}, {'name': 'Bad date', 'address': address, 'captured': 'yesterday'}]:
                path.write_text(json.dumps([{'name': 'Good', 'address': address}, bad]), encoding='utf-8')
                with self.assertRaises(ValueError):
                    read_wallets(path)


if __name__ == '__main__':
    unittest.main()
