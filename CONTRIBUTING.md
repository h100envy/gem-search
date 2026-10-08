# Contributing

Start with the local playground at http://127.0.0.1:8787/spider-demo. Real X markup changes frequently; extraction improvements should include a sanitized synthetic fixture, not private account content.

```sh
npm ci --ignore-scripts
python3 -m unittest discover -s tests -v
npm test
python3 scripts/package_extension.py
```

Never use live credentials or broadcast Solana transactions in tests. Keep new browser permissions minimal and explain any added permissions in the PR. Grok behavior must remain optional and mocked in CI. Keep uncertainty visible in the product; do not turn missing evidence into a pass.

Files to know: extension/shared.js (post extraction), extension/spider-ui.js (spider), jev.py (signals), grok.py (reviewers), app.py (HTTP and crawler), automation.py and launch/ (optional launch engine).

Scanner regression tests in `tests/scanner.test.mjs` run the actual worker/content scripts with simulated browser APIs, clocks and rendered posts. Before shipping an extension release, also verify on current Chrome/Brave with a test account:

- Start an until-stopped session, switch tabs/apps, and confirm the selected feed keeps collecting.
- Open an inline reply editor: collection continues but foreground auto-scroll avoids disrupting typing.
- Set a time limit and confirm captures stop at its deadline, including after worker suspension or device sleep.
- Stop from an unrelated tab with a slow/offline backend; confirm no further captures enter the queue.
- Reload the selected feed and verify the original session/deadline returns. Restore a discarded tab and check its waiting state clears.
- Confirm excluded routes and other origins end the session, and a browser restart requires explicit activation.

Mocked tests do not establish a guaranteed background sampling rate or compatibility with every future X layout. Do not disable browser sleep/discard protections to make a test pass.
