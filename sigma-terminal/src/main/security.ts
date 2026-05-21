/**
 * Security rules — hard-coded deny patterns that cannot be overridden.
 * Platform-aware: separate rule sets for macOS/Linux and Windows.
 */

import * as os from 'os';
import * as path from 'path';

// ── Unix deny rules ──
const HARD_DENY_UNIX: RegExp[] = [
  // rm with recursive + force targeting root or home (short and long flags)
  /\brm\s.*\//,                              // any rm targeting absolute paths — broad but safe
  /\brm\s+(-\w*r\w*\s+)?.*\.\.\//,          // rm with path traversal ../
  /\brm\s+--recursive/i,                     // long-form --recursive
  /\bmkfs\b/,                                // format disk
  />\s*\/dev\/(sd|disk|nvme)/,               // write to disk device
  /\bdd\s+.*of=\/dev\//,                     // dd to device
  /:(){ :\|:& };:/,                          // fork bomb
  /\bchmod\s+777\s+\//,                      // chmod 777 on root
  /\bchown\s+.*\//,                          // chown on root paths
];

// ── Windows deny rules ──
const HARD_DENY_WIN: RegExp[] = [
  /\bformat\s+[a-zA-Z]:/i,
  /\brd\s+.*\/s.*[a-zA-Z]:\\/i,
  /\bdel\s+.*\/[sfq].*[a-zA-Z]:\\/i,
  /\bRemove-Item\s+.*-Recurse.*[a-zA-Z]:\\/i,
  /\bRemove-Item\s+.*[a-zA-Z]:\\.*-Recurse/i,
  /\bdiskpart/i,
  /\bbcdedit/i,
  /\breg\s+delete\s+HK/i,
];

// ── Cross-platform deny rules ──
const HARD_DENY_COMMON: RegExp[] = [
  /\$\(.*rm\b/,                              // command substitution: $(rm ...)
  /`.*rm\b/,                                 // backtick: `rm ...`
  /\|\s*sh\b/,                               // pipe to shell: | sh
  /\|\s*bash\b/,                             // pipe to bash: | bash
  /\bcurl\b.*\|\s*(sh|bash)\b/,             // curl | sh
  /\bwget\b.*\|\s*(sh|bash)\b/,             // wget | bash
  /\.\.\/(\.\.\/){2,}/,                      // deep path traversal ../../../
];

// ── Sensitive path deny (for file_write / file_read / file_edit) ──
const SENSITIVE_PATHS: RegExp[] = [
  /^\/(etc|var\/log|usr|sbin|bin)\//,         // system dirs (Unix)
  /^[a-zA-Z]:\\(Windows|Program Files)/i,     // system dirs (Windows)
  /\/(\.ssh|\.gnupg|\.aws|\.kube|\.docker)\//,  // credential dirs
  /\/\.bashrc$/,                              // shell config
  /\/\.zshrc$/,
  /\/\.profile$/,
  /\/\.bash_profile$/,
];

export function checkSecurity(command: string): void {
  const rules = process.platform === 'win32' ? HARD_DENY_WIN : HARD_DENY_UNIX;
  for (const rule of [...rules, ...HARD_DENY_COMMON]) {
    if (rule.test(command)) {
      throw new Error(`Command blocked by security rule`);
    }
  }
}

/**
 * Check if a file path is safe for write/edit operations.
 * Rejects system files and sensitive credential directories.
 */
export function checkPathSecurity(filePath: string): void {
  const resolved = path.resolve(filePath);
  const home = os.homedir();

  // Must be within home directory
  if (!resolved.startsWith(home)) {
    throw new Error(`File operations outside home directory are forbidden`);
  }

  // Check sensitive paths
  for (const rule of SENSITIVE_PATHS) {
    if (rule.test(resolved)) {
      throw new Error(`Access to sensitive path is forbidden`);
    }
  }
}
