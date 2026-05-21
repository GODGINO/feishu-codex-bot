// Renderer — session management UI (ported from browser-extension/popup.js)

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

  list.querySelectorAll('.remove').forEach((btn) => {
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

async function saveSessions() {
  await window.electronAPI.saveSessions(sessions);
}

// ── Init ──

(async () => {
  sessions = (await window.electronAPI.getSessions()) || [];
  renderSessionList();
  updateButtons();

  const state = await window.electronAPI.getState();
  updateStatus(state);
})();

// Listen for state changes from main process
window.electronAPI.onStateChanged((state) => {
  updateStatus(state);
});

// ── Add session key ──

$('addBtn').addEventListener('click', async () => {
  const key = $('newKey').value.trim();
  if (!key) return;
  if (sessions.some((s) => s.key === key)) {
    showError('Session already added');
    return;
  }
  showError('');

  $('addBtn').disabled = true;
  $('addBtn').textContent = '...';

  // Try to resolve name from server, fallback to short key
  let name = key;
  try {
    const info = await window.electronAPI.resolveSessionName(RELAY_URL, key);
    if (info?.name) name = info.name;
  } catch { /* use raw key */ }
  if (name === key) {
    // Show short version: dm_ou_2927a2d... or group_oc_365089...
    name = key.length > 20 ? key.slice(0, 18) + '...' : key;
  }

  sessions.push({
    key,
    name,
    type: key.startsWith('dm_') ? 'dm' : 'group',
  });

  await saveSessions();
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

$('connectBtn').addEventListener('click', async () => {
  if (sessions.length === 0) return;
  showError('');

  const keys = sessions.map((s) => s.key);
  updateStatus({ connecting: true, connected: false });

  const state = await window.electronAPI.connect(RELAY_URL, keys);
  updateStatus(state);
});

$('disconnectBtn').addEventListener('click', async () => {
  const state = await window.electronAPI.disconnect();
  updateStatus(state);
});
