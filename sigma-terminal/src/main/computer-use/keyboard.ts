/**
 * Keyboard control via nut-js.
 */

import { keyboard, Key, sleep } from '@nut-tree-fork/nut-js';

keyboard.config.autoDelayMs = 12;

export async function keyboardType(text: string, delay: number = 12): Promise<{ typed: string }> {
  keyboard.config.autoDelayMs = delay;
  await keyboard.type(text);
  return { typed: text };
}

// Map common key names to nut-js Key enum
const KEY_MAP: Record<string, Key> = {
  // Letters & numbers handled by nut-js directly
  enter: Key.Enter,
  return: Key.Return,
  tab: Key.Tab,
  space: Key.Space,
  escape: Key.Escape,
  esc: Key.Escape,
  backspace: Key.Backspace,
  delete: Key.Delete,
  up: Key.Up,
  down: Key.Down,
  left: Key.Left,
  right: Key.Right,
  home: Key.Home,
  end: Key.End,
  pageup: Key.PageUp,
  pagedown: Key.PageDown,
  f1: Key.F1, f2: Key.F2, f3: Key.F3, f4: Key.F4, f5: Key.F5, f6: Key.F6,
  f7: Key.F7, f8: Key.F8, f9: Key.F9, f10: Key.F10, f11: Key.F11, f12: Key.F12,
  // Modifiers
  cmd: Key.LeftCmd,
  command: Key.LeftCmd,
  meta: Key.LeftCmd,
  shift: Key.LeftShift,
  ctrl: Key.LeftControl,
  control: Key.LeftControl,
  alt: Key.LeftAlt,
  option: Key.LeftAlt,
};

function resolveKey(name: string): Key {
  const lower = name.toLowerCase();
  if (KEY_MAP[lower]) return KEY_MAP[lower];

  // Single letter
  if (/^[a-z]$/.test(lower)) {
    return Key[lower.toUpperCase() as keyof typeof Key] as Key;
  }
  // Single digit
  if (/^[0-9]$/.test(lower)) {
    return Key[`Num${lower}` as keyof typeof Key] as Key;
  }
  throw new Error(`Unknown key: ${name}`);
}

export async function keyboardKey(keyStr: string): Promise<{ pressed: string }> {
  // Parse "cmd+c", "ctrl+shift+a", "Return", etc.
  const parts = keyStr.split('+').map(p => p.trim());
  const keys: Key[] = parts.map(resolveKey);

  if (keys.length === 1) {
    await keyboard.pressKey(keys[0]);
    await sleep(20);
    await keyboard.releaseKey(keys[0]);
  } else {
    // Modifiers first, then main key
    for (const k of keys) {
      await keyboard.pressKey(k);
    }
    await sleep(30);
    // Release in reverse order
    for (let i = keys.length - 1; i >= 0; i--) {
      await keyboard.releaseKey(keys[i]);
    }
  }

  return { pressed: keyStr };
}
