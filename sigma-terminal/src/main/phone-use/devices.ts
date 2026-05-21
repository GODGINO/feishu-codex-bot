/**
 * ADB device discovery and info.
 */

import { adbExec } from './adb-runner';

export interface AdbDevice {
  serial: string;
  state: 'device' | 'offline' | 'unauthorized' | 'unknown';
  model?: string;
  product?: string;
  transport?: string;
}

export async function adbDevices(): Promise<{ devices: AdbDevice[] }> {
  const r = await adbExec(['devices', '-l']);
  if (r.code !== 0) {
    throw new Error(r.stderr || 'adb devices failed');
  }

  const lines = r.stdout.split('\n').slice(1); // skip "List of devices attached"
  const devices: AdbDevice[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;

    const serial = parts[0];
    const state = parts[1] as AdbDevice['state'];
    const dev: AdbDevice = { serial, state };

    // Parse extra fields like "model:SM_G991U product:hero device:hero1q transport_id:1"
    for (let i = 2; i < parts.length; i++) {
      const [k, v] = parts[i].split(':');
      if (k === 'model') dev.model = v;
      else if (k === 'product') dev.product = v;
      else if (k === 'transport_id') dev.transport = v;
    }

    devices.push(dev);
  }

  return { devices };
}

export async function adbDeviceInfo(serial?: string): Promise<{
  serial: string | null;
  model: string;
  manufacturer: string;
  androidVersion: string;
  sdk: string;
  abi: string;
}> {
  const props = ['ro.product.model', 'ro.product.manufacturer', 'ro.build.version.release', 'ro.build.version.sdk', 'ro.product.cpu.abi'];
  const results: Record<string, string> = {};

  for (const prop of props) {
    const r = await adbExec(['shell', 'getprop', prop], serial);
    results[prop] = r.stdout.trim();
  }

  return {
    serial: serial || null,
    model: results['ro.product.model'] || '',
    manufacturer: results['ro.product.manufacturer'] || '',
    androidVersion: results['ro.build.version.release'] || '',
    sdk: results['ro.build.version.sdk'] || '',
    abi: results['ro.product.cpu.abi'] || '',
  };
}
