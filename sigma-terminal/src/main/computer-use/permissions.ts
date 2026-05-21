/**
 * Permission detection — macOS needs Accessibility + Screen Recording.
 * Windows has no equivalent restrictions, always returns granted.
 */

import { systemPreferences } from 'electron';

export interface PermissionStatus {
  accessibility: boolean;
  screenRecording: boolean;
}

export function checkPermissions(): PermissionStatus {
  if (process.platform !== 'darwin') {
    return { accessibility: true, screenRecording: true };
  }
  return {
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screenRecording: systemPreferences.getMediaAccessStatus('screen') === 'granted',
  };
}

export function requestPermissions(): PermissionStatus {
  if (process.platform !== 'darwin') {
    return { accessibility: true, screenRecording: true };
  }
  systemPreferences.isTrustedAccessibilityClient(true);
  return checkPermissions();
}
