/**
 * WeChat media handler — AES-128-ECB encryption/decryption + CDN upload/download.
 * Handles image, file, video receiving and sending via iLink Bot API.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ILinkClient } from './ilink-client.js';
import type { Logger } from '../utils/logger.js';

const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024; // 100 MB

// --- AES-128-ECB ---

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** PKCS7 padded ciphertext size for AES-128-ECB. */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * Parse AES key from iLink message formats.
 * Two formats exist:
 * - base64(raw 16 bytes) — typical for images
 * - base64(hex string of 32 chars) — typical for file/voice/video
 */
export function parseAesKey(aesKeyStr: string): Buffer {
  const decoded = Buffer.from(aesKeyStr, 'base64');
  if (decoded.length === 16) {
    return decoded; // raw 16 bytes
  }
  if (decoded.length === 32) {
    // 32 ASCII hex chars → parse as hex to get 16 bytes
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  // Fallback: try hex directly
  if (aesKeyStr.length === 32 && /^[0-9a-f]+$/i.test(aesKeyStr)) {
    return Buffer.from(aesKeyStr, 'hex');
  }
  throw new Error(`Cannot parse AES key: length=${aesKeyStr.length}`);
}

// --- CDN Download ---

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

/**
 * Download and decrypt a media file from WeChat CDN.
 */
export async function downloadAndDecrypt(
  media: CDNMedia,
  aesKeyOverride?: string, // hex key from image_item.aeskey
  logger?: Logger,
): Promise<Buffer | null> {
  // Build download URL
  let url = media.full_url;
  if (!url && media.encrypt_query_param) {
    url = `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
  }
  if (!url) {
    logger?.warn('No download URL for media');
    return null;
  }

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!resp.ok) {
      logger?.warn({ status: resp.status, url: url.slice(0, 80) }, 'CDN download failed');
      return null;
    }

    const data = Buffer.from(await resp.arrayBuffer());
    if (data.length > MAX_DOWNLOAD_SIZE) {
      logger?.warn({ size: data.length }, 'Media too large to download');
      return null;
    }

    // Determine AES key
    const keyStr = aesKeyOverride
      ? (aesKeyOverride.length === 32 && /^[0-9a-f]+$/i.test(aesKeyOverride)
        ? Buffer.from(aesKeyOverride, 'hex').toString('base64') // hex → base64 for parseAesKey
        : aesKeyOverride)
      : media.aes_key;

    if (!keyStr) {
      // No encryption — return raw data
      return data;
    }

    const key = parseAesKey(keyStr);
    return decryptAesEcb(data, key);
  } catch (err) {
    logger?.warn({ err }, 'Failed to download/decrypt media');
    return null;
  }
}

// --- CDN Upload ---

export interface UploadResult {
  downloadEncryptedQueryParam: string; // from CDN x-encrypted-param header
  aeskey: string;          // hex-encoded 16-byte key
  fileSize: number;        // plaintext bytes
  fileSizeCiphertext: number; // ciphertext bytes
  filekey: string;         // random hex identifier
}

/**
 * Encrypt and upload a file to WeChat CDN.
 */
export async function encryptAndUpload(
  filePath: string,
  client: ILinkClient,
  botToken: string,
  toUserId: string,
  mediaType: number, // 1=IMAGE, 2=VIDEO, 3=FILE
  baseUrl: string,
  logger?: Logger,
): Promise<UploadResult | null> {
  try {
    const plaintext = fs.readFileSync(filePath);
    const rawsize = plaintext.length;
    const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = crypto.randomBytes(16).toString('hex');
    const aeskey = crypto.randomBytes(16);
    const aeskeyHex = aeskey.toString('hex');

    // 1. Get upload URL
    const uploadResp = await client.getUploadUrl(botToken, {
      filekey,
      mediaType,
      toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      aeskey: aeskeyHex,
    }, baseUrl);

    const uploadUrl = uploadResp.upload_full_url;
    if (!uploadUrl) {
      logger?.warn({ uploadResp }, 'No upload URL returned');
      return null;
    }

    // 2. Encrypt
    const ciphertext = encryptAesEcb(plaintext, aeskey);

    // 3. Upload to CDN
    const cdnResp = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(ciphertext),
      signal: AbortSignal.timeout(60_000),
    });

    if (!cdnResp.ok) {
      logger?.warn({ status: cdnResp.status }, 'CDN upload failed');
      return null;
    }

    const downloadParam = cdnResp.headers.get('x-encrypted-param');
    if (!downloadParam) {
      logger?.warn('CDN response missing x-encrypted-param header');
      return null;
    }

    return {
      downloadEncryptedQueryParam: downloadParam,
      aeskey: aeskeyHex,
      fileSize: rawsize,
      fileSizeCiphertext: ciphertext.length,
      filekey,
    };
  } catch (err) {
    logger?.warn({ err, filePath }, 'Failed to encrypt/upload media');
    return null;
  }
}

// --- Build sendMessage items ---

/** Build image_item for sendMessage. */
export function buildImageItem(uploaded: UploadResult): object {
  return {
    type: 2,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };
}

/** Build file_item for sendMessage. */
export function buildFileItem(uploaded: UploadResult, fileName: string, plaintextSize: number): object {
  return {
    type: 4,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(plaintextSize),
    },
  };
}

/** Build video_item for sendMessage. */
export function buildVideoItem(uploaded: UploadResult): object {
  return {
    type: 5,
    video_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
        encrypt_type: 1,
      },
      video_size: uploaded.fileSizeCiphertext,
    },
  };
}

/** Determine media type from file extension. */
export function getMediaType(filePath: string): { mediaType: number; itemBuilder: (u: UploadResult) => object } {
  const ext = path.extname(filePath).toLowerCase();
  const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg']);
  const videoExts = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);

  if (imageExts.has(ext)) {
    return { mediaType: 1, itemBuilder: buildImageItem };
  }
  if (videoExts.has(ext)) {
    return { mediaType: 2, itemBuilder: buildVideoItem };
  }
  // Everything else is a file
  return {
    mediaType: 3,
    itemBuilder: (u) => buildFileItem(u, path.basename(filePath), u.fileSize),
  };
}
