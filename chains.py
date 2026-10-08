import re


EVM = {
    'ethereum': (1, 'ethereum-rpc', 'https://etherscan.io/token/', 'ETH'),
    'base': (8453, 'base-rpc', 'https://basescan.org/token/', 'BASE'),
    'bsc': (56, 'bsc-rpc', 'https://bscscan.com/token/', 'BNB'),
    'arbitrum': (42161, 'arbitrum-one-rpc', 'https://arbiscan.io/token/', 'ARB'),
    'polygon': (137, 'polygon-bor-rpc', 'https://polygonscan.com/token/', 'POL'),
    'optimism': (10, 'optimism-rpc', 'https://optimistic.etherscan.io/token/', 'OP'),
    'avalanche': (43114, 'avalanche-c-chain-rpc', 'https://snowtrace.io/token/', 'AVAX')
}
CHAINS = ['solana', *EVM]


def address_key(chain, address):
    if not isinstance(address, str):
        return None
    if chain == 'solana' and re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}', address):
        return chain, address
    if chain in EVM and re.fullmatch(r'0x[0-9a-fA-F]{40}', address):
        return chain, address.lower()
    return None
