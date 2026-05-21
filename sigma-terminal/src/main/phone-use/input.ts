/**
 * ADB input control: tap, swipe, text, key events.
 */

import { adbExec } from './adb-runner';

export async function adbTap(x: number, y: number, serial?: string): Promise<{ tapped: { x: number; y: number } }> {
  const r = await adbExec(['shell', 'input', 'tap', String(x), String(y)], serial);
  if (r.code !== 0) throw new Error(r.stderr || `tap failed`);
  return { tapped: { x, y } };
}

export async function adbSwipe(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  duration: number = 300,
  serial?: string,
): Promise<{ swiped: { x1: number; y1: number; x2: number; y2: number; duration: number } }> {
  const r = await adbExec(
    ['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(duration)],
    serial,
  );
  if (r.code !== 0) throw new Error(r.stderr || `swipe failed`);
  return { swiped: { x1, y1, x2, y2, duration } };
}

export async function adbLongPress(
  x: number,
  y: number,
  duration: number = 1000,
  serial?: string,
): Promise<{ longPressed: { x: number; y: number; duration: number } }> {
  // Long press = swipe to same point with duration
  const r = await adbExec(
    ['shell', 'input', 'swipe', String(x), String(y), String(x), String(y), String(duration)],
    serial,
  );
  if (r.code !== 0) throw new Error(r.stderr || `long press failed`);
  return { longPressed: { x, y, duration } };
}

export async function adbText(text: string, serial?: string): Promise<{ typed: string }> {
  // adb input text needs special escaping: spaces → %s, special chars escaped
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/ /g, '%s')
    .replace(/&/g, '\\&')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>')
    .replace(/\|/g, '\\|')
    .replace(/;/g, '\\;')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');

  const r = await adbExec(['shell', 'input', 'text', escaped], serial);
  if (r.code !== 0) throw new Error(r.stderr || `text input failed`);
  return { typed: text };
}

// Common Android key events
const KEY_EVENTS: Record<string, string> = {
  home: 'KEYCODE_HOME',
  back: 'KEYCODE_BACK',
  menu: 'KEYCODE_MENU',
  enter: 'KEYCODE_ENTER',
  return: 'KEYCODE_ENTER',
  tab: 'KEYCODE_TAB',
  space: 'KEYCODE_SPACE',
  delete: 'KEYCODE_DEL',
  backspace: 'KEYCODE_DEL',
  escape: 'KEYCODE_ESCAPE',
  power: 'KEYCODE_POWER',
  volumeup: 'KEYCODE_VOLUME_UP',
  volumedown: 'KEYCODE_VOLUME_DOWN',
  mute: 'KEYCODE_VOLUME_MUTE',
  recent: 'KEYCODE_APP_SWITCH',
  apps: 'KEYCODE_APP_SWITCH',
  search: 'KEYCODE_SEARCH',
  camera: 'KEYCODE_CAMERA',
  call: 'KEYCODE_CALL',
  endcall: 'KEYCODE_ENDCALL',
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
  center: 'KEYCODE_DPAD_CENTER',
};

export async function adbKeyevent(key: string, serial?: string): Promise<{ pressed: string }> {
  const lower = key.toLowerCase();
  // Allow either friendly name or raw KEYCODE_*
  let keycode = KEY_EVENTS[lower] || (key.startsWith('KEYCODE_') ? key : null);
  if (!keycode) {
    // Try as numeric
    if (/^\d+$/.test(key)) {
      keycode = key;
    } else {
      throw new Error(`Unknown key: ${key}. Use 'home', 'back', etc. or raw KEYCODE_*`);
    }
  }

  const r = await adbExec(['shell', 'input', 'keyevent', keycode], serial);
  if (r.code !== 0) throw new Error(r.stderr || `keyevent failed`);
  return { pressed: key };
}
