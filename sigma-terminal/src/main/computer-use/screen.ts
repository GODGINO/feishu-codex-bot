/**
 * Screen capture — cross-platform using macOS screencapture / Electron desktopCapturer.
 * Display info uses Electron's screen API (cross-platform).
 */

import { spawn } from 'child_process';
import { screen as electronScreen, desktopCapturer } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const IS_MAC = process.platform === 'darwin';

export interface ScreenshotParams {
  region?: { x: number; y: number; w: number; h: number };
  display?: number; // 1-based display index
}

export interface ScreenshotResult {
  image: string; // data:image/png;base64,...
  width: number;
  height: number;
}

export async function screenshot(params: ScreenshotParams = {}): Promise<ScreenshotResult> {
  if (IS_MAC) {
    return screenshotMac(params);
  }
  return screenshotCrossPlat(params);
}

// macOS: native screencapture (higher quality, faster)
async function screenshotMac(params: ScreenshotParams): Promise<ScreenshotResult> {
  const tmpFile = path.join(os.tmpdir(), `sigma-screen-${Date.now()}.png`);
  const args = ['-x', '-t', 'png'];

  if (params.region) {
    const { x, y, w, h } = params.region;
    args.push('-R', `${x},${y},${w},${h}`);
  }

  if (params.display && params.display > 1) {
    args.push('-D', String(params.display));
  } else {
    args.push('-m');
  }

  args.push(tmpFile);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('screencapture', args);
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`screencapture exited ${code}`)));
    proc.on('error', reject);
  });

  const buf = fs.readFileSync(tmpFile);
  fs.unlinkSync(tmpFile);

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);

  return {
    image: `data:image/png;base64,${buf.toString('base64')}`,
    width,
    height,
  };
}

// Windows/Linux: Electron desktopCapturer
async function screenshotCrossPlat(params: ScreenshotParams): Promise<ScreenshotResult> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 3840, height: 2160 }, // request max resolution
  });

  // Select display
  const displayIdx = (params.display || 1) - 1;
  const source = sources[displayIdx] || sources[0];
  if (!source) throw new Error('No screen source available');

  const thumbnail = source.thumbnail;
  let buf: Buffer;

  if (params.region) {
    const { x, y, w, h } = params.region;
    const cropped = thumbnail.crop({ x, y, width: w, height: h });
    buf = cropped.toPNG();
  } else {
    buf = thumbnail.toPNG();
  }

  const size = thumbnail.getSize();

  return {
    image: `data:image/png;base64,${buf.toString('base64')}`,
    width: params.region ? params.region.w : size.width,
    height: params.region ? params.region.h : size.height,
  };
}

export interface DisplayInfo {
  displays: Array<{ index: number; width: number; height: number; main: boolean }>;
}

export function getDisplayInfo(): DisplayInfo {
  const primary = electronScreen.getPrimaryDisplay();
  const all = electronScreen.getAllDisplays();
  return {
    displays: all.map((d, i) => ({
      index: i + 1,
      width: d.size.width,
      height: d.size.height,
      main: d.id === primary.id,
    })),
  };
}
