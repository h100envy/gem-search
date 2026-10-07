import tempfile
import unittest
from pathlib import Path
from desktop_credentials import source_key


class SourceCredentialTests(unittest.TestCase):
    def test_private_source_value_is_read_without_executing_code(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            marker = path / 'executed'
            (path / 'private_credentials.py').write_text("SOLSCAN_API_KEY = 'fixture-secret'\nraise RuntimeError('must not run')\n", encoding='utf-8')
            self.assertEqual(source_key(path, 'solscan'), 'fixture-secret')
            self.assertFalse(marker.exists())

    def test_invalid_expression_is_not_executed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / 'private_credentials.py').write_text("SOLSCAN_API_KEY = str(123)\n", encoding='utf-8')
            self.assertNotEqual(source_key(path, 'solscan'), '123')
