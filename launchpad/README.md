# Gem Search launchpad

The server behind [gemsearch.fun/launch](https://gemsearch.fun/launch). It launches coins on pump.fun for whoever
fills in the form, and it is built so that it never has to be trusted with money:

- **The page makes the coin's mint key** in the visitor's browser. Only the public half is sent here.
- **This server builds the transaction** (pump.fun `create_v2`, plus the creator's first buy when there is one) with
  the creator as payer and owner. No fee is taken and creator fees are not shared: they all go to the creator.
- **The browser signs it twice**, first with the mint key, then with the creator's wallet.
- **The server sends it only if the signed message is byte for byte the one it built**, signed by both. A wallet or
  page that changed anything gets nothing sent.

It holds no private key, no database and no session. Its only state is a public log of launches that went live
(`/v1/recent`).

## API

| Route | What it does |
| --- | --- |
| `POST /v1/prepare` | `{creator, mint, name, symbol, description?, image (data URL), website?, twitter?, telegram?, devBuySol?}` → stores image and metadata on IPFS, returns `{id, tx}` (base64, unsigned) |
| `POST /v1/submit` | `{id, signed}` → checks and sends, returns `{status: live\|pending, signature, mint}` |
| `GET /v1/status/:signature` | `live`, `pending`, `failed` or `unknown` |
| `GET /v1/recent` | the last 24 launches that went live |
| `GET /health` | whether launches are switched on |

Limits: 6 launches per IP an hour, 150 a day overall (`LAUNCHES_PER_IP_HOUR`, `LAUNCHES_PER_DAY`). A built launch
waits 150 seconds for its signatures.

## Run

```sh
npm ci
SOLANA_RPC_URL=https://… PINATA_JWT=… ALLOWED_ORIGINS=http://localhost:8000 npm start
npm test                      # form checks, transaction size, signature checks (reads mainnet, sends nothing)
node test/simulate.mjs        # simulates a real launch with and without a dev buy on mainnet, spends nothing
```

| Variable | |
| --- | --- |
| `SOLANA_RPC_URL` | required; any mainnet RPC |
| `PINATA_JWT` | required; Pinata key with Files: Write |
| `ALLOWED_ORIGINS` | pages allowed to call the API (default `https://gemsearch.fun,https://www.gemsearch.fun`) |
| `LAUNCH_TABLE` | optional address lookup table; keeps the priority fee on large launches with a dev buy |
| `LAUNCHPAD_PAUSED=1` | refuses new launches |
| `TRUST_PROXY=1` | behind a reverse proxy: per-visitor limits use the address it appends to `X-Forwarded-For` |
