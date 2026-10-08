const alertPanel = document.createElement('section');
alertPanel.className = 'panel';
alertPanel.innerHTML = '<div class="panel-heading"><div><h2>Telegram token alerts</h2><p>More than $100,000 net swap inflow in 5 minutes · $40,000 market cap before token age 5 minutes</p><p>Discovery samples recent GeckoTerminal pools across networks. Market-cap alerts require a token creation timestamp from a connected source.</p><label>Duration<select id="alert-duration"><option value="0">Until I stop</option><option value="15">15 minutes</option><option value="60">1 hour</option></select></label><button id="alert-start" class="primary">Start alerts</button><button id="alert-stop" class="secondary">Stop alerts</button><p id="alert-status" role="status"></p><div id="alert-results"></div></div></div>';
document.querySelector('.pipeline').before(alertPanel);
alertPanel.querySelector('h2').textContent = 'Desktop token alerts';
const notificationControls = document.createElement('div');
notificationControls.innerHTML = '<button id="enable-notifications" class="secondary">Enable desktop notifications</button><button id="test-notification" class="secondary">Send test notification</button><p id="notification-status" role="status">Keep this dashboard open for desktop notifications.</p>';
alertPanel.querySelector('h2').after(notificationControls);
const cursorKey = 'gem-search-desktop-alert-cursor';
function notificationStatus() {
  return 'Notification' in window ? Notification.permission : 'unsupported in this browser';
}
function notifyAlert(alert) {
  const label = alert.rule === 'net_inflow_100k_5m' ? 'Net inflow above $100,000' : 'Market cap reached $40,000 before age 5 minutes';
  const notification = new Notification(label, {body: alert.chain + ' · ' + alert.address + '\n$' + alert.value_usd.toLocaleString() + '\n' + new Date(alert.captured_at * 1000).toLocaleString(), tag: 'gem-search-alert-' + alert.id});
  notification.onclick = () => { window.focus(); notification.close(); };
}
async function deliverDesktopAlerts(alerts) {
  if (notificationStatus() !== 'granted') return;
  const deliver = () => {
    const stored = localStorage.getItem(cursorKey);
    if (stored === null) {
      localStorage.setItem(cursorKey, String(Math.max(0, ...alerts.map(alert => alert.id))));
      return;
    }
    let cursor = Number(stored) || 0;
    for (const alert of [...alerts].sort((a, b) => a.id - b.id)) {
      if (alert.id <= cursor) continue;
      notifyAlert(alert);
      cursor = alert.id;
      localStorage.setItem(cursorKey, String(cursor));
    }
  };
  if (navigator.locks) await navigator.locks.request('gem-search-desktop-alerts', deliver);
  else deliver();
}
document.getElementById('enable-notifications').addEventListener('click', async () => {
  if (!('Notification' in window)) return notice('Use Brave or Chrome for desktop notifications');
  const permission = await Notification.requestPermission();
  document.getElementById('notification-status').textContent = 'Desktop notifications: ' + permission + '. Keep this dashboard open.';
  await refreshAlerts();
});
document.getElementById('test-notification').addEventListener('click', () => {
  if (notificationStatus() !== 'granted') return notice('Enable desktop notifications first');
  new Notification('Gem Search test', {body: 'Desktop notifications are connected. This is a test, not a token alert.', tag: 'gem-search-test'});
});
async function refreshAlerts() {
  try {
    const data = await api('alerts');
    document.getElementById('alert-status').textContent = (data.monitor.enabled ? 'Monitoring' : 'Stopped') + ' · Desktop notifications: ' + notificationStatus() + ' · ' + data.monitor.checked + ' tokens checked · ' + data.monitor.skipped + ' incomplete samples skipped' + (data.monitor.error ? ' · ' + data.monitor.error : '');
    await deliverDesktopAlerts(data.alerts);
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
