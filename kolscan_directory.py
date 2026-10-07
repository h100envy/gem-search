import csv
import json
from datetime import date
from pathlib import Path


SOURCE = 'https://kolscan.io/leaderboard'
CAPTURED = '2026-10-06'
SEED = '''xander|B3wagQZiZU2hKa5pUCj6rrdhWsX3Q6WfTTnki9PjwzMh
Dani|AuPp4YTMTyqxYXQnHc5KUc6pUuCSsHQpBJhgnD45yqrf
WaiterG|4cXnf2z85UiZ5cyKsPMEULq1yufAtpkatmX4j4DBZqj2
Chairman ²|Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6
Kaaox|3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG
OGAntD|215nhcAHjQQGgwpQSJQ7zR26etbjjtVdW74NLzwEgQjP
LJC|6HJetMbdHBuk3mLUainxAPpBpWzDgYbHGTS2TqDAUSX2
samsrep|CUHBzSPSaNS3tArEtM3maSV6pNdJhHJFYZpurPPK9P7H
Risk|BHREKFkPQgAtDs8Vb1UfLkUpjG6ScidTjHaCWFuG2AtX
Nyhrox|6S8GezkxYUfZy9JPtYnanbcZTMB87Wjt1qx3c6ELajKC
gr3g|J23qr98GjGJJqKq9CBEnyRhHbmkaVxtTJNNxKu597wsA
Spuno|GfXQesPe3Zuwg8JhAt6Cg8euJDTVx751enp9EQQmhzPH
Walta|39q2g5tTQn9n7KnuapzwS2smSx3NGYqBoea11tBjsGEt
TIL|EHg5YkU2SZBTvuT87rUsvxArGp3HLeye1fXaSDfuMyaf
japbitch|DemfvB4iwd3NmVquvWqWbB92yVZWFFqybqBeJGdyEeM6
Gasp|xyzfhxfy8NhfeNG3Um3WaUvFXzNuHkrhrZMD8dsStB6
chester|PMJA8UQDyWTFw2Smhyp9jGA6aTaP7jKHR7BPudrgyYN
Art|CgaA9a1JwAXJyfHuvZ7VW8YfTVRkdiT5mjBBSKcg7Rz5
Schoen|5hAgYC8TJCcEZV7LTXAzkTrm7YL29YXyQQJPCNrG84zM
Trey|831yhv67QpKqLBJjbmw2xoDUeeFHGUx8RnuRj9imeoEs
brunowsky|GvTXquDAJbfrFrEGTPRPUj3WM5Bzub5yeTFzkLVHpjfD
Trenchman|Hw5UKBU5k3YudnGwaykj5E8cYUidNMPuEewRRar5Xoc7
Megga|H31vEBxSJk1nQdUN11qZgZyhScyShhscKhvhZZU3dQoU
Coler|99xnE2zEFi8YhmKDaikc1EvH6ELTQJppnqUwMzmpLXrs
Reljoo|FsG3BaPmRTdSrPaivbgJsFNCCa8cPfkUtk8VLWXkHpHP
Cupsey|2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f
Mr. Frog|4DdrfiDHpmx55i4SPssxVzS9ZaKLb8qr45NKY9Er9nNh
decu|4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9
trunoest|ardinRsN1mNYVeoJWTBsWeYeXvuR9UUDGMsCDKpb6AT
Kadenox|B32QbbdDAyhvUQzjcaM5j6ZVKwjCxAwGH5Xgvb9SJqnC
rambo|2net6etAtTe3Rbq2gKECmQwnzcKVXRaLcHy2Zy1iCiWz
Tom|CEUA7zVoDRqRYoeHTP58UHU6TR8yvtVbeLrX1dppqoXJ
EustazZ|FqamE7xrahg7FEWoByrx1o8SeyHt44rpmE6ZQfT7zrve
milito|EeXvxkcGqMDZeTaVeawzxm9mbzZwqDUMmfG3bF7uzumH
Publix|86AEJExyjeNNgcp7GrAvCXTDicf5aGWgoERbXFiG1EdD
Wugi|862TYSvRYoiHAK3F3WwTRYAfuGiQaGdxedN9AGvRGWo2
Daumen|8MaVa9kdt3NW4Q5HyNAm1X5LbR8PQRVDc1W8NMVK88D5
Numer0 (trench/arc)|A3W8psibkTUvjxs4LRscbnjux6TFDXdvD4m4GsGpQ2KJ
Rilsio|4fZFcK8ms3bFMpo1ACzEUz8bH741fQW4zhAMGd5yZMHu
Limfork.eth|BQVz7fQ1WsQmSTMY3umdPEPPTm1sdcBcX9sP7o6kPRmB
Ataberk 🧙‍♂️|6hcX7fVMzeRpW3d7XhFsxYw2CuePfgSMmouZxSiNLj1U
cap|CAPn1yH4oSywsxGU456jfgTrSSUidf9jgeAnHceNUJdw
theo|Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt
h14|BJXjRq566xt66pcxCmCMLPSuNxyUpPNBdJGP56S7fMda
Tally ꨄ︎|JAmx4Wsh7cWXRzQuVt3TCKAyDfRm9HA7ztJa4f7RM8h9
Yami 𓃵|7Js5gmq57y9jG2sseKrAeJt3vbncSWSFFHDEsyJDnyVm
Idontpaytaxes|2T5NgDDidkvhJQg8AHDi74uCFwgp25pYFMRZXBaCUNBH
Yokai Ryujin|2w3zDW2e1KjYtM2pHTkgh78L8DjMrC6fuB9uhwKNigTs
LUKEY ✣|DjM7Tu7whh6P3pGVBfDzwXAx2zaw51GJWrJE3PwtuN7s
Giann|GNrmKZCxYyNiSUsjduwwPJzhed3LATjciiKVuSGrsHEC'''


def valid_address(address):
    alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    if not isinstance(address, str) or not 32 <= len(address) <= 44:
        return False
    number = 0
    for character in address:
        if character not in alphabet:
            return False
        number = number * 58 + alphabet.index(character)
    return len(address) - len(address.lstrip('1')) + (number.bit_length() + 7) // 8 == 32


def bundled_wallets():
    return [dict(name=name, address=address, source='Kolscan', captured=CAPTURED) for name, address in (line.split('|') for line in SEED.splitlines())]


def read_wallets(path):
    path = Path(path)
    if path.stat().st_size > 2_000_000:
        raise ValueError('Wallet lists must be smaller than 2 MB')
    with path.open(encoding='utf-8-sig', newline='') as handle:
        rows = json.load(handle) if path.suffix.lower() == '.json' else list(csv.DictReader(handle))
    if not isinstance(rows, list) or len(rows) > 10000:
        raise ValueError('Use a list of up to 10,000 wallets with name and address fields')
    clean = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('Each wallet needs name and address fields')
        address = row.get('address', row.get('wallet', ''))
        name = row.get('name', '')
        if not isinstance(name, str) or not name.strip() or len(name) > 120 or not valid_address(address) or row.get('chain', 'solana') != 'solana':
            raise ValueError('Each row needs a name and a valid Solana wallet address')
        captured = row.get('captured', date.today().isoformat())
        try:
            captured = date.fromisoformat(captured).isoformat()
        except (ValueError, TypeError):
            raise ValueError('Captured dates must use YYYY-MM-DD')
        clean[address] = dict(name=name.strip(), address=address, source='Imported list', captured=captured)
    if not clean:
        raise ValueError('The wallet list is empty')
    return list(clean.values())
