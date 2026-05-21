/**
 * Window management — macOS via osascript, Windows via powershell + Win32 API.
 */

import { spawn } from 'child_process';

const IS_WIN = process.platform === 'win32';

function sanitizeName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9\s.\-_\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, '');
  if (!clean) throw new Error('Invalid name');
  return clean;
}

function sanitizeNumber(n: number): number {
  const num = Math.round(n);
  if (!Number.isFinite(num) || num < -10000 || num > 100000) throw new Error('Invalid coordinate');
  return num;
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

export interface WindowInfo {
  app: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function windowList(appFilter?: string): Promise<{ windows: WindowInfo[] }> {
  if (appFilter) appFilter = sanitizeName(appFilter);
  if (IS_WIN) {
    const filter = appFilter
      ? `Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -eq '${appFilter}' }`
      : `Where-Object { $_.MainWindowHandle -ne 0 }`;

    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SigmaWin32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
Get-Process | ${filter} | ForEach-Object {
  $r = New-Object SigmaWin32+RECT
  [SigmaWin32]::GetWindowRect($_.MainWindowHandle, [ref]$r) | Out-Null
  [PSCustomObject]@{ app=$_.ProcessName; title=$_.MainWindowTitle; x=$r.Left; y=$r.Top; w=($r.Right-$r.Left); h=($r.Bottom-$r.Top) }
} | ConvertTo-Json -Compress`;

    try {
      const out = await powershell(script);
      let parsed = JSON.parse(out || '[]');
      if (!Array.isArray(parsed)) parsed = [parsed];
      return {
        windows: parsed.map((w: any) => ({
          app: w.app || '', title: w.title || '',
          x: w.x || 0, y: w.y || 0, width: w.w || 0, height: w.h || 0,
        })),
      };
    } catch {
      return { windows: [] };
    }
  }

  // macOS
  const procFilter = appFilter
    ? `every process where background only is false and name is "${appFilter}"`
    : `every process where background only is false`;

  const script = `
    tell application "System Events"
      set output to ""
      set procs to ${procFilter}
      repeat with p in procs
        set procName to name of p
        try
          set wins to every window of p
          repeat with w in wins
            try
              set wTitle to name of w
              set wPos to position of w
              set wSize to size of w
              set output to output & procName & "||" & wTitle & "||" & (item 1 of wPos) & "||" & (item 2 of wPos) & "||" & (item 1 of wSize) & "||" & (item 2 of wSize) & "\n"
            end try
          end repeat
        end try
      end repeat
      return output
    end tell
  `;

  const out = await osascript(script);
  return {
    windows: out.split('\n').filter(Boolean).map((line) => {
      const [app, title, x, y, w, h] = line.split('||');
      return {
        app: app?.trim() || '', title: title?.trim() || '',
        x: parseInt(x) || 0, y: parseInt(y) || 0,
        width: parseInt(w) || 0, height: parseInt(h) || 0,
      };
    }),
  };
}

export async function windowResize(
  app: string, x: number, y: number, width: number, height: number,
): Promise<{ resized: { app: string; x: number; y: number; width: number; height: number } }> {
  app = sanitizeName(app);
  x = sanitizeNumber(x); y = sanitizeNumber(y);
  width = sanitizeNumber(width); height = sanitizeNumber(height);
  if (IS_WIN) {
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SigmaWin32Move {
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int W, int H, bool repaint);
}
"@
$p = Get-Process -Name "${app}" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) { [SigmaWin32Move]::MoveWindow($p.MainWindowHandle, ${x}, ${y}, ${width}, ${height}, $true) }`;
    await powershell(script);
  } else {
    const script = `
      tell application "System Events"
        tell process "${app}"
          set frontWin to first window
          set position of frontWin to {${x}, ${y}}
          set size of frontWin to {${width}, ${height}}
        end tell
      end tell
    `;
    await osascript(script);
  }

  return { resized: { app, x, y, width, height } };
}
