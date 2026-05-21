/**
 * ADB screen capture and recording.
 *
 * KEY: We use `adb exec-out screencap -p` (NOT `adb shell screencap -p`)
 * because `adb shell` translates \n → \r\n on stdout, which corrupts the
 * raw PNG bytes. exec-out is the correct way to capture binary output.
 */

import { adbExec, adbExecBinary } from './adb-runner';

export async function adbScreenshot(serial?: string): Promise<{
  image: string;
  width: number;
  height: number;
  serial: string | null;
}> {
  const png = await adbExecBinary(['exec-out', 'screencap', '-p'], serial);

  if (png.length < 24) {
    throw new Error('Screenshot too small — device may not be unlocked');
  }
  if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
    throw new Error('Invalid PNG header — adb may have corrupted the stream');
  }

  // PNG IHDR: signature(8) + length(4) + 'IHDR'(4) + width(4) + height(4)
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);

  return {
    image: `data:image/png;base64,${png.toString('base64')}`,
    width,
    height,
    serial: serial || null,
  };
}

export async function adbScreenSize(serial?: string): Promise<{ width: number; height: number }> {
  const r = await adbExec(['shell', 'wm', 'size'], serial);
  const m = r.stdout.match(/(\d+)x(\d+)/);
  if (!m) throw new Error(`Could not parse screen size: ${r.stdout}`);
  return { width: parseInt(m[1]), height: parseInt(m[2]) };
}

export async function adbRecordScreen(
  serial: string | undefined,
  duration: number = 10,
  outputPath?: string,
): Promise<{ saved: string; duration: number }> {
  // Cap to reasonable max
  const dur = Math.min(Math.max(1, duration), 180);
  const devicePath = `/sdcard/sigma-rec-${Date.now()}.mp4`;
  const localPath = outputPath || `/tmp/sigma-rec-${Date.now()}.mp4`;

  // Record on device
  await adbExec(['shell', 'screenrecord', '--time-limit', String(dur), devicePath], serial, (dur + 5) * 1000);

  // Pull to local
  await adbExec(['pull', devicePath, localPath], serial);

  // Cleanup on device
  await adbExec(['shell', 'rm', devicePath], serial);

  return { saved: localPath, duration: dur };
}
