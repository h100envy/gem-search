import tempfile
import time
import unittest
from unittest.mock import patch
from chains import address_key
from evm_onchain import evm_supplies, parse_evm
from dex_monitor import DexMonitor, select_pairs
from desktop_store import DesktopStore
from alerts import TokenAlerts
from token_filters import DEFAULTS, matches


ADDRESS = '0x' + 'a' * 40


class EVMTests(unittest.TestCase):
    def test_address_and_chain_isolation(self):
        self.assertEqual(address_key('base', ADDRESS.upper().replace('0X', '0x')), ('base', ADDRESS))
        self.assertIsNone(address_key('bitcoin', ADDRESS))
        pair = {'chainId': 'base', 'baseToken': {'address': ADDRESS}, 'pairAddress': ADDRESS, 'marketCap': 50000, 'liquidity': {'usd': 10000}}
        self.assertEqual(select_pairs([pair], {ADDRESS}, time.time(), 'ethereum'), {})
        self.assertEqual(len(select_pairs([pair], {ADDRESS}, time.time(), 'base')), 1)

    def test_contract_decoding_and_wrong_network_rejection(self):
        result = parse_evm({0: '0x6000', 1: '0x' + format(1000000, '064x'), 2: '0x' + format(6, '064x')}, [ADDRESS], '0x123')
        self.assertEqual(result[ADDRESS]['onchain_supply'], '1.000000')
        self.assertEqual(result[ADDRESS]['onchain_block'], 291)
        self.assertEqual(parse_evm({0: '0x', 1: '0x' + '0' * 64, 2: '0x' + '0' * 64}, [ADDRESS], '0x1'), {})
        with patch('evm_onchain.rpc', return_value={1: '0x1', 2: '0x123'}):
            with self.assertRaises(ValueError):
                evm_supplies('base', [ADDRESS])

    def test_same_address_on_two_networks_stores_separately(self):
        with tempfile.TemporaryDirectory() as directory:
            store = DesktopStore(directory)
            monitor = DexMonitor(TokenAlerts(store.connect), store.record, store.watchlist, store.tokens)
            def response(path):
                if path.startswith('tokens/'):
                    chain = path.split('/')[2]
                    return [{'chainId': chain, 'baseToken': {'address': ADDRESS}, 'pairAddress': ADDRESS, 'marketCap': 50000, 'liquidity': {'usd': 10000}}]
                return [{'chainId': chain, 'tokenAddress': ADDRESS} for chain in ['base', 'ethereum']]
            sample = {ADDRESS: {'onchain_supply_sampled_at': time.time(), 'onchain_decimals': 18}}
            with patch('dex_monitor.request', side_effect=response), patch('dex_monitor.evm_supplies', return_value=sample):
                monitor.control(True)
                monitor.poll()
            self.assertEqual({r['chain'] for r in store.tokens()}, {'base', 'ethereum'})
            self.assertEqual(sum(matches(r, dict(DEFAULTS, chain='base')) for r in store.tokens()), 1)
