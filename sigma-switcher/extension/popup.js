const ENDPOINT = 'http://127.0.0.1:17222';

async function refreshStatus() {
  try {
    const r = await fetch(`${ENDPOINT}/status`);
    document.getElementById('server').innerHTML = '<span class="ok">online</span>';
    const j = await r.json();
    document.getElementById('last').textContent = j.last_poll || '—';
    document.getElementById('cmd').textContent = j.last_command || '—';
  } catch {
    document.getElementById('server').innerHTML = '<span class="bad">offline</span>';
  }
}

document.getElementById('ping').onclick = async () => {
  try {
    const r = await fetch(`${ENDPOINT}/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ping' }),
    });
    const j = await r.json();
    document.getElementById('out').textContent = JSON.stringify(j, null, 2);
  } catch (e) {
    document.getElementById('out').textContent = String(e);
  }
};

document.getElementById('usage').onclick = async () => {
  try {
    const r = await fetch(`${ENDPOINT}/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_usage' }),
    });
    const j = await r.json();
    document.getElementById('out').textContent = JSON.stringify(j, null, 2);
  } catch (e) {
    document.getElementById('out').textContent = String(e);
  }
};

refreshStatus();
setInterval(refreshStatus, 2000);
