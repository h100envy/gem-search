import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from cielo_client import CieloClient


class Response(io.BytesIO):
    status = 200


class CieloTests(unittest.TestCase):
    def test_request_uses_documented_host_header_and_filters(self):
        with patch('cielo_client.urlopen', return_value=Response(json.dumps({'fixture': []}).encode())) as request:
            result = CieloClient('test-key').feed('2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f')
            self.assertEqual(result, {'fixture': []})
            call = request.call_args.args[0]
            self.assertTrue(call.full_url.startswith('https://feed-api.cielo.finance/api/v1/feed?'))
            self.assertIn('chains=solana', call.full_url)
            self.assertNotIn('test-key', call.full_url)
            self.assertEqual(call.get_header('X-api-key'), 'test-key')

    def test_rate_limits_and_pending_feed_are_actionable(self):
        with patch('cielo_client.urlopen', side_effect=HTTPError('', 429, '', {}, None)):
            with self.assertRaisesRegex(ValueError, 'rate limit'):
                CieloClient('test-key').feed()
        pending = Response(b'')
        pending.status = 202
        with patch('cielo_client.urlopen', return_value=pending):
            with self.assertRaisesRegex(ValueError, '10 seconds'):
                CieloClient('test-key').feed()

    def test_missing_key_and_invalid_wallet_do_not_request(self):
        with patch('cielo_client.urlopen') as request:
            for client, wallet in [(CieloClient(''), ''), (CieloClient('test-key'), 'https://example.com')]:
                with self.assertRaises(ValueError):
                    client.feed(wallet)
            request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
