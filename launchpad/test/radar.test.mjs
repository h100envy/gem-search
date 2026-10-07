import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatHit, pickReply, QUERY } from '../bot/radar.mjs';

test('the query fits X search and leaves out reposts and replies', () => {
  assert.ok(QUERY.length <= 512, `${QUERY.length} chars`);
  assert.match(QUERY, /-is:retweet/);
  assert.match(QUERY, /-is:reply/);
});

test('an alert names the author, freshness and crowd, escapes the text, and links a prefilled reply', () => {
  const now = Date.parse('2026-10-07T10:10:00Z');
  const hit = formatHit({ id: '123', text: 'I need a #1000x Gem <b>shill me</b>', created_at: '2026-10-07T10:07:00Z', public_metrics: { reply_count: 12, like_count: 40 } }, { username: 'MrHodlReal', verified: true, public_metrics: { followers_count: 48200 } }, 1, now);
  assert.match(hit.text, /@MrHodlReal/);
  assert.match(hit.text, /48\.2K followers/);
  assert.match(hit.text, /3 min ago/);
  assert.match(hit.text, /&lt;b&gt;shill me&lt;\/b&gt;/);
  const [open, reply] = hit.keyboard.inline_keyboard[0];
  assert.equal(open.url, 'https://x.com/MrHodlReal/status/123');
  assert.ok(reply.url.startsWith('https://x.com/intent/post?in_reply_to=123&text='));
  assert.equal(decodeURIComponent(reply.url.split('text=')[1]), pickReply(1));
});

test('drafts rotate and mention the ticker', () => {
  assert.notEqual(pickReply(0), pickReply(1));
  for (let i = 0; i < 4; i++) assert.match(pickReply(i), /\$GEMSEARCH/);
});

test('a tracked post finds the contract address and offers a scan', async () => {
  const { formatTracked, findCA } = await import('../bot/radar.mjs');
  assert.equal(findCA('ape this GQCGitfVw5LYnj4L4zrNUMYeK9dNxEJi9ZjMwMfQpump now'), 'GQCGitfVw5LYnj4L4zrNUMYeK9dNxEJi9ZjMwMfQpump');
  assert.equal(findCA('no address, just $WIF talk'), null);
  const a = formatTracked({ id: '9', text: 'new gem GQCGitfVw5LYnj4L4zrNUMYeK9dNxEJi9ZjMwMfQpump', created_at: new Date().toISOString(), public_metrics: {} }, { username: 'kol', public_metrics: { followers_count: 120000 } });
  assert.match(a.text, /@kol/);
  assert.equal(a.keyboard.inline_keyboard[0][1].url, 'https://gemsearch.fun/scan?ca=GQCGitfVw5LYnj4L4zrNUMYeK9dNxEJi9ZjMwMfQpump');
  const b = formatTracked({ id: '10', text: 'buying $wif and $BONK', created_at: new Date().toISOString() }, { username: 'kol' });
  assert.match(b.text, /\$WIF \$BONK/);
  assert.equal(b.keyboard.inline_keyboard[0].length, 1);
});

test('the shill query leaves art and NFT requests out', async () => {
  const { QUERY } = await import('../bot/radar.mjs');
  assert.match(QUERY, /-NFT/);
  assert.ok(QUERY.length <= 512, `${QUERY.length}`);
});
