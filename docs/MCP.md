# Gem Search MCP

Gem Search provides five read-only tools for MCP-compatible local assistants. The Windows download contains the server. Python is not required for the executable.

## Connect

1. Download and open the latest Gem Search Desktop release.
2. Select Assistant connection in the sidebar.
3. Select Test connection to verify the local server.
4. Select Copy connection setup and add that configuration to your assistant's MCP server settings.

The copied configuration uses the current application path and local data directory. It contains no API keys. Configuration screens vary between assistants. Move the executable only before configuring the assistant, or copy a new configuration afterward.

For a manual setup, set the command to the full path of GemSearch-Desktop.exe and arguments to `["--mcp"]`. The default data directory is the desktop app's local directory. An optional `--data-dir` selects another local instance at launch, not through a tool call.

This release uses standard input and output, with no network listener. The assistant launches the same executable in MCP mode. That mode reads saved data without opening another monitor, starting a scanner or loading data-provider credentials. It can run while the desktop app is open. With the desktop closed, saved records remain readable and monitoring status eventually becomes unknown.

## Tools

| Tool | Parameters | Result |
| --- | --- | --- |
| list_tokens | query, page, page_size, scope, sort, minimum_market_cap, confirmed_only | Ranked token records and pagination |
| get_token | address, chain | A saved token and freshness information |
| list_wallets | query, page, page_size | Saved wallet directory entries |
| get_alerts | page, page_size | Saved alerts with general event categories |
| get_status | None | Data availability and recently observed monitoring status |

Pages start at 1. Page size is 50 or 100. Token scope is live, watchlist or saved; default live. Sort is market_cap, newest or name; default market_cap. Unavailable market values appear last. Live means the app's available local live records, not complete market coverage. Stale values are marked. Wallet directory entries do not imply live wallet tracking.

Example requests: "Show my top 50 tokens", "Which watched tokens have stale data?", "Find this wallet in my saved directory", or "Show my recent alerts".

## Data access

Responses include selected token values, names, addresses, freshness, wallet entries, saved alert values and general status. Credentials, provider identifiers, raw payloads, strategy rules and private settings are excluded. The assistant can send requested results to its model provider. Each user connects their own local app data. No central account, shared key or public data service is included.

Read-only tools cannot modify watchlists, trade, change settings or start and stop monitoring. Live activity and alert coverage remain incomplete.

## Compatibility and source

Use a host that supports local MCP servers over stdio. Assistants that only accept remote HTTPS MCP URLs need a separately hosted, authenticated service, which is not part of this release. MCP support depends on the host application, not the underlying language model alone.

For a source installation, install requirements-desktop.txt and run `python desktop.py --mcp`. The protocol and output handling use the official Python MCP SDK. Run the MCP tests with `python -m unittest discover -s tests -p test_gem_mcp.py`.
