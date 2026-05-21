/**
 * Application control — macOS via osascript, Windows via powershell.
 */

import { spawn } from 'child_process';

const IS_WIN = process.platform === 'win32';

/** Sanitize app/window name — only allow safe characters to prevent injection */
function sanitizeName(name: string): string {
  // Strip anything that could break out of quotes in osascript/powershell
  const clean = name.replace(/[^a-zA-Z0-9\s.\-_\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, '');
  if (!clean) throw new Error('Invalid app name');
  return clean;
}

function runCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${cmd} exited ${code}`));
    });
  });
}

const osascript = (script: string) => runCmd('osascript', ['-e', script]);
const powershell = (script: string) => runCmd('powershell.exe', ['-NoProfile', '-Command', script]);

export async function appLaunch(name: string): Promise<{ launched: string }> {
  name = sanitizeName(name);
  if (IS_WIN) {
    await runCmd('cmd', ['/c', 'start', '', name]);
  } else {
    await osascript(`tell application "${name}" to activate`);
  }
  return { launched: name };
}

export async function appListRunning(): Promise<{ apps: Array<{ name: string; frontmost: boolean }> }> {
  if (IS_WIN) {
    const out = await powershell(
      'Get-Process | Where-Object {$_.MainWindowTitle -ne ""} | Select-Object @{N="name";E={$_.ProcessName}}, @{N="title";E={$_.MainWindowTitle}} | ConvertTo-Json -Compress'
    );
    try {
      let parsed = JSON.parse(out);
      if (!Array.isArray(parsed)) parsed = [parsed];
      return {
        apps: parsed.map((p: any) => ({ name: p.name || '', frontmost: false })),
      };
    } catch {
      return { apps: [] };
    }
  }

  const script = `
    tell application "System Events"
      set procs to every process where background only is false
      set output to ""
      repeat with p in procs
        set output to output & (name of p) & "|" & (frontmost of p) & "\n"
      end repeat
      return output
    end tell
  `;
  const out = await osascript(script);
  const apps = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, frontmost] = line.split('|');
      return { name: name?.trim() || '', frontmost: frontmost?.trim() === 'true' };
    });
  return { apps };
}

export async function appFocus(name: string): Promise<{ focused: string }> {
  name = sanitizeName(name);
  if (IS_WIN) {
    await powershell(`(New-Object -ComObject WScript.Shell).AppActivate("${name}")`);
  } else {
    await osascript(`tell application "${name}" to activate`);
  }
  return { focused: name };
}

export async function appQuit(name: string): Promise<{ quit: string }> {
  name = sanitizeName(name);
  if (IS_WIN) {
    await powershell(`Stop-Process -Name "${name}" -ErrorAction SilentlyContinue`);
  } else {
    await osascript(`tell application "${name}" to quit`);
  }
  return { quit: name };
}
