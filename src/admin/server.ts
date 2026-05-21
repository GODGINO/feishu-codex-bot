import express from 'express';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type * as lark from '@larksuiteoapi/node-sdk';
import { createRoutes } from './routes.js';
import { RelayServer } from '../relay/relay-server.js';
import { AdminChatServer } from './admin-chat.js';
import type { RelayCommand } from '../relay/protocol.js';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import httpProxy from 'http-proxy';

export interface AdminServerResult {
  httpServer: http.Server;
  relayServer: RelayServer;
  adminChat: AdminChatServer;
}

/** Generate a signed auth token */
function signToken(password: string): string {
  const payload = Date.now().toString();
  const sig = createHmac('sha256', password).update(payload).digest('hex').slice(0, 16);
  return `${payload}.${sig}`;
}

/** Verify a signed auth token (timing-safe) */
function verifyToken(token: string, password: string): boolean {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  // Check token age — reject tokens older than 7 days
  const age = Date.now() - parseInt(payload);
  if (isNaN(age) || age > 7 * 24 * 60 * 60 * 1000 || age < 0) return false;
  const expected = createHmac('sha256', password).update(payload).digest('hex').slice(0, 16);
  try {
    return timingSafeEqual(Buffer.from(sig, 'utf-8'), Buffer.from(expected, 'utf-8'));
  } catch {
    return false;
  }
}

/** Parse cookie header and extract a value */
function getCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;)\\s*${name}=([^;]+)`));
  return match ? match[1] : null;
}

export function startAdminServer(
  sessionsDir: string,
  port: number,
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void },
  feishuClient?: lark.Client,
  adminPasswords?: string[],
  memberMgr?: any,
): AdminServerResult {
  const app = express();
  app.use(express.json());

  const authEnabled = !!adminPasswords && adminPasswords.length >= 2;
  // Dual-password: both must be correct simultaneously
  const masterSecret = adminPasswords?.join(':') || '';

  /** Check if both passwords match (dual-password mode) */
  function isValidDualPassword(pw1: string, pw2: string): boolean {
    if (!adminPasswords || adminPasswords.length < 2) return false;
    return pw1 === adminPasswords[0] && pw2 === adminPasswords[1];
  }

  /** Check if a token is valid */
  function isValidToken(token: string): boolean {
    if (!masterSecret) return false;
    return verifyToken(token, masterSecret);
  }

  // ── Rate limiting for login ──
  const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();
  const MAX_LOGIN_ATTEMPTS = 5;
  const LOCKOUT_DURATION = 5 * 60 * 1000; // 5 minutes

  // ── Auth endpoints (no middleware) ──

  app.post('/api/auth/login', (req, res) => {
    if (!authEnabled) {
      res.json({ ok: true });
      return;
    }
    const ip = req.ip || 'unknown';
    const attempts = loginAttempts.get(ip);
    if (attempts && attempts.lockedUntil > Date.now()) {
      const retryAfter = Math.ceil((attempts.lockedUntil - Date.now()) / 1000);
      logger.warn({ ip, retryAfter }, 'Login rate limited');
      res.status(429).json({ error: `Too many attempts. Retry after ${retryAfter}s` });
      return;
    }
    const { password, password2 } = req.body;
    if (!isValidDualPassword(password || '', password2 || '')) {
      const current = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
      current.count++;
      if (current.count >= MAX_LOGIN_ATTEMPTS) {
        current.lockedUntil = Date.now() + LOCKOUT_DURATION;
        current.count = 0;
      }
      loginAttempts.set(ip, current);
      logger.warn({ ip, failCount: current.count }, 'Failed admin login attempt');
      res.status(401).json({ error: 'Wrong password' });
      return;
    }
    loginAttempts.delete(ip);
    const token = signToken(masterSecret); // Sign with combined secret
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sigma_token=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=604800`);
    res.json({ ok: true });
  });

  app.get('/api/auth/check', (req, res) => {
    if (!authEnabled) {
      res.json({ authenticated: true });
      return;
    }
    const token = getCookie(req.headers.cookie, 'sigma_token');
    if (token && isValidToken(token)) {
      res.json({ authenticated: true });
    } else {
      res.status(401).json({ authenticated: false });
    }
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'sigma_token=; Path=/; HttpOnly; Max-Age=0');
    res.json({ ok: true });
  });

  // ── Auth middleware (protects /api/* except auth and relay) ──

  if (authEnabled) {
    app.use('/api', (req, res, next) => {
      // Skip auth for: login/check/logout, relay command (token-authed)
      if (req.path.startsWith('/auth/') || req.path === '/relay/command') {
        next();
        return;
      }
      const token = getCookie(req.headers.cookie, 'sigma_token');
      if (token && isValidToken(token)) {
        next();
      } else {
        res.status(401).json({ error: 'Unauthorized' });
      }
    });
  }

  // Attach memberMgr to requests
  if (memberMgr) {
    app.use((req, _res, next) => { (req as any).memberMgr = memberMgr; next(); });
  }

  // API routes
  app.use(createRoutes(sessionsDir, feishuClient));

  // Serve downloadable files (DMG, zip) — no auth required, strict whitelist
  const downloadsDir = path.resolve(process.cwd());
  app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    // Strict: only allow simple filenames with allowed extensions, no path separators
    if (!/^[a-zA-Z0-9._-]+\.(dmg|zip|exe)$/.test(filename) || filename.includes('..')) {
      res.status(403).send('Forbidden');
      return;
    }
    const filePath = path.resolve(downloadsDir, filename);
    // Ensure resolved path is still inside downloads dir (prevents traversal)
    if (!filePath.startsWith(downloadsDir + path.sep) && filePath !== path.join(downloadsDir, filename)) {
      res.status(403).send('Forbidden');
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).send('File not found');
      return;
    }
    res.download(filePath, filename);
  });

  // Relay command API — MCP server sends commands here
  const relayServer = new RelayServer(logger, sessionsDir);

  app.post('/api/relay/command', async (req, res) => {
    const { sessionKey, tool, params } = req.body;
    if (!sessionKey || !tool) {
      res.status(400).json({ error: 'Missing sessionKey or tool' });
      return;
    }
    const command: RelayCommand = {
      id: randomUUID(),
      tool,
      params: params || {},
    };
    const response = await relayServer.sendCommand(sessionKey, command);
    if (response.error) {
      res.status(502).json({ error: response.error });
    } else {
      res.json({ result: response.result });
    }
  });

  // Admin chat — send message to Claude session (auth-protected, fire-and-forget)
  app.post('/api/sessions/:key/chat/send', (req, res) => {
    const sessionKey = req.params.key.startsWith('group_') || req.params.key.startsWith('dm_')
      ? req.params.key : `group_${req.params.key}`;
    const { text, echo, showSource, sendAsSigma, addToContext } = req.body;
    if (!text) {
      res.status(400).json({ error: 'Missing text' });
      return;
    }
    if (sendAsSigma) {
      // Send directly as Sigma bot — no Claude processing
      if (adminChat.onSendAsSigma) {
        adminChat.onSendAsSigma(sessionKey, text, addToContext ?? true).catch((err: any) => {
          logger.error({ err, sessionKey }, 'Send as Sigma failed');
        });
        res.json({ ok: true });
      } else {
        res.status(503).json({ error: 'Send as Sigma not initialized' });
      }
    } else if (adminChat.onMessage) {
      adminChat.onMessage(sessionKey, text, echo ?? true, showSource ?? true).catch((err: any) => {
        logger.error({ err, sessionKey }, 'Admin chat send failed');
      });
      res.json({ ok: true });
    } else {
      res.status(503).json({ error: 'Admin chat not initialized' });
    }
  });

  // Status endpoint — require admin auth (no longer public)
  app.get('/api/relay/status', (_req, res) => {
    res.json({ connections: relayServer.getStatus() });
  });

  // ── Tunnel reverse proxy — /tunnel/:sessionKey/* → localhost:{port} ──
  const tunnelProxy = httpProxy.createProxyServer({ ws: true });
  tunnelProxy.on('error', (err, _req, res) => {
    if (res && 'writeHead' in res) {
      (res as http.ServerResponse).writeHead(502, { 'Content-Type': 'text/plain' });
      (res as http.ServerResponse).end('Tunnel target not reachable');
    }
  });

  const sessionKeyPattern = /^[a-zA-Z0-9_]+$/;

  function getTunnelTarget(sessionKey: string): string | null {
    if (!sessionKeyPattern.test(sessionKey)) return null;
    const portFile = path.join(sessionsDir, sessionKey, '.tunnel-port');
    try {
      const port = parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10);
      if (port > 0 && port < 65536) return `http://127.0.0.1:${port}`;
    } catch { /* no tunnel port registered */ }
    return null;
  }

  // Match /tunnel/:sessionKey — public access (session must exist + have active tunnel).
  // Security: sessionKey is unguessable (32-char hex) and not enumerable from any public endpoint.
  // The tunnel only proxies to a port the session's bot explicitly started, not arbitrary localhost services.
  app.use('/tunnel/:sessionKey', (req, res) => {
    const target = getTunnelTarget(req.params.sessionKey);
    if (!target) {
      res.status(404).send('Tunnel not active for this session');
      return;
    }
    tunnelProxy.web(req, res, { target, changeOrigin: true });
  });

  // Global error handler — suppress stack traces in production
  app.use((err: any, _req: any, res: any, _next: any) => {
    logger.error({ err: err.message || err }, 'Unhandled API error');
    res.status(500).json({ error: 'Internal server error' });
  });

  // Serve frontend static files (production)
  const webDist = path.join(process.cwd(), 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    // SPA fallback — serve index.html for all non-API routes
    app.use((_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);

  relayServer.attach(httpServer);

  const adminChat = new AdminChatServer(logger);
  adminChat.attach(httpServer);

  // Centralized WebSocket upgrade routing (all WSS use noServer mode)
  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '', 'http://localhost').pathname;

    // Helper: verify admin cookie from WebSocket upgrade request
    const isAdminAuthed = (): boolean => {
      if (!authEnabled) return true;
      const cookie = getCookie(req.headers.cookie, 'sigma_token');
      return !!cookie && isValidToken(cookie);
    };

    // Tunnel proxy — public access (same security as HTTP: sessionKey is unguessable)
    const tunnelMatch = pathname.match(/^\/tunnel\/([^/]+)(\/.*)?$/);
    if (tunnelMatch) {
      const target = getTunnelTarget(tunnelMatch[1]);
      if (target) {
        req.url = tunnelMatch[2] || '/';
        tunnelProxy.ws(req, socket, head, { target, changeOrigin: true });
        return;
      }
    }

    // Relay server (browser extension / terminal app) — token-based auth in RelayServer
    if (pathname === '/relay') {
      relayServer.handleUpgrade(req, socket, head);
      return;
    }

    // Admin chat — requires admin auth cookie
    if (pathname === '/admin-chat') {
      if (!isAdminAuthed()) {
        logger.warn('Admin chat WebSocket rejected: no valid auth cookie');
        socket.destroy();
        return;
      }
      adminChat.handleUpgrade(req, socket, head);
      return;
    }

    // Unknown path — destroy
    socket.destroy();
  });

  httpServer.listen(port, '127.0.0.1', () => {
    logger.info(`Admin dashboard running at http://127.0.0.1:${port} (localhost only, use CF tunnel for external access)`);
  });

  return { httpServer, relayServer, adminChat };
}
