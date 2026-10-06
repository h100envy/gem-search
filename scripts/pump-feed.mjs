const endpoint = new URL('wss://pumpportal.fun/api/data');
if (process.env.PUMPPORTAL_DATA_KEY) endpoint.searchParams.set('api-key', process.env.PUMPPORTAL_DATA_KEY);
const socket = new WebSocket(endpoint);
const keepalive = setInterval(() => {}, 1000);
socket.addEventListener('open', () => {
  socket.send(JSON.stringify({method: 'subscribeNewToken'}));
  socket.send(JSON.stringify({method: 'subscribeMigration'}));
  process.stdout.write(JSON.stringify({connected: true}) + '\n');
});
socket.addEventListener('message', event => {
  if (typeof event.data !== 'string' || event.data.length > 100000) return;
  try {
    const data = JSON.parse(event.data);
    if (data.errors || data.error) {
      process.stdout.write(JSON.stringify({error: 'Feed rejected subscription'}) + '\n');
      socket.close();
      return;
    }
    if (!['create', 'migration', 'migrate'].includes(data.txType) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(data.mint || '')) return;
    const record = {mint: data.mint, txType: data.txType, name: String(data.name || '').slice(0, 100), symbol: String(data.symbol || '').slice(0, 30), signature: String(data.signature || '').slice(0, 100)};
    process.stdout.write(JSON.stringify(record) + '\n');
  } catch {}
});
socket.addEventListener('error', () => {
  process.stdout.write(JSON.stringify({error: 'Feed connection unavailable'}) + '\n');
  socket.close();
});
socket.addEventListener('close', () => { clearInterval(keepalive); process.exit(0); });
setTimeout(() => { if (socket.readyState === WebSocket.CONNECTING) socket.close(); }, 15000).unref();
