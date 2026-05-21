/**
 * Admin Chat WebSocket server.
 *
 * Provides a third messaging channel (alongside Feishu and WeChat) for admin
 * users to chat with Claude sessions directly from the admin dashboard.
 *
 * Protocol:
 *   Client → Server: { type: 'message', text: string, echo: boolean }
 *   Server → Client: { type: 'stream', text: string }
 *                     { type: 'reply', text: string, done: true }
 *                     { type: 'echo', source: string, text: string, reply: string }
 *                     { type: 'error', message: string }
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';

type MessageHandler = (sessionKey: string, text: string, echo: boolean, showSource: boolean) => Promise<void>;

export class AdminChatServer {
  private wss!: WebSocketServer;
  private connections = new Map<string, Set<WebSocket>>(); // sessionKey → active WS clients
  private logger: { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

  /** Set by MessageBridge.setAdminChat() to route messages into Claude */
  onMessage: MessageHandler | null = null;

  /** Set by MessageBridge.setAdminChat() to send messages directly as Sigma bot */
  onSendAsSigma: ((sessionKey: string, text: string, addToContext: boolean) => Promise<void>) | null = null;

  constructor(logger: { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void }) {
    this.logger = logger;
  }

  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '', 'http://localhost');
      const sessionKey = url.searchParams.get('session');

      if (!sessionKey) {
        ws.close(4001, 'Missing session parameter');
        return;
      }

      // Track connection
      let conns = this.connections.get(sessionKey);
      if (!conns) {
        conns = new Set();
        this.connections.set(sessionKey, conns);
      }
      conns.add(ws);
      this.logger.info({ sessionKey }, 'Admin chat connected');

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'message' && msg.text && this.onMessage) {
            await this.onMessage(sessionKey, msg.text, msg.echo ?? true, msg.showSource ?? true);
          }
        } catch (err: any) {
          this.send(ws, { type: 'error', message: err.message || 'Failed to process message' });
        }
      });

      ws.on('close', () => {
        conns?.delete(ws);
        if (conns?.size === 0) this.connections.delete(sessionKey);
        this.logger.info({ sessionKey }, 'Admin chat disconnected');
      });

      ws.on('error', (err) => {
        this.logger.warn({ sessionKey, err }, 'Admin chat WebSocket error');
      });
    });

    this.logger.info('Admin chat WebSocket server attached at /admin-chat');
  }

  /** Handle a WebSocket upgrade request */
  handleUpgrade(req: any, socket: any, head: any): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  /** Check if any admin client is connected for a session */
  isConnected(sessionKey: string): boolean {
    const conns = this.connections.get(sessionKey);
    if (!conns) return false;
    // Clean up dead connections
    for (const ws of conns) {
      if (ws.readyState !== WebSocket.OPEN) conns.delete(ws);
    }
    return conns.size > 0;
  }

  /** Send a streaming text chunk to all admin clients for a session */
  streamToAdmin(sessionKey: string, text: string): void {
    this.broadcast(sessionKey, { type: 'stream', text });
  }

  /** Send the final complete reply to all admin clients */
  sendToAdmin(sessionKey: string, text: string): void {
    this.broadcast(sessionKey, { type: 'reply', text, done: true });
  }

  /** Send an echo of a message from another channel */
  sendEcho(sessionKey: string, source: string, originalText: string, reply: string): void {
    this.broadcast(sessionKey, { type: 'echo', source, text: originalText, reply });
  }

  /** Send error to all admin clients for a session */
  sendError(sessionKey: string, message: string): void {
    this.broadcast(sessionKey, { type: 'error', message });
  }

  private broadcast(sessionKey: string, msg: unknown): void {
    const conns = this.connections.get(sessionKey);
    if (!conns) return;
    const payload = JSON.stringify(msg);
    for (const ws of conns) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  destroy(): void {
    for (const conns of this.connections.values()) {
      for (const ws of conns) ws.close(1001, 'Server shutting down');
    }
    this.connections.clear();
    this.wss?.close();
  }
}
