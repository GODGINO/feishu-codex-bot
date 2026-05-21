import sharp from 'sharp';
import type { Logger } from '../utils/logger.js';

// Anthropic many-image cap is 2000px on any side; leave 100px headroom
// so border cases don't hit the limit.
const MAX_DIM = 1900;

/**
 * Resize an image buffer if any side exceeds MAX_DIM. Preserves aspect ratio
 * (fit:'inside'). Skips GIFs (multi-frame, can't resize cleanly here) and
 * silently falls back to the original buffer on any sharp error so a broken
 * resize never blocks the message pipeline.
 */
export async function resizeIfTooBig(
  buffer: Buffer,
  mediaType: string,
  logger: Logger,
): Promise<Buffer> {
  if (mediaType === 'image/gif') return buffer;
  try {
    const meta = await sharp(buffer).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w <= MAX_DIM && h <= MAX_DIM) return buffer;
    const out = await sharp(buffer)
      .resize({
        width: MAX_DIM,
        height: MAX_DIM,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toBuffer();
    logger.info(
      { origW: w, origH: h, newSizeKB: Math.round(out.length / 1024) },
      'Image resized for Claude API',
    );
    return out;
  } catch (err) {
    logger.warn({ err }, 'Failed to resize image, using original');
    return buffer;
  }
}
