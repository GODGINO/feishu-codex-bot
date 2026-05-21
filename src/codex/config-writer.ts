import * as fs from 'node:fs';
import * as path from 'node:path';

export type McpServerSpec = StdioMcpSpec | StreamableHttpMcpSpec;

export interface StdioMcpSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface StreamableHttpMcpSpec {
  url: string;
  bearerTokenEnvVar?: string;
  httpHeaders?: Record<string, string>;
}

export interface SessionCodexConfig {
  /** Absolute path of the session's working directory (also writable_roots). */
  sessionDir: string;
  /** Model slug — defaults to "gpt-5.5". */
  model?: string;
  /** MCP server configs (object form, serialized to TOML tables). */
  mcpServers?: Record<string, McpServerSpec>;
  /** If true, mark sessionDir as `trust_level = "trusted"` so codex skips trust prompt. */
  trustWorkdir?: boolean;
}

/** Write `$CODEX_HOME/config.toml`. Creates the directory if missing. */
export function writeSessionConfig(codexHome: string, cfg: SessionCodexConfig): void {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), buildConfigToml(cfg));
}

/** Write `$CODEX_HOME/AGENTS.md`. Caller decides the content. */
export function writeAgentsMd(codexHome: string, content: string): void {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), content);
}

/** Build the TOML body for `$CODEX_HOME/config.toml`. */
export function buildConfigToml(cfg: SessionCodexConfig): string {
  const model = cfg.model ?? 'gpt-5.5';
  const lines: string[] = [];

  lines.push(`model = ${tomlString(model)}`);
  lines.push(`approval_policy = "never"`);
  lines.push(`sandbox_mode = "workspace-write"`);
  lines.push('');
  lines.push(`[sandbox_workspace_write]`);
  lines.push(`writable_roots = [${tomlString(cfg.sessionDir)}]`);
  lines.push(`network_access = true`);
  lines.push('');

  if (cfg.trustWorkdir !== false) {
    lines.push(`[projects.${tomlString(cfg.sessionDir)}]`);
    lines.push(`trust_level = "trusted"`);
    lines.push('');
  }

  for (const [name, spec] of Object.entries(cfg.mcpServers ?? {})) {
    lines.push(`[mcp_servers.${tomlKey(name)}]`);
    if ('command' in spec) {
      lines.push(`command = ${tomlString(spec.command)}`);
      if (spec.args) lines.push(`args = ${tomlArray(spec.args)}`);
      if (spec.env) lines.push(`env = ${tomlInlineTable(spec.env)}`);
      if (spec.cwd) lines.push(`cwd = ${tomlString(spec.cwd)}`);
    } else {
      lines.push(`url = ${tomlString(spec.url)}`);
      if (spec.bearerTokenEnvVar) lines.push(`bearer_token_env_var = ${tomlString(spec.bearerTokenEnvVar)}`);
      if (spec.httpHeaders) lines.push(`http_headers = ${tomlInlineTable(spec.httpHeaders)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlKey(k: string): string {
  // bare key allowed iff matches [A-Za-z0-9_-]+; otherwise quote it
  if (/^[A-Za-z0-9_-]+$/.test(k)) return k;
  return tomlString(k);
}

function tomlArray(arr: string[]): string {
  return `[${arr.map(tomlString).join(', ')}]`;
}

function tomlInlineTable(t: Record<string, string>): string {
  const parts = Object.entries(t).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`);
  return `{ ${parts.join(', ')} }`;
}
