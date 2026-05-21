/**
 * Feishu OAuth Device Flow (RFC 8628) + Token management.
 * Tokens stored as JSON files in sessions/{key}/feishu-tokens/{ou_xxx}.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const DEVICE_AUTH_URL = 'https://accounts.feishu.cn/oauth/v1/device_authorization';
const TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const REFRESH_AHEAD_MS = 5 * 60 * 1000; // Refresh 5 min before expiry

export interface FeishuTokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  scope: string;
  userOpenId: string;
}

export interface DeviceFlowResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/**
 * Step 1: Request device code from Feishu.
 */
export async function startDeviceFlow(
  appId: string,
  appSecret: string,
  scopes: string[],
): Promise<DeviceFlowResult> {
  const scopeStr = [...scopes, 'offline_access'].join(' ');
  const auth = Buffer.from(`${appId}:${appSecret}`).toString('base64');

  const resp = await fetch(DEVICE_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${auth}`,
    },
    body: `client_id=${encodeURIComponent(appId)}&scope=${encodeURIComponent(scopeStr)}`,
  });

  const data = await resp.json() as any;
  if (data.error) {
    throw new Error(`Device flow error: ${data.error} - ${data.error_description || ''}`);
  }

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in || 240,
    interval: data.interval || 5,
  };
}

/**
 * Step 2: Poll for token after user authorizes.
 * Returns token data on success, null if still pending, throws on permanent error.
 */
export async function pollDeviceToken(
  appId: string,
  appSecret: string,
  deviceCode: string,
): Promise<{ status: 'pending' | 'success' | 'expired'; token?: FeishuTokenData }> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
    client_id: appId,
    client_secret: appSecret,
  });

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await resp.json() as any;

  if (data.error === 'authorization_pending' || data.error === 'slow_down') {
    return { status: 'pending' };
  }

  if (data.error === 'expired_token' || data.error === 'invalid_grant' || data.error === 'access_denied') {
    return { status: 'expired' };
  }

  if (data.error) {
    throw new Error(`Token poll error: ${data.error} - ${data.error_description || ''}`);
  }

  // Success
  const now = Date.now();
  return {
    status: 'success',
    token: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now + (data.expires_in || 7200) * 1000,
      refreshExpiresAt: now + (data.refresh_token_expires_in || 604800) * 1000,
      scope: data.scope || '',
      userOpenId: data.open_id || '',
    },
  };
}

/**
 * Refresh an expired access token using the refresh token.
 */
async function refreshToken(
  appId: string,
  appSecret: string,
  refreshTokenStr: string,
): Promise<FeishuTokenData> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshTokenStr,
    client_id: appId,
    client_secret: appSecret,
  });

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await resp.json() as any;
  if (data.error) {
    throw new Error(`Refresh error: ${data.error} - ${data.error_description || ''}`);
  }

  const now = Date.now();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now + (data.expires_in || 7200) * 1000,
    refreshExpiresAt: now + (data.refresh_token_expires_in || 604800) * 1000,
    scope: data.scope || '',
    userOpenId: data.open_id || '',
  };
}

function getTokenPath(tokenDir: string, userOpenId: string): string {
  return path.join(tokenDir, `${userOpenId}.json`);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Save token data to disk.
 */
export function saveToken(tokenDir: string, data: FeishuTokenData): void {
  ensureDir(tokenDir);
  fs.writeFileSync(getTokenPath(tokenDir, data.userOpenId), JSON.stringify(data, null, 2));
}

/**
 * Load token data from disk, returns null if not found.
 */
export function loadToken(tokenDir: string, userOpenId: string): FeishuTokenData | null {
  const p = getTokenPath(tokenDir, userOpenId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Get a valid access token for a user. Auto-refreshes if needed.
 * Returns null if no token or refresh has expired.
 */
export async function getValidToken(
  tokenDir: string,
  userOpenId: string,
  appId: string,
  appSecret: string,
): Promise<string | null> {
  const stored = loadToken(tokenDir, userOpenId);
  if (!stored) return null;

  const now = Date.now();

  // Access token still valid
  if (now < stored.expiresAt - REFRESH_AHEAD_MS) {
    return stored.accessToken;
  }

  // Refresh token expired
  if (now >= stored.refreshExpiresAt) {
    return null;
  }

  // Need to refresh
  try {
    const refreshed = await refreshToken(appId, appSecret, stored.refreshToken);
    refreshed.userOpenId = userOpenId; // Preserve original openId
    saveToken(tokenDir, refreshed);
    return refreshed.accessToken;
  } catch {
    return null;
  }
}

/**
 * Check auth status for a user.
 */
export function getAuthStatus(
  tokenDir: string,
  userOpenId: string,
): 'authorized' | 'expired' | 'none' {
  const stored = loadToken(tokenDir, userOpenId);
  if (!stored) return 'none';

  const now = Date.now();
  if (now >= stored.refreshExpiresAt) return 'expired';
  return 'authorized';
}
