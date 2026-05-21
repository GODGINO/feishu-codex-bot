/**
 * WebSocket relay client — connects to relay-server, receives commands,
 * dispatches to executor, and sends responses back.
 *
 * Ported from browser-extension/service-worker.js for Electron (Node.js).
 */

import WebSocket from 'ws';
import { createHmac } from 'node:crypto';

export interface ConnectionState {
  connected: boolean;
  connecting: boolean;
  sessionKeys: string[];
  relayUrl: string;
  error?: string;
}

type CommandExecutor = (tool: string, params: Record<string, unknown>) => Promise<unknown>;

const connections = new Map<string, WebSocket>();
const socketToKey = new Map<WebSocket, string>(); // reverse lookup for signature verification
let state: ConnectionState = { connected: false, connecting: false, sessionKeys: [], relayUrl: '' };
let manualDisconnect = false;
let stateCallback: ((state: ConnectionState) => void) | null = null;
let executor: CommandExecutor | null = null;
let reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setState(updates: Partial<ConnectionState>): void {
  Object.assign(state, updates);
  stateCallback?.(state);
}

export function onStateChange(cb: (state: ConnectionState) => void): void {
  stateCallback = cb;
}

export function getState(): ConnectionState {
  return { ...state };
}


export function connect(relayUrl: string, sessionKeys: string[], exec: CommandExecutor): void {
  disconnectInternal(true);
  manualDisconnect = false;
  executor = exec;

  if (!sessionKeys || sessionKeys.length === 0) return;

  setState({ connecting: true, sessionKeys, relayUrl });

  const wsBase = relayUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:').replace(/\/$/, '');
  let connectedCount = 0;

  for (const key of sessionKeys) {
    const wsUrl = `${wsBase}/relay?session=${encodeURIComponent(key)}`;

    try {
      const socket = new WebSocket(wsUrl);

      socket.on('open', () => {
        connectedCount++;
        if (connectedCount === sessionKeys.length) {
          setState({ connected: true, connecting: false, error: '' });
        }
      });

      socket.on('close', (code) => {
        connections.delete(key);

        if (connections.size === 0) {
          setState({ connected: false, connecting: false });
          // Auto-reconnect unless manual disconnect
          if (!manualDisconnect && code !== 4000) {
            const timer = setTimeout(() => {
              reconnectTimers.delete(key);
              if (!state.connected && !state.connecting && executor) {
                connect(relayUrl, sessionKeys, executor);
              }
            }, 3000);
            reconnectTimers.set(key, timer);
          }
        }
      });

      socket.on('error', (err) => {
        setState({ connecting: false, connected: false, error: 'Connection failed' });
      });

      socket.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          await handleMessage(msg, socket);
        } catch (err: any) {
          console.error('[Sigma] Message handling error:', err.message);
        }
      });

      connections.set(key, socket);
      socketToKey.set(socket, key);
    } catch (err: any) {
      console.error('[Sigma] WebSocket creation failed:', key, err.message);
    }
  }
}

export function disconnect(): void {
  manualDisconnect = true;
  disconnectInternal(false);
}

function disconnectInternal(silent: boolean): void {
  // Clear reconnect timers
  for (const timer of reconnectTimers.values()) {
    clearTimeout(timer);
  }
  reconnectTimers.clear();

  for (const [, socket] of connections) {
    socket.close(4000, 'User disconnect');
  }
  connections.clear();
  setState({ connected: false, connecting: false });
}

function send(socket: WebSocket, msg: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

async function handleMessage(msg: any, socket: WebSocket): Promise<void> {
  switch (msg.type) {
    case 'command': {
      const { id, tool, params } = msg.payload;
      // Verify command signature — reject unsigned or forged commands
      const key = socketToKey.get(socket);
      if (!key || !msg.sig) {
        console.error('[Sigma] Command rejected — missing signature');
        send(socket, { type: 'response', payload: { id, error: 'Missing command signature' } });
        break;
      }
      const expected = createHmac('sha256', key).update(id + tool).digest('hex');
      if (msg.sig !== expected) {
        console.error('[Sigma] Command rejected — invalid signature');
        send(socket, { type: 'response', payload: { id, error: 'Invalid command signature' } });
        break;
      }
      try {
        const result = executor ? await executor(tool, params) : { error: 'No executor' };
        send(socket, { type: 'response', payload: { id, result } });
      } catch (err: any) {
        send(socket, { type: 'response', payload: { id, error: err.message || String(err) } });
      }
      break;
    }
    case 'ping':
      send(socket, { type: 'pong' });
      break;
  }
}
