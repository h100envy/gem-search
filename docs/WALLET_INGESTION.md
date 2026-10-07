# Wallet transaction ingestion preview

Select a wallet in **Wallet directory** and click **Track selected wallet**, or paste a Solana wallet address in **On-chain activity** and click **Track wallet**. Start monitoring to collect finalized transactions referencing the wallet address. Tracking persists locally across restarts. The selector filters activity to a tracked wallet; **Stop tracking** stops new collection and pending requests for that target while preserving stored history. This preview supports 20 tracked wallets.

Watched token pools are also collected. Double-click an activity row to open its blockchain transaction. Each wallet has its own latest 100-event window, so busy pools cannot hide its activity in the selector.

Esc dismisses dialogs, returns secondary pages to Live tokens, clears active token search there, and minimizes the main window when already at the root page without a search. It does not stop monitoring.

The collector polls finalized signatures through Solana RPC. It initially queues the latest 100 signatures per pool. Subsequent collection paginates back to the saved checkpoint, persisting both the page position and the newest signature. Queue insertion and checkpoint updates share a database transaction. Restarting resumes queued transactions and unfinished pagination. Signatures are deduplicated across pools. Missing transactions and request failures remain queued for retry. Failed blockchain transactions do not produce balance events.

Transaction collection runs in a separate background worker. It rotates through tracked wallets and watched Solana pools, requesting one signature page every 15 seconds and processing at most six queued transactions per cycle. This is a bounded desktop preview, not a full-chain indexer. Busy targets can produce a growing backlog. The interface reports queued transactions and collection errors. It does not claim complete time-window coverage. Public RPC rate limits and historical availability can prevent catch-up. The app must remain running and the machine awake.

Amounts use raw integer balances and exact decimal arithmetic. Signer token owners and tracked non-signing owners are included. Multiple accounts belonging to an owner and mint are aggregated. These are transaction-level balance changes, not individual swap legs. Native SOL events include fees, rent and other balance effects. Original finalized transactions remain in the local database and can be decoded again for a newly tracked wallet without another download.

Wallet-address collection can miss incoming token transfers that reference only token accounts. Token-account discovery and subscriptions remain necessary for complete incoming coverage. The interface labels incoming coverage as partial.

## Current limitations

Transfers, liquidity deposits, withdrawals and routed trades can all change token balances. Every row is classified **Unknown**. This release deliberately does not label these events as buys, sells or bots and does not use them for USD net-flow alerts. Current token buy/sell filters still operate on the market feed's aggregate counts.

## Next stages

1. Decode supported protocol swap instructions, including inner instructions and multi-hop routes, against captured transactions.
2. Reconcile trader identity, native SOL and wrapped SOL, token fees and individual swap legs.
3. Measure collection gaps and add capacity for sustained busy-pool catch-up.
4. Add historical execution-time USD pricing and verified rolling trade summaries.
5. Add explainable bot confidence scores and recalculated filtered activity after sufficient wallet history exists.

## Verification

Run `python -m unittest tests.test_wallet_ingestion -q`. Cases cover exact amounts, transfers remaining unclassified, signer attribution, failed transactions, account creation and closure, ownership and decimal changes, durable pagination, restart deduplication, missing transaction retries, mismatched signatures, invalid discovery responses and stop behaviour.

RPC method references: [getSignaturesForAddress](https://solana.com/docs/rpc/http/getsignaturesforaddress) and [getTransaction](https://solana.com/docs/rpc/http/gettransaction).
