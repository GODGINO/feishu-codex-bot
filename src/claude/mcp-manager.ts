import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import type { Logger } from '../utils/logger.js';

/**
 * MCP server definition with template variables like {CHROME_PORT}, {SESSION_DIR}, etc.
 */
interface McpServerTemplate {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface SkillDefinition {
  name: string;
  description?: string;
  cron?: string;
  prompt: string;
  targetChatId?: string; // For shared skills: where to send results
}

export interface McpConfig {
  defaults: Record<string, string>;
  sharedMcp: Record<string, McpServerTemplate>;
  isolatedMcp: Record<string, McpServerTemplate>;
  sessionMcp: Record<string, Record<string, McpServerTemplate>>;
  sharedSkills: SkillDefinition[];
  sessionSkills: Record<string, SkillDefinition[]>;
  sessions: Record<string, Record<string, string>>;
}

export interface ResolvedSkill extends SkillDefinition {
  sessionKey?: string; // Bound session for isolated skills
  shared: boolean;
}

const PORT_BASE = 9300;
const PORT_FILE = '.chrome-port';
const PORT_ALLOC_FILE = 'port-allocations.json';

export class McpManager {
  private config: McpConfig;
  private configPath: string;
  private portAllocations = new Map<string, number>(); // sessionKey -> port
  private portAllocPath: string;

  constructor(
    private sessionsDir: string,
    private logger: Logger,
  ) {
    this.configPath = path.join(path.dirname(sessionsDir), 'mcp-config.json');
    this.portAllocPath = path.join(path.dirname(sessionsDir), PORT_ALLOC_FILE);
    this.config = this.loadConfig();
    this.loadPortAllocations();
  }

  /**
   * Set up MCP config for a session: generate .claude/settings.json + chrome launch script.
   * Chrome-devtools MCP is NOT included in the initial config (lazy-loaded via start-chrome.sh).
   */
  setup(sessionKey: string, sessionDir: string): void {
    const claudeDir = path.join(sessionDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    const vars = this.resolveVariables(sessionKey, sessionDir);
    const settings = this.buildSettings(sessionKey, sessionDir, vars);
    const settingsPath = path.join(claudeDir, 'settings.json');

    // Initial MCP config: only shared/session MCP, NO isolated (chrome-devtools).
    // Chrome MCP is lazy-loaded by start-chrome.sh when the user actually needs it.
    const initialMcpServers = this.buildInitialMcpServers(sessionKey, sessionDir, vars);
    const mcpConfigPath = path.join(sessionDir, 'mcp-servers.json');

    // Check if anything changed
    const settingsContent = JSON.stringify(settings, null, 2);
    let settingsChanged = false;
    try {
      if (fs.readFileSync(settingsPath, 'utf-8') !== settingsContent) settingsChanged = true;
    } catch { settingsChanged = true; }

    // Check if mcp-servers.json needs updating (compare non-chrome entries).
    // When chrome is active, start-chrome.sh will regenerate the full config.
    let mcpChanged = false;
    try {
      const existingMcp = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
      // Preserve chrome-devtools ONLY if Chrome is actually running on the expected port.
      // If Chrome has been idle-stopped, we must NOT keep this entry — it causes Claude to exit.
      const chromeEntry = existingMcp.mcpServers?.['chrome-devtools'];
      if (chromeEntry) {
        const port = vars.CHROME_PORT || '9222';
        try {
          execSync(`curl -s --max-time 1 http://127.0.0.1:${port}/json/version > /dev/null 2>&1`);
          initialMcpServers['chrome-devtools'] = chromeEntry;
        } catch {
          // Chrome not running — drop the entry and silently update the file.
          // This is NOT a config change that requires process restart.
          this.logger.info({ sessionKey }, 'Chrome not running, removing chrome-devtools from MCP config');
          const cleanedContent = JSON.stringify({ mcpServers: initialMcpServers }, null, 2);
          fs.writeFileSync(mcpConfigPath, cleanedContent);
          // Don't set mcpChanged — removing a dead Chrome entry doesn't need a respawn
        }
      }
      const newMcpContent = JSON.stringify({ mcpServers: initialMcpServers }, null, 2);
      if (fs.readFileSync(mcpConfigPath, 'utf-8') !== newMcpContent) mcpChanged = true;
    } catch { mcpChanged = true; }
    const mcpContent = JSON.stringify({ mcpServers: initialMcpServers }, null, 2);

    // Always deploy skills (they may be added independently of MCP config changes)
    this.deploySharedSkills(sessionDir, vars);
    this.deployEmailSkill(sessionDir);

    // Always ensure Chrome launch script exists (it contains the MCP activation logic)
    const chromeScriptPath = path.join(sessionDir, 'start-chrome.sh');
    if (!fs.existsSync(chromeScriptPath)) {
      this.generateChromeScript(sessionDir, vars);
    }

    if (!settingsChanged && !mcpChanged) return;

    if (settingsChanged) {
      fs.writeFileSync(settingsPath, settingsContent);
    }
    if (mcpChanged || settingsChanged) {
      if (mcpChanged) {
        fs.writeFileSync(mcpConfigPath, mcpContent);
      }
      // Signal process pool to respawn with updated config (MCP or settings change)
      try { fs.writeFileSync(path.join(sessionDir, '.mcp-changed'), ''); } catch { /* ignore */ }
    }

    // Also regenerate Chrome script when config changes
    this.generateChromeScript(sessionDir, vars);

    this.logger.info({ sessionKey, chromePort: vars.CHROME_PORT }, 'Generated per-session MCP settings');
  }

  /**
   * Get the MCP config file path for a session (for --mcp-config flag)
   */
  getMcpConfigPath(sessionDir: string): string | null {
    const mcpConfigPath = path.join(sessionDir, 'mcp-servers.json');
    return fs.existsSync(mcpConfigPath) ? mcpConfigPath : null;
  }

  /**
   * Get all resolved skills (shared + session-bound)
   */
  getAllSkills(): ResolvedSkill[] {
    const skills: ResolvedSkill[] = [];

    for (const skill of this.config.sharedSkills) {
      skills.push({ ...skill, shared: true });
    }

    for (const [sessionKey, sessionSkills] of Object.entries(this.config.sessionSkills)) {
      for (const skill of sessionSkills) {
        skills.push({ ...skill, sessionKey, shared: false });
      }
    }

    return skills;
  }

  /**
   * Get the port allocations map (sessionKey -> port) for external use (e.g. idle checker)
   */
  getPortAllocations(): Map<string, number> {
    return this.portAllocations;
  }

  /**
   * Reload config from disk (useful when config is edited)
   */
  reload(): void {
    this.config = this.loadConfig();
    this.logger.info('MCP config reloaded');
  }

  /**
   * Generate a helper script to launch Chrome with the correct port and user-data-dir.
   * Also activates chrome-devtools MCP config and signals the process pool to reload.
   */
  private generateChromeScript(sessionDir: string, vars: Record<string, string>): void {
    const port = vars.CHROME_PORT;
    const chromeDataDir = path.join(sessionDir, '.chrome-data');
    const scriptPath = path.join(sessionDir, 'start-chrome.sh');

    // Pre-generate the full MCP config JSON (with chrome-devtools) to embed in the script
    const sessionKey = vars.SESSION_KEY;
    const fullMcpConfig = this.buildFullMcpConfig(sessionKey, sessionDir);

    const script = `#!/bin/bash
# Launch Chrome with remote debugging for this session
# Port: ${port} | User data: ${chromeDataDir}
# Usage: bash start-chrome.sh

CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
MCP_CONFIG="$(dirname "$0")/mcp-servers.json"
MCP_SIGNAL="$(dirname "$0")/.mcp-changed"

# Check if Chrome is already running on this port
if curl -s http://127.0.0.1:${port}/json/version > /dev/null 2>&1; then
  echo "Chrome is already running on port ${port}"
  exit 0
fi

mkdir -p "${chromeDataDir}"

# Launch Chrome in background with remote debugging
"$CHROME_APP" \\
  --remote-debugging-port=${port} \\
  --user-data-dir="${chromeDataDir}" \\
  --no-first-run \\
  --no-default-browser-check \\
  --remote-allow-origins=* \\
  &

# Wait for Chrome to be ready
for i in $(seq 1 15); do
  if curl -s http://127.0.0.1:${port}/json/version > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Activate chrome-devtools MCP (was not loaded at initial startup for fast boot)
cat > "$MCP_CONFIG" << 'MCPEOF'
${fullMcpConfig}
MCPEOF

# Signal the process pool to reload with the new MCP config
date +%s > "$MCP_SIGNAL"

echo "Chrome launched on port ${port} with user data at ${chromeDataDir}"
echo "Chrome MCP activated — tools will be available on next message."
`;

    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  }

  /**
   * Deploy email skill to session if email accounts are configured.
   * Creates .claude/skills/email/SKILL.md (symlink) and email-cli.sh wrapper.
   */
  private deployEmailSkill(sessionDir: string): void {
    const accountsFile = path.join(sessionDir, 'email-accounts.json');
    if (!fs.existsSync(accountsFile)) return;

    const projectRoot = path.dirname(this.sessionsDir);

    // Create skill directory
    const skillDir = path.join(sessionDir, '.claude', 'skills', 'email');
    fs.mkdirSync(skillDir, { recursive: true });

    // Copy SKILL.md (copy, not symlink, for reliability)
    const skillSrc = path.join(projectRoot, 'skills', 'email', 'SKILL.md');
    const skillDest = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(skillSrc)) {
      try {
        fs.copyFileSync(skillSrc, skillDest);
      } catch {
        // May fail if identical, ignore
      }
    }

    // Generate email-cli.sh wrapper script
    const cliPath = path.join(projectRoot, 'dist', 'email', 'cli.js');
    const wrapperPath = path.join(sessionDir, 'email-cli.sh');
    const wrapper = `#!/bin/bash
# Email CLI wrapper — runs the compiled email tool with the correct paths
# Usage: bash email-cli.sh <command> [options]
cd "$(dirname "$0")"
exec node "${cliPath}" "$@"
`;
    fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  }

  /**
   * Deploy all shared skills from skills/ directory to a session's .claude/skills/
   * Unlike email skill which is conditional, these are deployed to every session.
   * Also fixes any symlinked skills (replaces with real copies).
   */
  private deploySharedSkills(sessionDir: string, vars?: Record<string, string>): void {
    const projectRoot = path.dirname(this.sessionsDir);
    const skillsRoot = path.join(projectRoot, 'skills');

    // Fix any symlinked skills in the session (bot may have created them incorrectly)
    this.fixSymlinkedSkills(sessionDir);

    let skillDirs: string[];
    try {
      skillDirs = fs.readdirSync(skillsRoot);
    } catch {
      return; // No skills directory
    }

    // Resolve variables for template rendering in SKILL.md files
    const renderVars = vars || { PROJECT_ROOT: projectRoot };

    for (const skillName of skillDirs) {
      // Skip email — it has its own conditional deployment
      if (skillName === 'email') continue;

      const srcSkillDir = path.join(skillsRoot, skillName);
      const srcSkillMd = path.join(srcSkillDir, 'SKILL.md');
      if (!fs.existsSync(srcSkillMd)) continue;

      const destSkillDir = path.join(sessionDir, '.claude', 'skills', skillName);
      fs.mkdirSync(destSkillDir, { recursive: true });

      // Copy SKILL.md with template variable replacement
      try {
        let content = fs.readFileSync(srcSkillMd, 'utf-8');
        content = content.replace(/\{(\w+)\}/g, (_, key) => renderVars[key] ?? `{${key}}`);
        fs.writeFileSync(path.join(destSkillDir, 'SKILL.md'), content);
      } catch { /* ignore */ }

      // Copy scripts/ subdirectory if present
      const srcScripts = path.join(srcSkillDir, 'scripts');
      if (fs.existsSync(srcScripts)) {
        const destScripts = path.join(destSkillDir, 'scripts');
        fs.mkdirSync(destScripts, { recursive: true });
        try {
          for (const file of fs.readdirSync(srcScripts)) {
            fs.copyFileSync(path.join(srcScripts, file), path.join(destScripts, file));
          }
        } catch { /* ignore */ }
      }

      // Copy references/ subdirectory if present
      const srcRefs = path.join(srcSkillDir, 'references');
      if (fs.existsSync(srcRefs)) {
        const destRefs = path.join(destSkillDir, 'references');
        fs.mkdirSync(destRefs, { recursive: true });
        try {
          for (const file of fs.readdirSync(srcRefs)) {
            fs.copyFileSync(path.join(srcRefs, file), path.join(destRefs, file));
          }
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Fix any symlinked skills in the session's .claude/skills/ directory.
   * The bot may create skills as symlinks (e.g., to .agents/skills/), which is
   * non-standard. This replaces symlinks with real copies of the target content.
   */
  private fixSymlinkedSkills(sessionDir: string): void {
    const skillsDir = path.join(sessionDir, '.claude', 'skills');
    try {
      if (!fs.existsSync(skillsDir)) return;
      for (const entry of fs.readdirSync(skillsDir)) {
        const entryPath = path.join(skillsDir, entry);
        try {
          const stat = fs.lstatSync(entryPath);
          if (!stat.isSymbolicLink()) continue;

          // Resolve the symlink target
          const target = fs.realpathSync(entryPath);
          if (!fs.existsSync(target)) {
            // Broken symlink — remove it
            fs.unlinkSync(entryPath);
            this.logger.info({ skill: entry, sessionDir }, 'Removed broken skill symlink');
            continue;
          }

          // Replace symlink with a real copy
          fs.unlinkSync(entryPath);
          this.copyDirRecursive(target, entryPath);
          this.logger.info({ skill: entry, target, sessionDir }, 'Fixed symlinked skill → copied to session');
        } catch { /* ignore individual entry errors */ }
      }
    } catch { /* ignore */ }
  }

  /**
   * Recursively copy a directory.
   */
  private copyDirRecursive(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const srcPath = path.join(src, entry);
      const destPath = path.join(dest, entry);
      const stat = fs.statSync(srcPath);
      if (stat.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Build the initial MCP servers config (shared + session only, NO isolated like chrome-devtools).
   * This ensures fast Claude process startup. Chrome MCP is added later by start-chrome.sh.
   * Always includes remote-browser MCP (for user's local browser when explicitly requested).
   */
  private buildInitialMcpServers(sessionKey: string, sessionDir: string, vars: Record<string, string>): Record<string, any> {
    const mcpServers: Record<string, any> = {};

    // Add shared MCP servers (skip entries with unresolved template variables)
    for (const [name, template] of Object.entries(this.config.sharedMcp)) {
      const rendered = this.renderTemplate(template, vars);
      if (this.hasUnresolvedVars(rendered)) continue;
      mcpServers[name] = rendered;
    }

    // Add session-specific MCP servers
    const sessionMcpEntries = this.config.sessionMcp[sessionKey];
    if (sessionMcpEntries) {
      for (const [name, template] of Object.entries(sessionMcpEntries)) {
        mcpServers[name] = this.renderTemplate(template, vars);
      }
    }

    // Always include remote-browser MCP (used when user explicitly requests their local browser).
    // Sigma browser (server Chrome) is the default, lazy-loaded via start-chrome.sh.
    // The browser skill prompt tells Sigma which to use based on user's request.
    const projectRoot = path.dirname(this.sessionsDir);
    mcpServers['remote-browser'] = {
      command: 'node',
      args: [
        path.join(projectRoot, 'dist', 'relay', 'remote-browser-mcp.js'),
        sessionKey,
      ],
    };

    // Always include remote-terminal MCP (used when user explicitly requests terminal access on their Mac).
    // The terminal skill prompt tells Sigma when to use this based on user's request.
    mcpServers['remote-terminal'] = {
      command: 'node',
      args: [
        path.join(projectRoot, 'dist', 'relay', 'remote-terminal-mcp.js'),
        sessionKey,
      ],
    };

    // Cron MCP — exposes list/create/delete/toggle cron jobs as MCP tools.
    // SESSION_DIR env var is set by process-pool.ts at spawn time.
    mcpServers['cron'] = {
      command: 'node',
      args: [path.join(projectRoot, 'dist', 'cron', 'cron-mcp.js')],
    };

    // Alert MCP — exposes condition-triggered alerts (watcher / one_shot) as MCP tools.
    // Sister to cron: cron triggers on time, alert triggers when check_command returns non-empty events.
    mcpServers['alert'] = {
      command: 'node',
      args: [path.join(projectRoot, 'dist', 'alert', 'alert-mcp.js')],
    };

    // Claude-mem proxy MCP — wraps the upstream claude-mem plugin's stdio MCP
    // and forces per-session project isolation (search/timeline/get_observations
    // filtered by SIGMA_SESSION_PROJECT). The plugin's own mcp-search server is
    // disabled in settings.json (disabledMcpjsonServers) so this proxy is the
    // only entry point. No session ever bypasses the filter from sigma's side —
    // cross-session memory inspection goes through the sigma terminal (sqlite3
    // direct DB read), not through the in-conversation memory tools.
    mcpServers['claude-mem'] = {
      command: 'node',
      args: [path.join(projectRoot, 'dist', 'claude', 'claude-mem-proxy-cli.js')],
      env: {
        SIGMA_SESSION_PROJECT: sessionKey,
      },
    };

    // Feishu Tools MCP — task, calendar, bitable via OAuth Device Flow + User Access Token.
    mcpServers['feishu-tools'] = {
      command: 'node',
      args: [path.join(projectRoot, 'dist', 'feishu', 'feishu-tools-mcp.js')],
      env: {
        SESSION_DIR: sessionDir,
        FEISHU_APP_ID: vars.FEISHU_APP_ID || '',
        FEISHU_APP_SECRET: vars.FEISHU_APP_SECRET || '',
      },
    };

    // NOTE: Feishu MCP servers (url-type / Streamable HTTP) are NOT added here.
    // --mcp-config only supports stdio MCP (command+args). Feishu MCP uses Streamable HTTP
    // (url field) which is only supported in settings.json. See buildSettings().

    // NOTE: isolatedMcp (chrome-devtools) is deliberately excluded here.
    // It's added by start-chrome.sh when the user actually needs Chrome.

    return mcpServers;
  }

  /**
   * Add Feishu MCP servers from member profiles.
   * Scans members/ directory for profiles with feishuMcpUrl, adds per-openid servers.
   * If any per-user MCP is found, the default "feishu" server is NOT added.
   */
  private addFeishuMcpServers(sessionDir: string, mcpServers: Record<string, any>): void {
    // Read from members/ directory (symlinked into session)
    const membersDir = path.join(sessionDir, 'members');
    let foundPerUser = false;
    try {
      if (fs.existsSync(membersDir)) {
        for (const entry of fs.readdirSync(membersDir, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith('ou_')) continue;
          try {
            const profilePath = path.join(membersDir, entry.name, 'profile.json');
            if (!fs.existsSync(profilePath)) continue;
            const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
            if (profile.feishuMcpUrl) {
              mcpServers[`feishu_${entry.name}`] = { url: profile.feishuMcpUrl };
              foundPerUser = true;
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* ignore */ }
    if (foundPerUser) return;

    // Fallback: single-user (DM sessions) — feishu-mcp-url file
    const singleUrlFile = path.join(sessionDir, 'feishu-mcp-url');
    try {
      if (fs.existsSync(singleUrlFile)) {
        const url = fs.readFileSync(singleUrlFile, 'utf-8').split('\n')[0].trim();
        if (url) {
          mcpServers['feishu'] = { url };
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * Build the full MCP servers config INCLUDING isolated (chrome-devtools).
   * Used by start-chrome.sh to activate chrome MCP after Chrome is launched.
   */
  buildFullMcpConfig(sessionKey: string, sessionDir: string): string {
    const vars = this.resolveVariables(sessionKey, sessionDir);
    const mcpServers = this.buildInitialMcpServers(sessionKey, sessionDir, vars);

    // Add isolated MCP servers (chrome-devtools etc.)
    for (const [name, template] of Object.entries(this.config.isolatedMcp)) {
      mcpServers[name] = this.renderTemplate(template, vars);
    }

    return JSON.stringify({ mcpServers }, null, 2);
  }

  /**
   * Build the .claude/settings.json content for a session
   */
  private buildSettings(sessionKey: string, sessionDir: string, vars?: Record<string, string>): object {
    const mcpServers: Record<string, any> = {};

    // Session-specific variables (merged with defaults)
    if (!vars) vars = this.resolveVariables(sessionKey, sessionDir);

    // Add shared MCP servers (skip entries with unresolved template variables)
    for (const [name, template] of Object.entries(this.config.sharedMcp)) {
      const rendered = this.renderTemplate(template, vars);
      if (this.hasUnresolvedVars(rendered)) {
        this.logger.debug({ name }, 'Skipping MCP server with unresolved variables');
        continue;
      }
      mcpServers[name] = rendered;
    }

    // Add session-specific MCP servers (only for this session)
    const sessionMcpEntries = this.config.sessionMcp[sessionKey];
    if (sessionMcpEntries) {
      for (const [name, template] of Object.entries(sessionMcpEntries)) {
        mcpServers[name] = this.renderTemplate(template, vars);
      }
    }

    // NOTE: Isolated MCP (chrome-devtools) is NOT added here.
    // It is lazy-loaded via start-chrome.sh → mcp-servers.json → --mcp-config.

    // Add Feishu MCP servers (url-type / Streamable HTTP).
    // These MUST be in settings.json because --mcp-config only supports stdio MCP (command+args).
    // settings.json MCP failures are non-fatal, so if the URL is unreachable Claude still starts.
    this.addFeishuMcpServers(sessionDir, mcpServers);

    // Only include mcpServers if there are any
    const projectRoot = path.dirname(this.sessionsDir);
    const settings: any = {
      permissions: {
        allow: [
          'Bash(*)', 'Glob(*)', 'Grep(*)',
          // Read: only current session (including .claude/), shared, tmp
          `Read(${sessionDir}/**)`,
          `Read(${sessionDir}/.claude/**)`,
          `Read(${projectRoot}/shared/**)`,
          `Read(${projectRoot}/members/**)`,
          'Read(/tmp/**)', 'Read(/private/tmp/**)',
          // Write/Edit: only current session (including .claude/), shared, members, tmp
          `Write(${sessionDir}/**)`,
          `Write(${sessionDir}/.claude/**)`,
          `Write(${projectRoot}/shared/**)`,
          `Write(${projectRoot}/members/**)`,
          'Write(/tmp/**)', 'Write(/private/tmp/**)',
          `Edit(${sessionDir}/**)`,
          `Edit(${sessionDir}/.claude/**)`,
          `Edit(${projectRoot}/shared/**)`,
          `Edit(${projectRoot}/members/**)`,
          'Edit(/tmp/**)', 'Edit(/private/tmp/**)',
        ],
        deny: [
          // Global Claude config/memory
          'Write(~/.claude/**)', 'Edit(~/.claude/**)',
          // Sensitive files
          `Read(${projectRoot}/.env)`,
          // Browser isolation
          'Bash(open *)',
          'Bash(*google-chrome*)',
          'Bash(*Google Chrome*)',
          'Bash(*remote-debugging-port*)',
          // Tunnel isolation — prevent sessions from starting their own tunnels
          'Bash(*cloudflared*)',
          'Bash(*ngrok*)',
        ],
      },
    };

    if (Object.keys(mcpServers).length > 0) {
      settings.mcpServers = mcpServers;
    }

    // Disable the upstream claude-mem plugin's mcp-search server so the only
    // entry point is our session-scoped proxy (registered in mcp-servers.json
    // as "claude-mem"). disabledMcpjsonServers takes mcp.json server names.
    settings.disabledMcpjsonServers = ['mcp-search'];

    // Merge global enabledPlugins (from real ~/.claude/settings.json) so plugins work with HOME=sessionDir
    try {
      const globalSettingsPath = path.join(process.env.HOME || '', '.claude', 'settings.json');
      const globalSettings = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf-8'));
      if (globalSettings.enabledPlugins) {
        settings.enabledPlugins = globalSettings.enabledPlugins;
      }
    } catch { /* no global settings or parse error */ }

    return settings;
  }

  /**
   * Resolve all template variables for a session
   */
  private resolveVariables(sessionKey: string, sessionDir: string): Record<string, string> {
    const port = this.allocatePort(sessionKey);

    const vars: Record<string, string> = {
      ...this.config.defaults,
      ...(this.config.sessions[sessionKey] || {}),
      SESSION_KEY: sessionKey,
      SESSION_DIR: sessionDir,
      CHROME_PORT: String(port),
      HOME: process.env.HOME || '',
      PROJECT_ROOT: path.dirname(this.sessionsDir),
      TUNNEL_BASE_URL: process.env.CF_TUNNEL_URL || '',
      RELAY_TOKEN: createHmac('sha256', process.env.RELAY_SECRET || 'sigma-relay-default-secret').update(sessionKey).digest('hex'),
    };

    // Add Feishu app credentials from process env (for feishu-im shared MCP)
    if (process.env.FEISHU_APP_ID) vars.FEISHU_APP_ID = process.env.FEISHU_APP_ID;
    if (process.env.FEISHU_APP_SECRET) vars.FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;

    // Load per-session MCP URLs from config files in session directory
    const feishuMcpUrlFile = path.join(sessionDir, 'feishu-mcp-url');
    try {
      if (fs.existsSync(feishuMcpUrlFile)) {
        vars.FEISHU_MCP_URL = fs.readFileSync(feishuMcpUrlFile, 'utf-8').trim();
      }
    } catch { /* ignore */ }

    return vars;
  }

  /**
   * Check if a rendered MCP config still contains unresolved {VAR} placeholders
   */
  private hasUnresolvedVars(rendered: any): boolean {
    const check = (s: string) => /\{[A-Z_]+\}/.test(s);
    if (rendered.url && check(rendered.url)) return true;
    if (rendered.command && check(rendered.command)) return true;
    if (rendered.args?.some((a: string) => check(a))) return true;
    if (rendered.env) {
      for (const v of Object.values(rendered.env)) {
        if (typeof v === 'string' && check(v)) return true;
      }
    }
    return false;
  }

  /**
   * Replace {VAR} placeholders in a template
   */
  private renderTemplate(template: McpServerTemplate, vars: Record<string, string>): any {
    const render = (s: string): string =>
      s.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);

    const result: any = {};
    if (template.url) result.url = render(template.url);
    if (template.command) result.command = render(template.command);
    if (template.args) result.args = template.args.map(render);
    if (template.env) {
      result.env = {};
      for (const [k, v] of Object.entries(template.env)) {
        result.env[k] = render(v);
      }
    }
    return result;
  }

  /**
   * Allocate a fixed port for a session (persisted across restarts)
   */
  private allocatePort(sessionKey: string): number {
    const existing = this.portAllocations.get(sessionKey);
    if (existing) return existing;

    // Find next available port
    const usedPorts = new Set(this.portAllocations.values());
    let port = PORT_BASE;
    while (usedPorts.has(port)) {
      port++;
    }

    this.portAllocations.set(sessionKey, port);
    this.savePortAllocations();

    // Also write .chrome-port file in session dir
    const sessionDir = path.join(this.sessionsDir, sessionKey);
    try {
      fs.writeFileSync(path.join(sessionDir, PORT_FILE), String(port));
    } catch {
      // Session dir might not exist yet
    }

    this.logger.info({ sessionKey, port }, 'Allocated Chrome port');
    return port;
  }

  private loadConfig(): McpConfig {
    const defaults: McpConfig = {
      defaults: {},
      sharedMcp: {},
      isolatedMcp: {},
      sessionMcp: {},
      sharedSkills: [],
      sessionSkills: {},
      sessions: {},
    };

    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const loaded = JSON.parse(raw);
        const config = { ...defaults, ...loaded };

        // Resolve runtime path placeholders in defaults
        const nodeBinDir = path.dirname(process.execPath);
        if (config.defaults.NPX_PATH === '__NPX_PATH__') {
          config.defaults.NPX_PATH = path.join(nodeBinDir, 'npx');
        }
        if (config.defaults.NODE_PATH === '__NODE_PATH__') {
          config.defaults.NODE_PATH = nodeBinDir;
        }

        return config;
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load mcp-config.json, using defaults');
    }

    return defaults;
  }

  private loadPortAllocations(): void {
    try {
      if (fs.existsSync(this.portAllocPath)) {
        const raw = fs.readFileSync(this.portAllocPath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, number>;
        for (const [key, port] of Object.entries(data)) {
          this.portAllocations.set(key, port);
        }
        this.logger.debug({ count: this.portAllocations.size }, 'Loaded port allocations');
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load port allocations');
    }
  }

  private savePortAllocations(): void {
    try {
      const data: Record<string, number> = {};
      for (const [key, port] of this.portAllocations) {
        data[key] = port;
      }
      fs.writeFileSync(this.portAllocPath, JSON.stringify(data, null, 2));
    } catch (err) {
      this.logger.warn({ err }, 'Failed to save port allocations');
    }
  }
}
