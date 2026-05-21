/**
 * Service Worker — WebSocket relay client
 *
 * Connects to the relay server with multiple session keys,
 * receives commands, dispatches them to content scripts or
 * chrome.* APIs, and sends responses back.
 *
 * Uses chrome.alarms + chrome.storage to survive MV3 service worker termination.
 */

const connections = new Map(); // sessionKey -> WebSocket
let state = { connected: false, connecting: false, sessionKeys: [], relayUrl: '' };
let activeTabId = null; // Currently selected tab for operations
let manualDisconnect = false;

// ── Keepalive: prevent Chrome from killing the service worker while connected ──

const KEEPALIVE_ALARM = 'sigma-keepalive';
const KEEPALIVE_INTERVAL = 0.4; // minutes (~24s, under Chrome's 30s idle limit)

function startKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL });
}

function stopKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // This callback alone keeps the service worker alive.
    // Also check if connections are still open; if not, reconnect.
    if (connections.size === 0 && !manualDisconnect && state.relayUrl && state.sessionKeys.length > 0) {
      console.log('[Sigma] Keepalive: connections lost, reconnecting...');
      connect(state.relayUrl, state.sessionKeys);
    }
  }
});

// ── Persist connection config so we can reconnect after SW restart ──

async function saveConfig() {
  await chrome.storage.local.set({
    sigmaConfig: {
      relayUrl: state.relayUrl,
      sessionKeys: state.sessionKeys,
      manualDisconnect,
    }
  });
}

async function loadAndReconnect() {
  const data = await chrome.storage.local.get('sigmaConfig');
  const config = data.sigmaConfig;
  if (config && !config.manualDisconnect && config.relayUrl && config.sessionKeys?.length > 0) {
    console.log('[Sigma] SW restarted, auto-reconnecting...');
    connect(config.relayUrl, config.sessionKeys);
  }
}

// ── State management ──

function setState(updates) {
  Object.assign(state, updates);
  // Notify popup if open
  chrome.runtime.sendMessage({ type: 'stateChanged', state }).catch(() => {});
}

// ── WebSocket connection ──

function connect(relayUrl, sessionKeys) {
  disconnect(true); // silent disconnect (don't mark as manual)
  manualDisconnect = false;

  if (!sessionKeys || sessionKeys.length === 0) return;

  setState({ connecting: true, sessionKeys, relayUrl });
  saveConfig();
  startKeepalive();

  const wsBase = relayUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:').replace(/\/$/, '');
  let connectedCount = 0;
  let errorOccurred = false;

  for (const key of sessionKeys) {
    const wsUrl = wsBase + '/relay?session=' + encodeURIComponent(key);
    console.log('[Sigma] Connecting:', key);

    try {
      const socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        console.log('[Sigma] Connected:', key);
        connectedCount++;
        if (connectedCount === sessionKeys.length) {
          setState({ connected: true, connecting: false, error: '' });
        }
      };

      socket.onclose = (e) => {
        console.log('[Sigma] Disconnected:', key, e.code, e.reason);
        connections.delete(key);

        // If all connections are gone
        if (connections.size === 0) {
          setState({ connected: false, connecting: false });
          // Auto-reconnect unless manual disconnect
          if (!manualDisconnect && e.code !== 4000) {
            setTimeout(() => {
              if (!state.connected && !state.connecting) {
                console.log('[Sigma] Auto-reconnecting all...');
                connect(relayUrl, sessionKeys);
              }
            }, 3000);
          }
        }
      };

      socket.onerror = (err) => {
        console.error('[Sigma] WebSocket error:', key, err);
        if (!errorOccurred) {
          errorOccurred = true;
          setState({ connecting: false, connected: false, error: 'Connection failed' });
        }
      };

      socket.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          await handleRelayMessage(msg, socket);
        } catch (err) {
          console.error('Failed to handle message:', err);
        }
      };

      connections.set(key, socket);
    } catch (err) {
      console.error('[Sigma] WebSocket creation failed:', key, err);
    }
  }
}

function disconnect(silent = false) {
  if (!silent) {
    manualDisconnect = true;
    stopKeepalive();
    saveConfig();
  }
  for (const [key, socket] of connections) {
    socket.close(4000, 'User disconnect');
  }
  connections.clear();
  setState({ connected: false, connecting: false });
}

function sendToSocket(socket, msg) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

// ── Command signature verification (Web Crypto API) ──

async function hmacSha256(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getSessionKeyForSocket(socket) {
  for (const [key, ws] of connections) {
    if (ws === socket) return key;
  }
  return null;
}

// ── Message handling ──

async function handleRelayMessage(msg, socket) {
  switch (msg.type) {
    case 'command': {
      // Verify command signature — reject unsigned or forged commands
      const key = getSessionKeyForSocket(socket);
      if (!key || !msg.sig) {
        console.error('[Sigma] Command rejected — missing signature');
        sendToSocket(socket, { type: 'response', payload: { id: msg.payload.id, error: 'Missing command signature' } });
        break;
      }
      const expected = await hmacSha256(key, msg.payload.id + msg.payload.tool);
      if (msg.sig !== expected) {
        console.error('[Sigma] Command rejected — invalid signature');
        sendToSocket(socket, { type: 'response', payload: { id: msg.payload.id, error: 'Invalid command signature' } });
        break;
      }
      await handleCommand(msg.payload, socket);
      break;
    }
    case 'ping':
      sendToSocket(socket, { type: 'pong' });
      break;
  }
}

async function handleCommand(command, socket) {
  const { id, tool, params } = command;
  try {
    const result = await executeTool(tool, params);
    sendToSocket(socket, { type: 'response', payload: { id, result } });
  } catch (err) {
    sendToSocket(socket, { type: 'response', payload: { id, error: err.message || String(err) } });
  }
}

// ── Tool execution ──

async function getActiveTab() {
  if (activeTabId) {
    try {
      const tab = await chrome.tabs.get(activeTabId);
      if (tab) return tab;
    } catch { /* tab may have been closed */ }
  }
  // Fallback: get the currently active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) activeTabId = tab.id;
  return tab;
}

async function executeInContent(tabId, action, params) {
  const response = await chrome.tabs.sendMessage(tabId, { action, params });
  if (response && response.error) throw new Error(response.error);
  return response?.result;
}

async function executeTool(tool, params) {
  switch (tool) {
    case 'take_snapshot': {
      const tab = await getActiveTab();
      if (!tab) throw new Error('No active tab');
      return await executeInContent(tab.id, 'take_snapshot', params);
    }

    case 'take_screenshot': {
      if (params.uid) {
        const tab = await getActiveTab();
        if (!tab) throw new Error('No active tab');
        const rect = await executeInContent(tab.id, 'get_element_rect', { uid: params.uid });
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
        return { dataUrl, clip: rect };
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
      return { dataUrl };
    }

    case 'click': {
      const tab = await getActiveTab();
      if (!tab) throw new Error('No active tab');
      return await executeInContent(tab.id, 'click', params);
    }

    case 'fill': {
      const tab = await getActiveTab();
      if (!tab) throw new Error('No active tab');
      return await executeInContent(tab.id, 'fill', params);
    }

    case 'type_text': {
      const tab = await getActiveTab();
      if (!tab) throw new Error('No active tab');
      return await executeInContent(tab.id, 'type_text', params);
    }

    case 'press_key': {
      const tab = await getActiveTab();
      if (!tab) throw new Error('No active tab');
      return await executeInContent(tab.id, 'press_key', params);
    }

    case 'hover': {
      const tab = await getActiveTab();
      if (!tab) throw new Error('No active tab');
      return await executeInContent(tab.id, 'hover', params);
    }

    case 'fill_form': {
      const tab = await getActiveTab();
      if (!tab) throw new Error('No active tab');
      return await executeInContent(tab.id, 'fill_form', params);
    }

    case 'wait_for': {
      const tab = await getActiveTab();
      if (!tab) throw new Error('No active tab');
      return await executeInContent(tab.id, 'wait_for', params);
    }

    case 'navigate_page': {
      const tab = await getActiveTab();
      if (!tab) throw new Error('No active tab');
      const type = params.type || 'url';
      if (type === 'url' && params.url) {
        await chrome.tabs.update(tab.id, { url: params.url });
        await new Promise((resolve) => {
          const listener = (tabId, info) => {
            if (tabId === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 30000);
        });
        return { url: params.url };
      } else if (type === 'back' || type === 'forward') {
        await chrome.tabs.sendMessage(tab.id, { action: 'navigate', params: { type } });
        return { type };
      } else if (type === 'reload') {
        await chrome.tabs.reload(tab.id);
        return { type: 'reload' };
      }
      break;
    }

    case 'evaluate_script': {
      const tab = await getActiveTab();
      if (!tab) throw new Error('No active tab');
      return await executeInContent(tab.id, 'evaluate_script', params);
    }

    case 'list_pages': {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      return tabs.map((t, i) => ({
        pageId: t.id,
        url: t.url,
        title: t.title,
        active: t.id === activeTabId,
      }));
    }

    case 'select_page': {
      const { pageId } = params;
      const tab = await chrome.tabs.get(pageId);
      if (!tab) throw new Error(`Tab ${pageId} not found`);
      activeTabId = tab.id;
      await chrome.tabs.update(tab.id, { active: true });
      return { pageId: tab.id, url: tab.url, title: tab.title };
    }

    case 'new_page': {
      const tab = await chrome.tabs.create({ url: params.url, active: true });
      activeTabId = tab.id;
      await new Promise((resolve) => {
        const listener = (tabId, info) => {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 30000);
      });
      return { pageId: tab.id, url: tab.url, title: tab.title };
    }

    case 'close_page': {
      const { pageId } = params;
      await chrome.tabs.remove(pageId);
      if (activeTabId === pageId) activeTabId = null;
      return { closed: pageId };
    }

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

// ── Message listener for popup ──

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'getState':
      sendResponse(state);
      return false;
    case 'connect':
      connect(msg.relayUrl, msg.sessionKeys);
      sendResponse(state);
      return false;
    case 'disconnect':
      disconnect();
      sendResponse(state);
      return false;
  }
});

// ── Auto-reconnect on SW restart ──

loadAndReconnect();
