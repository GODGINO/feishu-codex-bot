import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Logger } from '../utils/logger.js';

/**
 * Upload a local-file or https URL to Feishu and return image_key.
 *
 * - https URL: downloads via fetch to a temp file (~/.tmp), uploads, deletes temp file.
 * - Local absolute path: uploads directly.
 * - Returns null on any failure (caller falls back to placeholder text).
 *
 * Per-call only — caching is the caller's job (a streamer keeps a Map<url, key>).
 */
export async function uploadImageToFeishu(
  client: any,
  source: string,
  logger: Logger,
): Promise<string | null> {
  let tempPath: string | null = null;
  let uploadPath: string;

  try {
    if (/^https?:\/\//i.test(source)) {
      const resp = await fetch(source);
      if (!resp.ok) {
        logger.warn({ source, status: resp.status }, 'Image download failed');
        return null;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      const hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 12);
      tempPath = path.join(os.tmpdir(), `sigma-img-${hash}-${Date.now()}.bin`);
      fs.writeFileSync(tempPath, buf);
      uploadPath = tempPath;
    } else {
      if (!fs.existsSync(source)) {
        logger.warn({ source }, 'Local image not found');
        return null;
      }
      uploadPath = source;
    }

    const imageStream = fs.createReadStream(uploadPath);
    const uploadResp = await client.im.image.create({
      data: {
        image_type: 'message',
        image: imageStream,
      },
    });
    const imageKey = uploadResp?.image_key || uploadResp?.data?.image_key;
    if (!imageKey) {
      logger.warn({ source }, 'Upload returned no image_key');
      return null;
    }
    return imageKey;
  } catch (err) {
    logger.warn({ err, source }, 'Image upload failed');
    return null;
  } finally {
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
  }
}
