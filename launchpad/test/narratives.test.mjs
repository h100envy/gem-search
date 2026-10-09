import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanPosts, createNarratives, tickerOf } from '../narratives.mjs';

test('tickers are cleaned to A-Z/0-9', () => {
  assert.equal(tickerOf('$wif hat!'), 'WIFHAT');
  assert.equal(tickerOf('averyveryverylongticker'), 'AVERYVERYV');
});

test('only cited X post links survive, normalized to x.com', () => {
  const cites = ['https://x.com/i/status/123456789', 'https://twitter.com/b/status/987654321?s=20'];
  assert.deepEqual(cleanPosts(['https://twitter.com/a/status/123456789', 'https://x.com/b/status/987654321', 'https://x.com/c/status/555555555', 'https://evil.com/x'], cites),
    ['https://x.com/a/status/123456789', 'https://x.com/b/status/987654321']);
});

test('a hunt keeps narratives with posts, dedupes tickers and counts clones from the feed', async () => {
  const body = { narratives: [
    { title: 'Robot dog ballet', why: 'A video of a robot dog dancing went viral.', name: 'Ballet Dog', ticker: '$bdog', heat: 'rising', kind: 'tech', posts: ['https://x.com/a/status/111111111'] },
    { title: 'Same ticker', why: 'dup', name: 'BDOG two', ticker: 'BDOG', heat: 'early', kind: 'meme', posts: ['https://x.com/a/status/111111111'] },
    { title: 'No sources', why: 'x', name: 'Ghost', ticker: 'GHOST', heat: 'hot', kind: 'meme', posts: [] },
  ] };
  const fetchFn = async () => new Response(JSON.stringify({ usage: { cost_in_usd_ticks: 2e8 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(body), annotations: [{ url: 'https://x.com/a/status/111111111' }] }] }] }), { status: 200 });
  const db = { prepare: () => ({ get: (t, ticker) => ({ n: ticker === 'BDOG' ? 7 : 0 }) }) };
  const n = createNarratives({ key: 'k', db, dataDir: mkdtempSync(join(tmpdir(), 'nar-')), fetchFn, logger: { error() {} } });
  const v = await n.get();
  assert.deepEqual(v.narratives.map((x) => [x.ticker, x.clones24h, x.posts.length]), [['BDOG', 7, 1]]);
  assert.equal(v.usd, 0.02);
});
