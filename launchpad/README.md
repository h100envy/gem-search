# Gem Search launchpad

The server behind [gemsearch.fun/launch](https://gemsearch.fun/launch). It launches coins on pump.fun for whoever
fills in the form, and it is built so that it never has to be trusted with money:

- **The page makes the coin's mint key** in the visitor's browser. Only the public half is sent here.
- **This server builds the transaction** (pump.fun `create_v2`, plus the creator's first buy when there is one) with
  the creator as payer and owner. No fee is taken and creator fees are not shared: they all go to the creator.
- **The browser signs it twice**, first with the mint key, then with the creator's wallet.
- **The server sends it only if the signed message is byte for byte the one it built**, signed by both. A wallet or
  page that changed anything gets nothing sent.

It holds no key of anyone launching, no database and no session. Its only state is a public log of launches that went live
(`/v1/recent`).

## Creator fees to a GitHub account

The form can route part or all of the creator fees to any GitHub account, with pump.fun's own fee sharing set in the
launch transaction: the account's fee address (made if new), a sharing config and the split. The GitHub owner claims
in the pump.fun app by signing in with GitHub. The server looks the username up on GitHub itself, so the page cannot
send fees to an id the visitor did not see.

These launches need the launchpad's address lookup table to fit in one transaction. `node admin.mjs ops` makes a small
operator wallet (its key stays in the data volume), and once it holds ~0.01 SOL, `node admin.mjs table` makes the table;
put the printed address in `LAUNCH_TABLE`. The operator wallet pays for the table only, never for a launch.

## API

| Route | What it does |
| --- | --- |
| `POST /v1/prepare` | `{creator, mint, name, symbol, description?, image (data URL), website?, twitter?, telegram?, devBuySol?}` → stores image and metadata on IPFS, returns `{id, tx}` (base64, unsigned) |
| `POST /v1/submit` | `{id, signed, signedPre?}` → checks and sends (the GitHub fee address first when there is one), returns `{status: live\|pending, signature, mint}` |
| `GET /v1/status/:signature` | `live`, `pending`, `failed` or `unknown` |
| `GET /v1/recent` | the last 24 launches that went live |
| `GET /health` | whether launches, and launches with a GitHub split, are switched on |

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
| `GITHUB_TOKEN` | optional; lifts GitHub's 60 username lookups an hour |
| `TRUST_PROXY=1` | behind a reverse proxy: per-visitor limits use the address it appends to `X-Forwarded-For` |

## Telegram bot

`bot.mjs` is the Gem Search bot: the same scan and Web X-ray as the site, in a chat. Long polling with plain `fetch`,
no extra dependencies; the update offset and watch list live in `/data` (`bot-state.json`, `bot-watches.json`).

| Command | |
| --- | --- |
| `/scan <CA>` (or just send a CA in a private chat) | score, tags, market, every check |
| `/xray <CA>` | launch block, launch buyers, linked-wallet clusters, verdict |
| `/watch <CA>` · `/unwatch <CA>` · `/watches` | up to 5 coins per chat, re-scanned every 10 minutes; alerts on score −10, a new failed check, dev ±2 points, liquidity −30%, graduation, paid Dex profile, top 10 +10 points |
| `/launch` · `/token` · `/help` | links |

Limits per user: 8 scans and 3 X-rays a minute; scans are cached for 60 s and X-rays for 5 minutes.

```sh
TELEGRAM_BOT_TOKEN=… SOLANA_RPC_URL=… BOT_DATA_DIR=./data node bot.mjs
docker run -d --name gem-bot --restart unless-stopped --env-file .env -v "$PWD/data:/data" gem-launchpad:latest node bot.mjs
```

In groups the bot answers commands, mentions and replies to it; to read plain CA messages there, turn privacy mode off
in @BotFather (`/setprivacy` → Disable).
