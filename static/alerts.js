const alertPanel = document.createElement('section');
alertPanel.className = 'panel';
alertPanel.innerHTML = '<div class="panel-heading"><div><h2>Telegram token alerts</h2><p>More than $100,000 net swap inflow in 5 minutes · $40,000 market cap before token age 5 minutes</p><p>Discovery samples recent GeckoTerminal pools across networks. Market-cap alerts require a token creation timestamp from a connected source.</p><label>Duration<select id="alert-duration"><option value="0">Until I stop</option><option value="15">15 minutes</option><option value="60">1 hour</option></select></label><button id="alert-start" class="primary">Start alerts</button><button id="alert-stop" class="secondary">Stop alerts</button><p id="alert-status" role="status"></p><div id="alert-results"></div></div></div>';
document.querySelector('.pipeline').before(alertPanel);
async function refreshAlerts() {
  try {
    const data = await api('alerts');
    document.getElementById('alert-status').textContent = (data.monitor.enabled ? 'Monitoring' : 'Stopped') + ' · Telegram ' + (data.telegram.configured ? 'configured' : 'needs local setup') + ' · ' + data.monitor.checked + ' tokens checked · ' + data.monitor.skipped + ' incomplete samples skipped' + (data.monitor.error ? ' · ' + data.monitor.error : '') + (data.telegram.error ? ' · ' + data.telegram.error : '');
    const results = document.getElementById('alert-results');
    results.replaceChildren();
    for (const alert of data.alerts.slice(0, 10)) {
      const row = document.createElement('p');
      row.textContent = alert.chain + ' · ' + alert.address + ' · ' + alert.rule + ' · $' + alert.value_usd.toLocaleString() + ' · ' + new Date(alert.captured_at * 1000).toLocaleString();
      results.append(row);
    }
  } catch (error) { document.getElementById('alert-status').textContent = error.message; }
}
for (const [id, enabled] of [['alert-start', true], ['alert-stop', false]]) document.getElementById(id).addEventListener('click', async () => {
  try { await api('alerts/control', {enabled, minutes: Number(document.getElementById('alert-duration').value)}); await refreshAlerts(); }
  catch (error) { notice(error.message); }
});
refreshAlerts();
setInterval(refreshAlerts, 10000);
