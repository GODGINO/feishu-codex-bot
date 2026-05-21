/**
 * First-launch permission onboarding.
 *
 * On first run, immediately requests all permissions Sigma Terminal needs:
 * - Notifications (by sending one)
 * - Accessibility (mouse/keyboard control)
 * - Screen Recording (screenshot)
 *
 * macOS shows native prompts for each. We don't wait — we kick them all off
 * so the user grants everything once instead of being interrupted later.
 */

import { systemPreferences, Notification, dialog, shell } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface OnboardingResult {
  notification: boolean;
  accessibility: boolean;
  screenRecording: boolean;
}

/**
 * Trigger all macOS permission prompts. Safe to call repeatedly.
 */
export async function requestAllPermissions(): Promise<OnboardingResult> {
  // Windows: no special permissions needed, just send welcome notification
  if (process.platform === 'win32') {
    try {
      new Notification({ title: 'Sigma Terminal', body: '欢迎使用 Sigma Terminal！' }).show();
    } catch { /* ignore */ }
    return { notification: true, accessibility: true, screenRecording: true };
  }

  // macOS: request all permissions upfront

  // 1. Notification — sending a notification is enough to register
  // and trigger the permission flow on first launch
  try {
    new Notification({
      title: 'Sigma Terminal',
      body: '欢迎使用！正在请求所需权限，请在弹窗中点击「允许」。',
    }).show();
  } catch {
    // ignore
  }

  // 2. Accessibility — passing true shows the system prompt with
  // "Open System Settings" button
  let accessibility = false;
  try {
    accessibility = systemPreferences.isTrustedAccessibilityClient(true);
  } catch {
    // ignore
  }

  // 3. Screen Recording — the prompt only appears when an app actually
  // tries to capture the screen. We invoke screencapture once to trigger it.
  let screenRecording = false;
  try {
    const tmpFile = path.join(os.tmpdir(), `sigma-perm-test-${Date.now()}.png`);
    await new Promise<void>((resolve) => {
      const proc = spawn('screencapture', ['-x', '-t', 'png', tmpFile]);
      proc.on('close', () => resolve());
      proc.on('error', () => resolve());
    });
    // If the file was created successfully, permission is granted
    if (fs.existsSync(tmpFile)) {
      const stat = fs.statSync(tmpFile);
      // A real screenshot is > 1KB; a "permission denied" capture creates an empty/tiny file
      screenRecording = stat.size > 1024;
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // ignore
      }
    }
    // Also check via systemPreferences
    if (!screenRecording) {
      screenRecording = systemPreferences.getMediaAccessStatus('screen') === 'granted';
    }
  } catch {
    // ignore
  }

  return {
    notification: true, // sending a notification doesn't return status
    accessibility,
    screenRecording,
  };
}

/**
 * Show a native dialog with permission status and links to System Settings.
 * Used when permissions are missing later.
 */
export function showPermissionDialog(result: OnboardingResult): void {
  const missing: string[] = [];
  if (!result.accessibility) missing.push('• 辅助功能（鼠标键盘控制）');
  if (!result.screenRecording) missing.push('• 屏幕录制（截屏）');

  if (missing.length === 0) return;

  const choice = dialog.showMessageBoxSync({
    type: 'info',
    title: 'Sigma Terminal 需要权限',
    message: '为了完整功能，请在系统设置中授予以下权限：',
    detail: missing.join('\n') + '\n\n点击「打开系统设置」自动跳转。',
    buttons: ['打开系统设置', '稍后'],
    defaultId: 0,
  });

  if (choice === 0) {
    // Open System Settings to Privacy & Security
    if (!result.accessibility) {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    } else if (!result.screenRecording) {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    }
  }
}
