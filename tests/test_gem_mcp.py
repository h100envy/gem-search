import json
import tempfile
import time
import unittest
from pathlib import Path

import anyio
from mcp import Client
from desktop_store import DesktopStore
from alerts import TokenAlerts
from gem_mcp import create_server


class MCPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.store = DesktopStore(self.directory)
        self.alerts = TokenAlerts(self.store.connect)
        for index in range(125):
            self.store.record('solana', 'fixture-' + str(index), {'name': 'Token ' + str(index), 'data_source': 'Solscan', 'market_cap_usd': (index + 1) * 1000000, 'market_cap_updated_at': time.time(), 'onchain_supply_sampled_at': time.time(), 'verification_status': 'Mint and decimals confirmed' if index % 2 == 0 else 'Pending', 'token_created_at': index + 1, 'api_key': 'PRIVATE_SENTINEL', 'strategy': 'PRIVATE_RULE_SENTINEL', 'source': 'PRIVATE_SOURCE_SENTINEL'})
        self.store.record('solana', 'unknown-fixture', {'name': 'Unknown', 'data_source': 'Solscan', 'market_cap_usd': None})
        self.store.record('solana', 'old-fixture', {'name': 'Old', 'market_cap_usd': 9000000000})
        self.store.watch('solana', 'fixture-124')
        self.store.set('mcp_runtime', {'sampled_at': time.time(), 'monitoring': True})
        self.store.set('private_setting', 'PRIVATE_SETTING_SENTINEL')
        (self.directory / 'cielo-key.dpapi').write_bytes(b'PRIVATE_KEY_FILE_SENTINEL')
        self.alerts.evaluate('solana', 'fixture-124', {'net_inflow_m5_usd': 120000, 'source': 'PRIVATE_SOURCE_SENTINEL'})

    def tearDown(self):
        self.temporary.cleanup()

    def test_tools_privacy_ranking_and_paging(self):
        async def check():
            async with Client(create_server(self.directory)) as client:
                tools = await client.list_tools()
                self.assertEqual({t.name for t in tools.tools}, {'list_tokens', 'get_token', 'list_wallets', 'get_alerts', 'get_status'})
                self.assertTrue(all(t.annotations.read_only_hint for t in tools.tools))
                result = await client.call_tool('list_tokens', {})
                data = result.structured_content
                self.assertEqual(data['total'], 126)
                self.assertEqual(len(data['items']), 50)
                self.assertEqual(data['items'][0]['market_cap_usd'], 125000000)
                tail = (await client.call_tool('list_tokens', {'page': 2, 'page_size': 100})).structured_content
                self.assertEqual(len(tail['items']), 26)
                self.assertIsNone(tail['items'][-1]['market_cap_usd'])
                self.assertFalse(tail['has_next'])
                filtered = (await client.call_tool('list_tokens', {'minimum_market_cap': 100000000, 'confirmed_only': True})).structured_content
                self.assertEqual(filtered['total'], 13)
                watched = (await client.call_tool('list_tokens', {'scope': 'watchlist'})).structured_content
                self.assertEqual(watched['total'], 1)
                self.assertEqual(watched['items'][0]['address'], 'fixture-124')
                saved = (await client.call_tool('list_tokens', {'scope': 'saved'})).structured_content
                self.assertEqual(saved['total'], 127)
                for name, arguments in [('list_tokens', {}), ('get_token', {'address': 'fixture-124'}), ('list_wallets', {}), ('get_alerts', {}), ('get_status', {})]:
                    response = await client.call_tool(name, arguments)
                    self.assertFalse(response.is_error)
                    text = response.model_dump_json()
                    for forbidden in ['PRIVATE_', 'Solscan', 'Cielo', 'Kolscan', 'net_inflow_100k_5m', 'api_key', 'strategy']:
                        self.assertNotIn(forbidden, text)
                alerts = (await client.call_tool('get_alerts', {})).structured_content
                self.assertEqual(alerts['items'][0]['category'], 'activity')
        anyio.run(check)

    def test_status_and_invalid_requests(self):
        async def check():
            async with Client(create_server(self.directory)) as client:
                fresh = (await client.call_tool('get_status', {})).structured_content
                self.assertTrue(fresh['monitoring'])
                self.store.set('mcp_runtime', {'sampled_at': time.time() - 20, 'monitoring': True})
                stale = (await client.call_tool('get_status', {})).structured_content
                self.assertIsNone(stale['monitoring'])
                for arguments in [{'page': 0}, {'page_size': 1000}, {'query': 'x' * 201}]:
                    self.assertTrue((await client.call_tool('list_tokens', arguments)).is_error)
                missing = (await client.call_tool('get_token', {'address': "' OR 1=1 --"})).structured_content
                self.assertFalse(missing['found'])
                self.assertFalse((await client.call_tool('get_status', {})).is_error)
        anyio.run(check)

    def test_read_only_and_missing_database(self):
        before = self.store.tokens()
        async def check():
            async with Client(create_server(self.directory)) as client:
                await client.call_tool('list_tokens', {})
                await client.call_tool('get_alerts', {})
            with tempfile.TemporaryDirectory() as missing:
                async with Client(create_server(missing)) as client:
                    status = (await client.call_tool('get_status', {})).structured_content
                    self.assertFalse(status['database_available'])
                    self.assertFalse(status['desktop_recently_seen'])
                    self.assertEqual((await client.call_tool('list_tokens', {})).structured_content['items'], [])
                    self.assertFalse((Path(missing) / 'tokens.sqlite').exists())
        anyio.run(check)
        self.assertEqual(before, self.store.tokens())
        self.assertEqual(self.store.get('private_setting'), 'PRIVATE_SETTING_SENTINEL')


if __name__ == '__main__':
    unittest.main()
