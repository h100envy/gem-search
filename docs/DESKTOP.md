# Gem Search Desktop

Use the sidebar to review tokens, alerts, watchlists, saved records and wallets. Settings contains local connection fields, notification preferences and monitoring duration.

Assistant connection contains a local MCP setup and connection test. See [MCP setup](MCP.md) for supported tools and compatible hosts.

Live tokens default to highest reported market cap first among available records. Unavailable values appear last. Open Filter to select sorting, a minimum market cap or confirmed mints. Search and filters apply before paging. Tables show 50 records per page by default; select 100 per page for a longer list. Previous and Next move between pages. Page-size preferences are saved locally.

Start monitoring manually. Stop it manually or set a time limit. Closing the window keeps monitoring in the system tray. Quit stops the app. Monitoring cannot run while the computer is asleep or powered off.

This Windows x64 preview supports Solana. Some live activity and alert features remain unavailable. Missing values are not estimated. Market values are reported values and are not independently verified USD valuations.

Enter credentials only in the local Settings fields. API access is separate from web account access. Keys and account records stay outside the repository.

Import wallet lists using CSV or JSON with name and address fields. Imports remain local and do not add wallet addresses to the token watchlist.

Download the ZIP from Releases for the executable and bundled licenses. The executable is unsigned. Build using requirements-desktop.txt and scripts/build_desktop.py.
