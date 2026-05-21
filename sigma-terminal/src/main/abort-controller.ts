/**
 * Global abort controller for computer-use / phone-use sessions.
 *
 * - Registers a global ESC shortcut while computer use is active
 * - Provides AbortSignal that long-running tools should respect
 * - Shows macOS notifications when control starts/stops
 * - Updates tray icon to red pulse during active control
 */

import { globalShortcut, Notification } from 'electron';
import { updateTrayIcon } from './tray';

let activeController: AbortController | null = null;
let activeToolCount = 0;

export class UserAbortError extends Error {
  constructor() {
    super('Operation aborted by user (ESC pressed)');
    this.name = 'UserAbortError';
  }
}

/**
 * Begin a computer-use / phone-use operation. Increments the active count.
 * On the first call, registers ESC shortcut and shows notification.
 */
export function beginComputerUse(): AbortSignal {
  if (activeToolCount === 0) {
    activeController = new AbortController();

    // Register global ESC to abort
    try {
      globalShortcut.register('Escape', () => {
        if (activeController) {
          activeController.abort();
          new Notification({
            title: 'Sigma 已停止',
            body: '用户按下 ESC 中止了远程控制',
          }).show();
          // Reset state
          activeToolCount = 0;
          activeController = null;
          globalShortcut.unregister('Escape');
          updateTrayIcon(true); // back to connected (not controlling)
        }
      });
    } catch {
      // ESC may already be registered or unavailable
    }

    // Show start notification
    new Notification({
      title: 'Sigma 正在控制你的设备',
      body: '按 ESC 随时停止',
    }).show();

    // Update tray to "controlling" state
    updateTrayIcon(true, true);
  }

  activeToolCount++;
  return activeController!.signal;
}

/**
 * Mark a computer-use / phone-use operation as finished.
 * On the last call, unregisters ESC and hides notification.
 */
export function endComputerUse(): void {
  activeToolCount = Math.max(0, activeToolCount - 1);

  if (activeToolCount === 0 && activeController) {
    try {
      globalShortcut.unregister('Escape');
    } catch {
      // ignore
    }
    activeController = null;
    updateTrayIcon(true, false);
  }
}

/**
 * Wrap a tool execution in begin/end + abort handling.
 */
export async function withComputerUse<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = beginComputerUse();
  try {
    if (signal.aborted) throw new UserAbortError();
    return await fn(signal);
  } finally {
    endComputerUse();
  }
}

export function isAborted(): boolean {
  return activeController?.signal.aborted ?? false;
}
