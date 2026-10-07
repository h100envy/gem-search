# Wallet transaction ingestion preview

Watch a Solana token in Gem Search, start monitoring, and open **On-chain activity**. The collector uses the selected market pool address saved by the market feed. Double-click a row to open the blockchain transaction. The table displays the latest 100 signer token balance changes across collected transactions.

The collector polls finalized signatures through Solana RPC. It initially queues the latest 100 signatures per pool. Subsequent collection paginates back to the saved checkpoint, persisting both the page position and the newest signature. Queue insertion and checkpoint updates share a database transaction. Restarting resumes queued transactions and unfinished pagination. Signatures are deduplicated across pools. Missing transactions and request failures remain queued for retry. Failed blockchain transactions do not produce balance events.

Transaction collection runs in a separate background worker. It rotates through watched Solana pools, requesting one signature page every 15 seconds and processing at most six queued transactions per cycle. This is a bounded desktop preview, not a full-chain indexer. Busy pools can produce a growing backlog. The interface reports queued transactions and collection errors. It does not claim complete time-window coverage. Public RPC rate limits and historical availability can prevent catch-up. The app must remain running and the machine awake.

Amounts are derived from raw integer token balances with exact decimal arithmetic. Only token owners that sign the transaction are included. Multiple accounts belonging to the same signer and mint are aggregated. These are transaction-level balance changes, not individual swap legs. Native SOL balance changes are not decoded. Non-signing authorities are excluded. Original finalized transaction responses remain in the local database for future protocol decoding.

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
