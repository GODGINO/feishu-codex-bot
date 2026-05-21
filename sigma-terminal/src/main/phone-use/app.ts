/**
 * ADB application management: install, list, launch.
 */

import { adbExec } from './adb-runner';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export async function adbInstall(apkPath: string, serial?: string): Promise<{ installed: string }> {
  // Validate: must be .apk file within home directory
  const resolved = path.resolve(apkPath);
  if (!resolved.startsWith(os.homedir())) {
    throw new Error('APK path must be within home directory');
  }
  if (!resolved.endsWith('.apk')) {
    throw new Error('Only .apk files can be installed');
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`APK not found: ${resolved}`);
  }
  const r = await adbExec(['install', '-r', resolved], serial, 120_000);
  if (r.code !== 0) throw new Error(r.stderr || `install failed`);
  if (!r.stdout.includes('Success')) {
    throw new Error(`install reported failure: ${r.stdout}`);
  }
  return { installed: apkPath };
}

export async function adbAppList(serial?: string, includeSystem = false): Promise<{ packages: string[] }> {
  const args = ['shell', 'pm', 'list', 'packages'];
  if (!includeSystem) args.push('-3'); // third-party only

  const r = await adbExec(args, serial);
  if (r.code !== 0) throw new Error(r.stderr || `list failed`);

  const packages = r.stdout
    .split('\n')
    .map((line) => line.replace(/^package:/, '').trim())
    .filter(Boolean);

  return { packages };
}

export async function adbAppLaunch(
  packageName: string,
  activity?: string,
  serial?: string,
): Promise<{ launched: string }> {
  let r;
  if (activity) {
    r = await adbExec(['shell', 'am', 'start', '-n', `${packageName}/${activity}`], serial);
  } else {
    // Use monkey to launch by package name (auto-detects launcher activity)
    r = await adbExec(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], serial);
  }
  if (r.code !== 0) throw new Error(r.stderr || `launch failed`);
  return { launched: packageName };
}

export async function adbAppForceStop(packageName: string, serial?: string): Promise<{ stopped: string }> {
  const r = await adbExec(['shell', 'am', 'force-stop', packageName], serial);
  if (r.code !== 0) throw new Error(r.stderr || `force-stop failed`);
  return { stopped: packageName };
}
