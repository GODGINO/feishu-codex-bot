/**
 * iLink Bot API client — stateless HTTP wrapper for WeChat iLink Bot endpoints.
 * Ref: https://ilinkai.weixin.qq.com
 */

import type { Logger } from '../utils/logger.js';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const POLL_TIMEOUT_MS = 40_000; // slightly longer than server's 35s long-poll

// --- Response types ---

export interface QrCodeResponse {
  ret: number;
  errcode?: number;
  qrcode_url?: string;
  qrcode_img_content?: string;
  qrcode?: string;
}

export interface QrCodeStatusResponse {
  ret?: number;
  errcode?: number;
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
}

export interface WechatMessage {
  from_user_id: string;
  msg_type: number; // 1=text, 2=image, 3=voice, 4=file, 5=video
  context_token: string;
  item_list: Array<{
    type: number;
    text_item?: { text: string };
    image_item?: { encrypt_query_param: string };
    file_item?: { encrypt_query_param: string; file_name?: string };
  }>;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  msgs?: WechatMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageResponse {
  ret?: number;
  errcode?: number;
}

export interface GetConfigResponse {
  ret?: number;
  errcode?: number;
  typing_ticket?: string;
}

export interface GetUploadUrlResponse {
  ret?: number;
  errcode?: number;
  upload_full_url?: string;
  upload_param?: string;
}

// --- Helpers ---

/** Normalize iLink API response: 'ret' → 'errcode', 'qrcode_img_content' → 'qrcode_url' */
function normalize<T>(data: T): T {
  const d = data as any;
  if (d.ret !== undefined && d.errcode === undefined) d.errcode = d.ret;
  if (d.qrcode_img_content && !d.qrcode_url) d.qrcode_url = d.qrcode_img_content;
  // If no errcode/ret, check if response has meaningful content
  // getUpdates returns {msgs:[], get_updates_buf:...} on success (no errcode)
  // sendMessage returns {} on success (empty) — keep errcode undefined to distinguish
  if (d.errcode === undefined && d.ret === undefined) {
    // Only set errcode=0 for responses with actual data fields (getUpdates, getConfig, etc.)
    if (d.msgs !== undefined || d.get_updates_buf !== undefined || d.qrcode !== undefined || d.typing_ticket !== undefined) {
      d.errcode = 0;
    }
  }
  return data;
}

// --- Client ---

export class ILinkClient {
  constructor(private logger: Logger) {}

  /** Build common headers for authenticated requests. */
  private authHeaders(botToken: string): Record<string, string> {
    const uin = Buffer.from(String(Math.floor(Math.random() * 0xFFFFFFFF))).toString('base64');
    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization': `Bearer ${botToken}`,
      'X-WECHAT-UIN': uin,
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '131334', // 2.1.6 encoded as uint32
    };
  }

  /** GET /ilink/bot/get_bot_qrcode — get login QR code (no auth needed). */
  async getQrCode(baseUrl = DEFAULT_BASE_URL): Promise<QrCodeResponse> {
    const url = `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const data = normalize(await resp.json() as QrCodeResponse);
    this.logger.debug({ errcode: data.errcode, hasQr: !!data.qrcode }, 'iLink getQrCode');
    return data;
  }

  /** GET /ilink/bot/get_qrcode_status — long-poll for scan status. */
  async pollQrCodeStatus(qrcode: string, baseUrl = DEFAULT_BASE_URL): Promise<QrCodeStatusResponse> {
    const url = `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    const data = normalize(await resp.json() as QrCodeStatusResponse);
    this.logger.debug({ status: data.status, errcode: data.errcode }, 'iLink pollQrCodeStatus');
    return data;
  }

  /** POST /ilink/bot/getupdates — long-poll for incoming messages. */
  async getUpdates(botToken: string, cursor: string, baseUrl = DEFAULT_BASE_URL): Promise<GetUpdatesResponse> {
    const url = `${baseUrl}/ilink/bot/getupdates`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: this.authHeaders(botToken),
      body: JSON.stringify({ get_updates_buf: cursor }),
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    const data = normalize(await resp.json() as GetUpdatesResponse);
    this.logger.debug({ errcode: data.errcode, msgCount: data.msgs?.length ?? 0 }, 'iLink getUpdates');
    return data;
  }

  /** POST /ilink/bot/sendmessage — send a text message. */
  async sendMessage(
    botToken: string,
    toUserId: string,
    contextToken: string,
    text: string,
    baseUrl = DEFAULT_BASE_URL,
  ): Promise<SendMessageResponse> {
    const url = `${baseUrl}/ilink/bot/sendmessage`;
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: `sigma-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        message_type: 2,  // BOT
        message_state: 2, // FINISH
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: { channel_version: '2.1.6' },
    };
    const bodyStr = JSON.stringify(body);
    const headers = {
      ...this.authHeaders(botToken),
      'Content-Length': String(Buffer.byteLength(bodyStr)),
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await resp.json();
    const data = normalize(raw as SendMessageResponse);
    this.logger.info({ rawResponse: JSON.stringify(raw), toUserId }, 'iLink sendMessage response');
    return data;
  }

  /** POST /ilink/bot/getconfig — get typing ticket. */
  async getConfig(botToken: string, ilinkUserId: string, contextToken?: string, baseUrl = DEFAULT_BASE_URL): Promise<GetConfigResponse> {
    const url = `${baseUrl}/ilink/bot/getconfig`;
    const body = {
      ilink_user_id: ilinkUserId,
      context_token: contextToken || '',
      base_info: { channel_version: '2.1.6' },
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers: this.authHeaders(botToken),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = normalize(await resp.json() as GetConfigResponse);
    this.logger.info({ ret: (data as any).ret, errcode: data.errcode, hasTicket: !!data.typing_ticket }, 'iLink getConfig');
    return data;
  }

  /** POST /ilink/bot/sendtyping — send/cancel typing indicator. */
  async sendTyping(
    botToken: string,
    ilinkUserId: string,
    typingTicket: string,
    status: 1 | 2, // 1=TYPING, 2=CANCEL
    baseUrl = DEFAULT_BASE_URL,
  ): Promise<void> {
    const url = `${baseUrl}/ilink/bot/sendtyping`;
    const body = {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status,
      base_info: { channel_version: '2.1.6' },
    };
    try {
      await fetch(url, {
        method: 'POST',
        headers: this.authHeaders(botToken),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // typing is best-effort
    }
  }

  /** POST /ilink/bot/getuploadurl — get CDN upload pre-signed URL. */
  async getUploadUrl(
    botToken: string,
    opts: {
      filekey: string;
      mediaType: number; // 1=IMAGE, 2=VIDEO, 3=FILE
      toUserId: string;
      rawsize: number;
      rawfilemd5: string;
      filesize: number; // ciphertext size
      aeskey: string;   // hex-encoded 16-byte key
    },
    baseUrl = DEFAULT_BASE_URL,
  ): Promise<GetUploadUrlResponse> {
    const url = `${baseUrl}/ilink/bot/getuploadurl`;
    const body = {
      filekey: opts.filekey,
      media_type: opts.mediaType,
      to_user_id: opts.toUserId,
      rawsize: opts.rawsize,
      rawfilemd5: opts.rawfilemd5,
      filesize: opts.filesize,
      no_need_thumb: true,
      aeskey: opts.aeskey,
      base_info: { channel_version: '2.1.6' },
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers: this.authHeaders(botToken),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return normalize(await resp.json() as GetUploadUrlResponse);
  }

  /**
   * Send a media message (image/video/file).
   * For text messages, use sendMessage() instead.
   */
  async sendMediaMessage(
    botToken: string,
    toUserId: string,
    contextToken: string,
    item: object,
    baseUrl = DEFAULT_BASE_URL,
  ): Promise<SendMessageResponse> {
    const url = `${baseUrl}/ilink/bot/sendmessage`;
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: `sigma-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [item],
      },
      base_info: { channel_version: '2.1.6' },
    };
    const bodyStr = JSON.stringify(body);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { ...this.authHeaders(botToken), 'Content-Length': String(Buffer.byteLength(bodyStr)) },
      body: bodyStr,
      signal: AbortSignal.timeout(15_000),
    });
    return normalize(await resp.json() as SendMessageResponse);
  }
}
