# Filter regression report

Date: 2026-10-07

Result: 500 tests passed, zero failures, zero errors.
Runtime: 28.810 seconds.

| Area | Tests |
| --- | ---: |
| Nine metric ranges across four timeframes, including inclusive boundaries, missing and invalid values, and stale data | 360 |
| Displayed activity values, selected-window isolation, freshness, zero counts and signed price changes | 80 |
| Apply, Reset, Cancel, pagination, persistence and snapshot refresh across all eight supported chains | 40 |
| Quote validation, invalid market capitalization, invalid price, chain isolation and separate FDV | 20 |
| Total | 500 |

Run with the desktop Python environment:

```text
python -m unittest tests.test_filter_matrix_500 -q
```

The desktop workflow cases press the actual dialog buttons and inspect resulting table rows, values, headers and saved settings. They exercise reopening and subsequent snapshots. Fixtures use synthetic tokens and fixed values. These checks validate filtering and presentation; they do not measure live provider coverage, RPC uptime or market-price accuracy.
