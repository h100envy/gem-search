import json
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from kolscan_directory import valid_address


class CieloClient:
    def __init__(self, key):
        self.key = key

    def feed(self, wallet='', cursor=''):
        if not self.key:
            raise ValueError('Save your Cielo API key in Settings first')
        if wallet and not valid_address(wallet):
            raise ValueError('Select a valid Solana wallet')
        params = {'chains': 'solana', 'limit': 20}
        if wallet:
            params['wallet'] = wallet
        if cursor:
            params['startFrom'] = cursor
        request = Request('https://feed-api.cielo.finance/api/v1/feed?' + urlencode(params), headers={'X-API-KEY': self.key, 'Accept': 'application/json', 'User-Agent': 'GemSearch'})
        try:
            with urlopen(request, timeout=12) as response:
                if response.status == 202:
                    raise ValueError('Cielo is preparing the feed. Retry after 10 seconds')
                payload = response.read(2_000_001)
        except HTTPError as error:
            raise ValueError({401: 'Cielo rejected the API key', 403: 'Cielo denied this request. Check API plan and key access', 429: 'Cielo rate limit reached. Retry later'}.get(error.code, 'Cielo request failed: HTTP ' + str(error.code))) from None
        except OSError:
            raise ValueError('Could not reach Cielo. Check your connection and retry') from None
        if len(payload) > 2_000_000:
            raise ValueError('Cielo response exceeds the local size limit')
        result = json.loads(payload)
        if not isinstance(result, (dict, list)):
            raise ValueError('Cielo returned an invalid feed response')
        return result
