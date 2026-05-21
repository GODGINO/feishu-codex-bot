// Popup UI controller — manages multiple session keys

// DEPLOYMENT CONFIG: set to your Sigma server URL before packaging.
// For local dev use 'http://localhost:3333'. Keep out of public repos.
const RELAY_URL = 'https://your-sigma-server.example.com';
const $ = (id) => document.getElementById(id);

let sessions = []; // [{ key, name, type }]

// ── UI Rendering ──

function renderSessionList() {
  const list = $('sessionList');
  if (sessions.length === 0) {
    list.innerHTML = '<div class="empty-hint">No sessions added</div>';
    return;
  }
  list.innerHTML = sessions.map((s, i) => `
    <div class="session-item">
      <span class="name" title="${s.key}">${s.name || s.key}</span>
      <span class="tag ${s.type === 'dm' ? 'tag-dm' : 'tag-group'}">${s.type === 'dm' ? '私' : '群'}</span>
      <button class="remove" data-index="${i}" title="Remove">&times;</button>
    </div>
  `).join('');

  list.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.index);
      sessions.splice(idx, 1);
      saveSessions();
      renderSessionList();
      updateButtons();
    });
  });
}

function updateStatus(state) {
  if (!state) return;
  const dot = $('dot');
  const statusText = $('statusText');

  dot.className = 'dot';
  if (state.connected) {
    const count = state.sessionKeys?.length || sessions.length;
    dot.classList.add('dot-on');
    statusText.textContent = `Connected (${count} session${count !== 1 ? 's' : ''})`;
    $('connectBtn').style.display = 'none';
    $('disconnectBtn').style.display = '';
  } else if (state.connecting) {
    dot.classList.add('dot-connecting');
    statusText.textContent = 'Connecting...';
    $('connectBtn').style.display = 'none';
    $('disconnectBtn').style.display = 'none';
  } else {
    dot.classList.add('dot-off');
    statusText.textContent = state.error ? 'Error: ' + state.error : 'Disconnected';
    $('connectBtn').style.display = '';
    $('disconnectBtn').style.display = 'none';
  }
}

function updateButtons() {
  $('connectBtn').disabled = sessions.length === 0;
}

function showError(msg) {
  const el = $('errorMsg');
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
}

// ── Storage ──

function saveSessions() {
  chrome.storage.local.set({ sessionKeys: sessions });
}

// ── Session Name Resolution ──

async function resolveSessionName(key) {
  try {
    const res = await fetch(`${RELAY_URL}/api/session-names?keys=${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data[key] || null;
  } catch {
    return null;
  }
}

// ── Init ──

chrome.storage.local.get(['sessionKeys'], (data) => {
  sessions = data.sessionKeys || [];
  renderSessionList();
  updateButtons();
});

chrome.runtime.sendMessage({ type: 'getState' }, (resp) => {
  if (chrome.runtime.lastError) return;
  updateStatus(resp);
});

// ── Add session key ──

$('addBtn').addEventListener('click', async () => {
  const key = $('newKey').value.trim();
  if (!key) return;
  if (sessions.some(s => s.key === key)) {
    showError('Session already added');
    return;
  }
  showError('');

  $('addBtn').disabled = true;
  $('addBtn').textContent = '...';

  const info = await resolveSessionName(key);
  sessions.push({
    key,
    name: info?.name || key,
    type: info?.type || (key.startsWith('dm_') ? 'dm' : 'group'),
  });

  saveSessions();
  renderSessionList();
  updateButtons();
  $('newKey').value = '';
  $('addBtn').disabled = false;
  $('addBtn').textContent = 'Add';
});

// Allow Enter key to add
$('newKey').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('addBtn').click();
});

// ── Connect / Disconnect ──

$('connectBtn').addEventListener('click', () => {
  if (sessions.length === 0) return;
  showError('');

  const keys = sessions.map(s => s.key);
  updateStatus({ connecting: true, connected: false });

  chrome.runtime.sendMessage({ type: 'connect', relayUrl: RELAY_URL, sessionKeys: keys }, (resp) => {
    if (chrome.runtime.lastError) {
      updateStatus({ connected: false, connecting: false, error: chrome.runtime.lastError.message });
      return;
    }
    updateStatus(resp);
  });
});

$('disconnectBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnect' }, (resp) => {
    if (chrome.runtime.lastError) return;
    updateStatus(resp);
  });
});

// Listen for state changes from service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'stateChanged') {
    updateStatus(msg.state);
  }
});
