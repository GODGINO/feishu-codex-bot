/**
 * Command executor — implements all 9 remote terminal tools.
 * Mirrors Claude Code's Read/Write/Edit/Glob/Grep/Bash capabilities.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import fg from 'fast-glob';
import { Notification } from 'electron';
import { checkSecurity, checkPathSecurity } from './security';
import { withComputerUse } from './abort-controller';
import * as cu from './computer-use';
import * as pu from './phone-use';

const MAX_OUTPUT = 100_000; // 100KB output limit

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) : str;
}

// ── shell_exec ──

const IS_WIN = process.platform === 'win32';

function shellExec(command: string, cwd?: string, timeout = 60_000): Promise<unknown> {
  checkSecurity(command);

  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';

    // Whitelist safe environment variables — don't leak app secrets to subprocesses
    const safeEnv: Record<string, string> = {};
    const SAFE_VARS = ['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'TERM', 'TMPDIR',
      'ANDROID_HOME', 'JAVA_HOME', 'GOPATH', 'GOROOT', 'NVM_DIR', 'PYENV_ROOT', 'CARGO_HOME', 'RUSTUP_HOME'];
    for (const k of SAFE_VARS) {
      if (process.env[k]) safeEnv[k] = process.env[k]!;
    }

    const proc = IS_WIN
      ? spawn('powershell.exe', ['-NoProfile', '-Command', command], {
          cwd: cwd || os.homedir(), timeout, env: safeEnv,
        })
      : spawn('bash', ['-c', command], {
          cwd: cwd || os.homedir(), timeout, env: safeEnv,
        });

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('close', (exitCode) => {
      resolve({
        stdout: truncate(stdout, MAX_OUTPUT),
        stderr: truncate(stderr, MAX_OUTPUT),
        exitCode: exitCode ?? 1,
        duration: Date.now() - start,
        truncated: stdout.length > MAX_OUTPUT || stderr.length > MAX_OUTPUT,
      });
    });

    proc.on('error', (err) => {
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        duration: Date.now() - start,
      });
    });
  });
}

// ── file_read ── (with line numbers, like Claude Code Read)

function fileRead(filePath: string, offset = 0, limit = 2000): unknown {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const slice = lines.slice(offset, offset + limit);
  const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`);

  return {
    content: numbered.join('\n'),
    totalLines: lines.length,
    truncated: lines.length > offset + limit,
  };
}

// ── file_write ──

function fileWrite(filePath: string, content: string): unknown {
  checkPathSecurity(filePath);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  return { written: filePath, size: Buffer.byteLength(content) };
}

// ── file_edit ── (old_string → new_string, like Claude Code Edit)

function fileEdit(filePath: string, oldString: string, newString: string, replaceAll = false): unknown {
  checkPathSecurity(filePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  if (!replaceAll) {
    const count = content.split(oldString).length - 1;
    if (count === 0) {
      throw new Error(`old_string not found in ${filePath}`);
    }
    if (count > 1) {
      throw new Error(`old_string found ${count} times in ${filePath}, must be unique. Use replace_all to replace all occurrences.`);
    }
  }

  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);

  fs.writeFileSync(filePath, updated, 'utf-8');
  return { edited: filePath };
}

// ── glob ──

async function globSearch(pattern: string, searchPath?: string): Promise<unknown> {
  const cwd = searchPath || os.homedir();
  const entries = await fg(pattern, {
    cwd,
    absolute: true,
    onlyFiles: false,
    dot: false,
    ignore: ['**/node_modules/**', '**/.git/**'],
  });

  // Limit results
  const limited = entries.slice(0, 500);
  return {
    files: limited,
    total: entries.length,
    truncated: entries.length > 500,
  };
}

// ── grep ── (via ripgrep if available, fallback to native grep)

function grepSearch(pattern: string, searchPath?: string, glob?: string, include?: string): Promise<unknown> {
  const cwd = searchPath || os.homedir();

  // Build rg command (preferred) with fallback to grep
  const args: string[] = ['-rn', '--max-count=200', '--max-columns=300'];

  if (glob) {
    args.push('--glob', glob);
  }
  if (include) {
    args.push('--type', include);
  }

  args.push('--', pattern, cwd);

  return new Promise((resolve) => {
    // Try ripgrep first, fallback to grep
    const proc = spawn('rg', args, { timeout: 30_000 });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('close', (exitCode) => {
      if (exitCode === 0 || exitCode === 1) {
        // rg returns 1 for no matches
        const lines = stdout.trim().split('\n').filter(Boolean);
        resolve({
          matches: truncate(stdout, MAX_OUTPUT),
          matchCount: lines.length,
          truncated: stdout.length > MAX_OUTPUT,
        });
      } else {
        resolve({ error: stderr || `grep exited with ${exitCode}`, matches: '', matchCount: 0 });
      }
    });

    proc.on('error', () => {
      // rg not found, fall back to grep
      const grepArgs = ['-rn', '--max-count=200'];
      if (include) grepArgs.push('--include', `*.${include}`);
      grepArgs.push('--', pattern, cwd);

      const fallback = spawn('grep', grepArgs, { timeout: 30_000 });
      let out = '';

      fallback.stdout.on('data', (d) => { out += d; });
      fallback.on('close', (code) => {
        const lines = out.trim().split('\n').filter(Boolean);
        resolve({
          matches: truncate(out, MAX_OUTPUT),
          matchCount: lines.length,
          truncated: out.length > MAX_OUTPUT,
        });
      });
    });
  });
}

// ── system_info ──

async function systemInfo(): Promise<unknown> {
  const perms = cu.checkPermissions();
  const adb = await pu.adbAvailable().catch(() => ({ installed: false, version: null }));

  let connectedDevices = 0;
  if (adb.installed) {
    try {
      const r = await pu.adbDevices();
      connectedDevices = r.devices.filter((d) => d.state === 'device').length;
    } catch {
      // ignore
    }
  }

  return {
    os: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    username: os.userInfo().username,
    home: os.homedir(),
    shell: process.env.SHELL || '/bin/zsh',
    nodeVersion: process.version,
    cpus: os.cpus().length,
    totalMemory: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
    computerUse: {
      accessibilityGranted: perms.accessibility,
      screenRecordingGranted: perms.screenRecording,
    },
    phoneUse: {
      adbInstalled: adb.installed,
      adbVersion: adb.version,
      connectedDevices,
    },
  };
}

// ── open ──

function openTarget(target: string): Promise<unknown> {
  return new Promise((resolve) => {
    const proc = IS_WIN
      ? spawn('cmd', ['/c', 'start', '', target])
      : spawn('open', [target]);
    proc.on('close', (exitCode) => {
      resolve({ opened: target, exitCode });
    });
    proc.on('error', (err) => {
      resolve({ error: err.message });
    });
  });
}

// ── notify ──

function sendNotify(title: string, body: string): unknown {
  new Notification({ title, body }).show();
  return { sent: true };
}

// ── Main dispatcher ──

export async function executeCommand(tool: string, params: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    case 'shell_exec':
      return shellExec(
        params.command as string,
        params.cwd as string | undefined,
        params.timeout as number | undefined,
      );

    case 'file_read':
      return fileRead(
        params.path as string,
        params.offset as number | undefined,
        params.limit as number | undefined,
      );

    case 'file_write':
      return fileWrite(params.path as string, params.content as string);

    case 'file_edit':
      return fileEdit(
        params.path as string,
        params.old_string as string,
        params.new_string as string,
        params.replace_all as boolean | undefined,
      );

    case 'glob':
      return globSearch(params.pattern as string, params.path as string | undefined);

    case 'grep':
      return grepSearch(
        params.pattern as string,
        params.path as string | undefined,
        params.glob as string | undefined,
        params.include as string | undefined,
      );

    case 'system_info':
      return systemInfo();

    case 'open':
      return openTarget(params.target as string);

    case 'notify':
      return sendNotify(params.title as string, params.body as string);

    // ─── Computer Use (Mac control) ───

    case 'screenshot':
      return withComputerUse(() => cu.screenshot(params as any));

    case 'display_info':
      return cu.getDisplayInfo();

    case 'mouse_move':
      return withComputerUse(() => cu.mouseMove(params.x as number, params.y as number));

    case 'mouse_click':
      return withComputerUse(() =>
        cu.mouseClick(
          params.x as number,
          params.y as number,
          (params.button as any) || 'left',
          (params.count as number) || 1,
        ),
      );

    case 'mouse_drag':
      return withComputerUse(() =>
        cu.mouseDrag(
          params.from as { x: number; y: number },
          params.to as { x: number; y: number },
          (params.duration as number) || 500,
        ),
      );

    case 'mouse_scroll':
      return withComputerUse(() =>
        cu.mouseScroll(
          params.x as number,
          params.y as number,
          (params.dx as number) || 0,
          (params.dy as number) || 0,
        ),
      );

    case 'mouse_position':
      return cu.mousePosition();

    case 'keyboard_type':
      return withComputerUse(() => cu.keyboardType(params.text as string, (params.delay as number) || 12));

    case 'keyboard_key':
      return withComputerUse(() => cu.keyboardKey(params.key as string));

    case 'app_launch':
      return cu.appLaunch(params.name as string);

    case 'app_list_running':
      return cu.appListRunning();

    case 'app_focus':
      return cu.appFocus(params.name as string);

    case 'app_quit':
      return cu.appQuit(params.name as string);

    case 'window_list':
      return cu.windowList(params.app as string | undefined);

    case 'window_resize':
      return cu.windowResize(
        params.app as string,
        params.x as number,
        params.y as number,
        params.width as number,
        params.height as number,
      );

    // ─── Phone Use (ADB control) ───

    case 'adb_devices':
      return pu.adbDevices();

    case 'adb_device_info':
      return pu.adbDeviceInfo(params.serial as string | undefined);

    case 'adb_screenshot':
      return withComputerUse(() => pu.adbScreenshot(params.serial as string | undefined));

    case 'adb_screen_size':
      return pu.adbScreenSize(params.serial as string | undefined);

    case 'adb_record_screen':
      return pu.adbRecordScreen(
        params.serial as string | undefined,
        (params.duration as number) || 10,
        params.outputPath as string | undefined,
      );

    case 'adb_tap':
      return withComputerUse(() => pu.adbTap(params.x as number, params.y as number, params.serial as string | undefined));

    case 'adb_swipe':
      return withComputerUse(() =>
        pu.adbSwipe(
          params.x1 as number,
          params.y1 as number,
          params.x2 as number,
          params.y2 as number,
          (params.duration as number) || 300,
          params.serial as string | undefined,
        ),
      );

    case 'adb_long_press':
      return withComputerUse(() =>
        pu.adbLongPress(
          params.x as number,
          params.y as number,
          (params.duration as number) || 1000,
          params.serial as string | undefined,
        ),
      );

    case 'adb_text':
      return withComputerUse(() => pu.adbText(params.text as string, params.serial as string | undefined));

    case 'adb_keyevent':
      return withComputerUse(() => pu.adbKeyevent(params.key as string, params.serial as string | undefined));

    case 'adb_install':
      return pu.adbInstall(params.apkPath as string, params.serial as string | undefined);

    case 'adb_app_list':
      return pu.adbAppList(params.serial as string | undefined, (params.includeSystem as boolean) || false);

    case 'adb_app_launch':
      return pu.adbAppLaunch(
        params.package as string,
        params.activity as string | undefined,
        params.serial as string | undefined,
      );

    case 'adb_app_force_stop':
      return pu.adbAppForceStop(params.package as string, params.serial as string | undefined);

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
