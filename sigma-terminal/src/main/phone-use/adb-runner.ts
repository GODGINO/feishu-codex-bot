/**
 * Generic ADB command runner with text and binary modes.
 *
 * The binary mode is critical for `screencap -p` because `adb shell` translates
 * \n → \r\n on stdout (legacy behavior), which corrupts PNG bytes. Use
 * `adb exec-out` instead, which keeps the stream raw.
 */

import { spawn } from 'child_process';

const ADB_TIMEOUT = 30_000;

export interface AdbResult {
  stdout: string;
  stderr: string;
  code: number;
}

function buildArgs(serial: string | undefined, args: string[]): string[] {
  return serial ? ['-s', serial, ...args] : args;
}

/**
 * Run an adb command and return text output.
 * Use this for input commands, list commands, etc.
 */
export function adbExec(args: string[], serial?: string, timeout = ADB_TIMEOUT): Promise<AdbResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('adb', buildArgs(serial, args), { timeout });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    proc.on('error', (err: any) => {
      if (err.code === 'ENOENT') {
        reject(new Error('adb not found. Install with: brew install android-platform-tools'));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Run an adb command and return raw binary output.
 * Use this for screencap, file pull, etc.
 *
 * Always uses `exec-out` (not `shell`) to avoid line-ending translation.
 */
export function adbExecBinary(args: string[], serial?: string, timeout = ADB_TIMEOUT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn('adb', buildArgs(serial, args), { timeout });
    const chunks: Buffer[] = [];
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { chunks.push(d); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`adb exited ${code}: ${stderr.trim()}`));
      }
    });

    proc.on('error', (err: any) => {
      if (err.code === 'ENOENT') {
        reject(new Error('adb not found. Install with: brew install android-platform-tools'));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Check if adb is installed and reachable.
 */
export async function adbAvailable(): Promise<{ installed: boolean; version: string | null }> {
  try {
    const r = await adbExec(['version']);
    if (r.code === 0) {
      const m = r.stdout.match(/Android Debug Bridge version (\S+)/);
      return { installed: true, version: m ? m[1] : 'unknown' };
    }
  } catch {
    // ignore
  }
  return { installed: false, version: null };
}
