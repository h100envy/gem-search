# Gem Search Desktop

Download GemSearch-Desktop.exe from this repository's Releases page. Windows x64 is supported. Python, Node and a browser extension are not required. The executable is unsigned.

Open the program and press Start monitoring. Choose Until I stop or a time limit. Live tokens shows discovered tokens before they trigger an alert. Search by name, chain or address. Select a token to copy its address or add it to the watchlist. Triggered alerts stores alert history. Settings allows manual watchlist entries and desktop notification controls.

Closing the window keeps the program in the system tray. Double-click the tray icon to reopen it. Stop pauses collection. Quit exits and stops monitoring. Settings and history are saved in `%LOCALAPPDATA%\GemSearch`. Monitoring cannot run while the computer is asleep or powered off.

The inflow rule triggers when indexed buys minus sells exceed $100,000 during five minutes. It triggers again after falling below the threshold and crossing it again. Discovery samples the latest 20 GeckoTerminal pools across supported networks, within a shared public API request budget. Watchlist entries receive priority. Coverage is incomplete; missing or truncated swap data stays unavailable. This is not an exhaustive all-chain scanner.

The $40,000 market-cap-before-five-minutes rule requires a reliable token creation source and is not automatically active. Pool age and fully diluted valuation are not substituted.

## Build from source

Use Windows x64 and Python 3.11 or later:

```powershell
python -m venv .venv-desktop
.venv-desktop/Scripts/python.exe -m pip install -r requirements-desktop.txt
.venv-desktop/Scripts/python.exe scripts/build_desktop.py
```

The executable is produced at `dist/desktop/GemSearch-Desktop.exe`. The source distribution allows rebuilding the executable with replacement Qt/PySide libraries. See THIRD_PARTY_NOTICES.txt and the included license files.

For an isolated UI smoke test, run the executable with `--data-dir PATH --smoke-test SCREENSHOT.png`. This uses labeled fixture data and writes a screenshot and test result JSON. Use an empty test directory.
