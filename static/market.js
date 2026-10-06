const marketPanel = document.createElement('section');
marketPanel.className = 'panel';
marketPanel.innerHTML = '<div class="panel-heading"><div><h2>Token radar</h2><p>Solana market snapshots saved every minute while running</p><form id="market-watch"><label>Token address<input name="address" required maxlength="44"></label><button class="secondary">Watch token</button></form><label>Duration<select id="market-duration"><option value="0">Until I stop</option><option value="15">15 minutes</option><option value="60">1 hour</option></select></label><button id="market-start" class="primary">Start radar</button><button id="market-stop" class="secondary">Stop radar</button><p id="market-status" role="status"></p><div id="market-results"></div></div></div>';
document.querySelector('.pipeline').before(marketPanel);
marketPanel.insertAdjacentHTML('beforeend', '<div class="panel-heading"><div><h2>Pump.fun launch feed</h2><p>New tokens and migrations via PumpPortal</p><button id="pump-start" class="primary">Start launch feed</button><button id="pump-stop" class="secondary">Stop launch feed</button><p id="pump-status" role="status"></p><div id="pump-results"></div></div></div>');
async function refreshMarket() {
  try {
    const data = await api('market');
    document.getElementById('pump-status').textContent = (data.pump.enabled ? (data.pump.connected ? 'Connected' : 'Connecting') : 'Stopped') + (data.pump.error ? ' · ' + data.pump.error : '');
    const pumpResults = document.getElementById('pump-results');
    pumpResults.replaceChildren();
    for (const item of data.pump.events) {
      const row = document.createElement('p');
      row.textContent = item.txType + ' · ' + (item.name || item.mint) + ' · ' + item.symbol + ' · ' + new Date(item.captured_at * 1000).toLocaleString();
      const button = document.createElement('button');
      button.className = 'secondary';
      button.textContent = 'Watch market';
      button.addEventListener('click', async () => { try { await api('market/watch', {address: item.mint}); await refreshMarket(); } catch (error) { notice(error.message); } });
      row.append(button);
      pumpResults.append(row);
    }
    document.getElementById('market-status').textContent = (data.enabled ? 'Running' : 'Stopped') + ' · ' + data.watchlist.length + ' tokens' + (data.error ? ' · ' + data.error : '');
    const latest = new Map();
    for (const item of data.snapshots) if (!latest.has(item.address)) latest.set(item.address, item);
    const results = document.getElementById('market-results');
    results.replaceChildren();
    for (const item of latest.values()) {
      const p = item.pair;
      const row = document.createElement('p');
      row.textContent = (p.baseToken?.name || item.address) + ' · Price $' + (p.priceUsd ?? 'unavailable') + ' · Liquidity $' + (p.liquidity?.usd ?? 'unavailable') + ' · 24h volume $' + (p.volume?.h24 ?? 'unavailable') + ' · ' + new Date(item.captured_at * 1000).toLocaleString();
      results.append(row);
    }
  } catch (error) { document.getElementById('market-status').textContent = error.message; }
}
document.getElementById('market-watch').addEventListener('submit', async event => {
  event.preventDefault();
  try { await api('market/watch', {address: new FormData(event.target).get('address').trim()}); await refreshMarket(); }
  catch (error) { notice(error.message); }
});
for (const [id, enabled] of [['market-start', true], ['market-stop', false]]) document.getElementById(id).addEventListener('click', async () => {
  try { await api('market/control', {enabled, minutes: Number(document.getElementById('market-duration').value)}); await refreshMarket(); }
  catch (error) { notice(error.message); }
});
refreshMarket();
for (const [id, enabled] of [['pump-start', true], ['pump-stop', false]]) document.getElementById(id).addEventListener('click', async () => {
  try { await api('market/pump', {enabled, minutes: Number(document.getElementById('market-duration').value)}); await refreshMarket(); }
  catch (error) { notice(error.message); }
});
setInterval(refreshMarket, 10000);
