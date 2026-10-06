# Gem Search Desktop

Download GemSearch-Desktop.exe from this repository's Releases page. Windows x64 is supported. Python, Node and a browser extension are not required. The executable is unsigned.

Open the program and press Start monitoring. Choose Until I stop or a time limit. Live tokens shows discovered tokens before they trigger an alert. Search by name, chain or address. Select a token to copy its address or add it to the watchlist. Triggered alerts stores alert history. Settings allows manual watchlist entries and desktop notification controls.

The compact header leaves more room for tokens. Table columns fit the window, with Previous and Next pages sized to the available height. Search covers every saved token. Keep on top can keep the window above other applications. The app opens at the front.

Closing the window keeps the program in the system tray. Double-click the tray icon to reopen it. Stop pauses collection. Quit exits and stops monitoring. Settings and history are saved in `%LOCALAPPDATA%\GemSearch`. Monitoring cannot run while the computer is asleep or powered off.

The inflow rule triggers when indexed buys minus sells exceed $100,000 during five minutes. It triggers again after falling below the threshold and crossing it again. Discovery samples the latest 20 GeckoTerminal pools across supported networks, within a shared public API request budget. Watchlist entries receive priority. Coverage is incomplete; missing or truncated swap data stays unavailable. This is not an exhaustive all-chain scanner.

The $40,000 market-cap-before-five-minutes rule requires a reliable token creation source and is not automatically active. Pool age and fully diluted valuation are not substituted.

Market cap uses GeckoTerminal when reported, with a batched DexScreener fallback for missing values and watched tokens. The app displays the provider and sample time. The highest-liquidity matching DexScreener base-token pair supplies the reported market cap. Missing responses do not erase a previously sampled value; its time remains visible. FDV is never substituted for market cap.

## Solana supply valuation

Supply valuation (FD) is separate from reported market cap. The app calls Solana mainnet getMultipleAccounts with jsonParsed encoding and confirmed commitment. Mint supply is read as an integer with its decimals and chain slot. Decimal arithmetic multiplies that current minted supply by the selected pool USD price. It does not establish circulating supply or maximum future supply. Prices remain supplied by DexScreener and can be unreliable in thin or manipulated pools. Missing pool liquidity remains missing in the token details.

Double-click a token to inspect supply, decimals, chain slot, price provider, selected price pool, reported liquidity, valuation method and timestamps. The Solscan button opens the token's explorer page for comparison; the app does not call the authenticated Solscan Pro API.

Watched tokens and discovery tokens refresh each poll. Other saved tokens refresh in rotating batches of up to 500, using price requests of up to 30 tokens and supply requests of up to 100 mints. Samples older than three minutes display STALE. Old values are not treated as current quotes. Direct supply reads currently cover Solana; other networks keep their provider-reported market cap.

Sources: https://solana.com/docs/rpc/http/getmultipleaccounts and https://docs.solscan.io/browsing-the-site/token-page.

## Build from source

Use Windows x64 and Python 3.11 or later:

```powershell
python -m venv .venv-desktop
.venv-desktop/Scripts/python.exe -m pip install -r requirements-desktop.txt
.venv-desktop/Scripts/python.exe scripts/build_desktop.py
```

The executable is produced at `dist/desktop/GemSearch-Desktop.exe`. The source distribution allows rebuilding the executable with replacement Qt/PySide libraries. See THIRD_PARTY_NOTICES.txt and the included license files.

For an isolated UI smoke test, run the executable with `--data-dir PATH --smoke-test SCREENSHOT.png`. This uses labeled fixture data and writes a screenshot and test result JSON. Use an empty test directory.

For a responsiveness check, run with `--data-dir EMPTY_TEST_DIRECTORY --responsiveness-test RESULT.json`. This uses 2,000 fixture tokens, locks the test database for two seconds, and checks interface heartbeats, search, full-address copying and a queued settings write. It writes JSON results and a screenshot without contacting market providers. Always use a separate test directory.

Tables use a virtual model and only replace changed snapshots. Local reads and settings writes run on a background worker. Database lock waits occur before taking the monitor control lock, so Stop remains responsive and a canceled session cannot publish an alert that was waiting for storage. Quit saves queued settings before closing.
