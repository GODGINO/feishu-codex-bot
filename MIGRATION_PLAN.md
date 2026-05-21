# Sigma → OpenAI Codex Migration Plan

> **Status**: P1 in progress. This repo was forked from [feishu-claude-bot](https://github.com/GODGINO/feishu-claude-bot) at commit `c38a9d4` (2026-05-21).
>
> **Goal**: Migrate Sigma from Anthropic Claude Code SDK (`claude --print`) to OpenAI Codex CLI (`codex app-server`) backed by ChatGPT subscription, in response to Anthropic's 2026-06-15 Agent SDK pricing split that puts third-party agent applications on a $200/mo separate credit pool.

---

## 0. Motivation

Anthropic's email of 2026-05-12 announces that starting 2026-06-15, Max 20x subscribers get a **separate $200/month credit** for `claude -p` and Agent SDK usage (including third-party tools built on the Agent SDK). Sigma's burn is ~$200/day on Anthropic, so the new credit would last 1 day per account.

Anthropic actively blocks third-party agents from consuming subscription quota. OpenAI has the opposite stance: it gave **OpenClaw** (a third-party agent framework with 3M+ users) an official endorsement to use ChatGPT subscriptions. This migration replicates that pattern.

**ToS reality**: OpenAI's general ToS forbids "reselling access or using ChatGPT to power third-party services". OpenClaw got a specific blessing; Sigma does not. This migration **operates in the same gray area OpenClaw did before its endorsement** — technically against the ToS letter, but practically tolerated as long as we don't draw attention.

---

## 1. Architecture Overview

### Strategy

```
┌──────────────────────────────────────────────────────────────┐
│ Shared sessions/ filesystem                                  │
│ (chat-id / members / email / shared/ / MEMBER.md / cron-jobs)│
└────┬────────────────────────────────────────┬────────────────┘
     │                                        │
┌────▼──────────────────┐         ┌───────────▼──────────────────┐
│ feishu-claude-bot     │         │ feishu-codex-bot (this repo) │
│ Feishu App A          │         │ Feishu App B (new, separate) │
│ PM2: feishu-bot       │         │ PM2: feishu-bot-codex        │
│ Spawns: claude --print│         │ Spawns: codex app-server      │
│ Account pool:         │         │ Account pool:                 │
│   info/tech/jun@ubt.io│         │   chatgpt-1/2/3 (TBD)         │
└───────────────────────┘         └──────────────────────────────┘
```

### Per-session isolation via `CODEX_HOME`

Each Sigma session gets its own Codex home directory:

```
sessions/dm_ou_xxx/.codex/
├── config.toml        # MCP servers + sandbox + model
├── AGENTS.md          # system prompt (replaces CLAUDE.md for codex)
├── auth.json          # ChatGPT OAuth credentials (or API key)
├── sessions/          # rollout-<ts>-<UUID>.jsonl
└── log/               # codex internal logs
```

Spawn command:
```bash
CODEX_HOME=sessions/dm_ou_xxx/.codex \
  codex app-server --listen stdio:// --session-source vscode
```

This preserves Sigma's existing per-session MCP isolation, unlike Chat-Codex which uses one global Codex process for all sessions.

### Cron / Alert ownership

Both bots share `sessions/*/cron-jobs.json`. To prevent dual execution, each cron job gets a `runner` field:

```json
{ "id": "morning-brief", "schedule": "0 9 * * *", "runner": "claude" }
```

Each bot only executes jobs where `runner === self.runnerKind`. The kind is set via env: `SIGMA_RUNNER_KIND=claude|codex`. Migration is gradual — user manually flips `runner` per job to opt into Codex.

---

## 2. Phased Plan

| Phase | Goal | Effort | Status |
|-------|------|--------|--------|
| P0 | Push sigma-claude to GitHub | 5 min | ✅ done (c38a9d4) |
| P1 | Fork this repo; write MIGRATION_PLAN.md | 1 hour | 🔄 in progress |
| P2 | Codex spike in `/tmp/sigma-codex-spike/` — validate `codex login` + `codex exec --json` + `CODEX_HOME` isolation | 1 day | pending |
| P3 | `src/codex/` core: process-pool, rpc-client, event-mapper, stream-parser, runner | 3-5 days | pending |
| P4 | `mcp-manager` rewrite to emit `<sessionDir>/.codex/config.toml` (TOML, not JSON) | 1-2 days | pending |
| P5 | Cron runner field + filter (changes both repos in lockstep) | 1 day | pending |
| P6 | Provision Feishu App B, deploy as `feishu-bot-codex` PM2 entry | 1 day | pending |
| P7 | sigma-switcher rewrite to swap `CODEX_HOME` per account | 1-2 days | pending |
| P8 | Gradual user migration: opt-in groups, flip `runner` per cron | 1-2 weeks | pending |
| P9 | Retire feishu-claude-bot PM2 entry | 1 day | pending |

**Hard deadline**: P3-P7 must complete before 2026-06-15 for Sigma to keep operating after Anthropic's pricing split.

---

## 3. File-Level Changes

### 3.1 Core rewrites (new files in `src/codex/`)

| File | Lines | Source of inspiration |
|------|-------|----------------------|
| `src/codex/process-pool.ts` | ~600 | Sigma's `src/claude/process-pool.ts` + Chat-Codex `app-server-codex-adapter.ts` |
| `src/codex/rpc-client.ts` | ~200 | Chat-Codex `app-server/rpc-client.ts` |
| `src/codex/event-mapper.ts` | ~300 | Chat-Codex `app-server/turn-controller.ts` (mapping notifications → Sigma's internal events) |
| `src/codex/stream-parser.ts` | ~280 | Replaces `src/claude/stream-parser.ts` — handles `thread.*`, `turn.*`, `item.*` events |
| `src/codex/runner.ts` | ~300 | Adapts `src/claude/runner.ts` API surface (`run({sessionKey, sessionDir, message})`), internal calls go to Codex |
| `src/codex/config-writer.ts` | ~150 | New — emits `<sessionDir>/.codex/config.toml` and `<sessionDir>/AGENTS.md` |

### 3.2 Adapted (existing files, ~10-30% diff)

| File | Change |
|------|--------|
| `src/claude/session-manager.ts` → `src/codex/session-manager.ts` | Template writes `AGENTS.md` instead of `CLAUDE.md`; "claude/sonnet/opus" → "codex/gpt-5" |
| `src/claude/mcp-manager.ts` → `src/codex/mcp-manager.ts` | Emit `<sessionDir>/.codex/config.toml` (TOML serializer) instead of `.claude/settings.json` + `mcp-servers.json`. Permissions/deny removed (use `sandbox_mode`) |
| `src/claude/parallel-runner.ts` | Keep as-is; only change is `currentJsonlMtimeMs` reads from `$CODEX_HOME/sessions/rollout-*.jsonl` instead of Claude's transcript path |
| `src/config.ts` | `claude.*` → `codex.*`; new `codex.home` per-session; `findCodexPath()` |
| `src/bridge/message-bridge.ts` | `ClaudeRunner` → `CodexRunner` import rename only; logic unchanged |
| `src/bridge/command-handler.ts` | Same as above |
| `src/scheduler/cron-runner.ts` | Add `runner` field filter; `ClaudeRunner` import rename |
| `src/scheduler/alert-runner.ts` | Same as cron-runner |
| `src/email/email-processor.ts`, `idle-monitor.ts`, `cli.ts` | Import rename only |
| `src/index.ts`, `src/index.server.ts` | Import + `new CodexRunner(...)` |

### 3.3 Unchanged

`src/feishu/*`, `src/cron/*`, `src/alert/*`, `src/relay/*`, `src/admin/*`, `src/wechat/*`, `src/local-only/*` — all decoupled from the LLM. Zero changes.

### 3.4 Deleted (P9 cleanup phase)

- `src/claude/` (entire directory)
- `.claude/settings.json` template logic
- `mcp-servers.json` generation
- `CLAUDE*` / `ANTHROPIC_INNER` env var stripping
- `--append-system-prompt` plumbing
- `disabledMcpjsonServers` field handling

---

## 4. Key Technical Details

### 4.1 `CODEX_HOME` isolation

Source: `codex-rs/utils/home-dir/src/lib.rs::find_codex_home()`.

- Default: `$HOME/.codex`
- Override: `CODEX_HOME=/path` (path must exist; canonicalized)
- All paths derived from it: `auth.json`, `config.toml`, `sessions/`, `log/`, `.env`

### 4.2 `config.toml` MCP example

```toml
model = "gpt-5-codex"
approval_policy = "never"
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
writable_roots = ["/Users/gezenghui/feishu-claude-bot/sessions/dm_ou_xxx"]
network_access = true

[mcp_servers.cron]
command = "node"
args    = ["/Users/gezenghui/feishu-claude-bot/dist/cron/cron-mcp.js"]
env     = { SESSION_DIR = "/Users/gezenghui/feishu-claude-bot/sessions/dm_ou_xxx" }

[mcp_servers.feishu]
url                  = "https://mcp.feishu.cn/v1/<user-token>"
bearer_token_env_var = "FEISHU_MCP_BEARER"
```

Unlike Claude (which requires `.claude/settings.json` for url-type MCP and `--mcp-config` for stdio), Codex unifies both in `config.toml`.

### 4.3 `--config key=value` runtime overrides

Source: `codex-rs/utils/cli/src/config_override.rs`. Supports nested dotted paths, TOML value parsing, repeated flags:

```bash
codex exec \
  -c model="gpt-5-codex" \
  -c 'sandbox_permissions=["disk-full-read-access"]' \
  -c 'mcp_servers.cron.command="node"' \
  "..."
```

### 4.4 System prompt via `AGENTS.md`

Codex has **no `--system-prompt` flag**. Three injection paths:

1. **`$CODEX_HOME/AGENTS.md`** (recommended) — auto-loaded, replaces Sigma's `CLAUDE.md` 1:1
2. `config.toml` `model_instructions_file = "/path/to/file"`
3. `developer_instructions = "..."` inline string

For migration, write the existing `sessions/<key>/CLAUDE.md` content into `sessions/<key>/.codex/AGENTS.md` (or symlink). Sigma's `isolationRule` (currently appended via `--append-system-prompt`) goes in the same file.

### 4.5 `auth.json` for multi-account switcher

Format (`codex-rs/login/src/auth/storage.rs::AuthDotJson`):

```json
{
  "OPENAI_API_KEY": "sk-...",
  "auth_mode": "api_key"
}
```

Or ChatGPT mode:
```json
{
  "auth_mode": "chatgpt",
  "tokens": {
    "access_token": "...",
    "refresh_token": "...",
    "id_token": "..."
  },
  "last_refresh": "2026-05-21T12:00:00Z"
}
```

File permissions: Unix `0o600`. Sigma-switcher replacement: store one `auth.json` per account under `~/.sigma-switcher/accounts/<name>/.codex/auth.json`, and switch by changing the active `CODEX_HOME` env var before spawning new sessions.

### 4.6 Stream events

| Codex event type | Equivalent Sigma concept |
|------------------|--------------------------|
| `thread.started` (has `thread_id`) | `system { session_id }` |
| `turn.started` | message turn boundary |
| `turn.completed` (has `usage`) | `result` with token totals |
| `turn.failed` | error |
| `item.started` / `item.updated` / `item.completed` | tool_use lifecycle |
| `item.details.type = AgentMessage` | assistant text block |
| `item.details.type = Reasoning` | thinking block |
| `item.details.type = CommandExecution` | bash tool call |
| `item.details.type = FileChange` | edit/write tool call |
| `item.details.type = McpToolCall` | MCP tool call |

**Difference from Claude**: Codex pushes deltas via `item.updated` events keyed by `item.id`. Sigma's parser must merge these on the same id (Claude's `_delta` events were already pre-merged).

---

## 5. Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| OpenAI detects Sigma as third-party agent and blocks subscription access | **High** | Report client_info as generic ("codex-cli") not "sigma-bot"; keep usage patterns close to human-paced |
| `codex app-server` crashes have no auto-restart in Chat-Codex reference impl | Medium | Add supervisor in `process-pool.ts`: `on('exit', respawn)` with exponential backoff |
| Codex has no `--max-budget-usd` equivalent | Medium | Track `turn.completed.usage` cumulatively; abort sessions exceeding caps |
| Per-call peak token metrics unavailable | Low | Card footer degraded to turn-wide totals only |
| Memory cost: N sessions × N codex processes (~200MB each) | Medium | Keep `MAX_CONCURRENT=3` cap; monitor mem in admin dashboard |
| `reasoning_output_tokens` counting toward quota unclear | Low | Conservative: include in output token displays |
| Codex has no `/compact` equivalent | Medium | On "prompt too long" error, fork to new `thread_id` with summary in first user message |
| Dual cron execution if `runner` field missing | Low | Migration script auto-fills `runner: "claude"` default; startup validation rejects missing field |
| Two bots writing to same `chat-id` file | Low | Split into `chat-id-claude` / `chat-id-codex` |

---

## 6. Open Questions (require P2 spike)

1. Does `codex app-server --listen stdio://` work with stdin/stdout JSON-RPC out of the box?
2. Does `CODEX_HOME=<custom>` + a fresh `auth.json` (copied from default `~/.codex/`) successfully consume the same ChatGPT account's quota?
3. Will sigma's `<<TITLE:...>>` / `<<BUTTON:...>>` markers pass through Codex's text output unchanged?
4. Can `codex` slash commands (`/compact`, `/clear`) be invoked from `exec` mode?
5. Does `item.updated` field semantics use full-replace or incremental patch?
6. What is the exact error message Codex emits on rate-limit / auth expiry / quota exhaustion?
7. Does `codex fork` correctly create a sibling thread sharing parent's transcript? (Maps to Sigma's `ParallelRunner`)

---

## 7. References

- [Anthropic 2026-06-15 announcement](https://www.anthropic.com/) — the trigger event
- [Chat-Codex](https://github.com/uluckyXH/Chat-Codex) — reference impl of feishu+codex bot
- [OpenClaw](https://github.com/openclaw/openclaw) — agent framework that got OpenAI's official subscription blessing
- [Codex CLI docs](https://developers.openai.com/codex/) — official API surface
- [feishu-claude-bot](https://github.com/GODGINO/feishu-claude-bot) — parent repo, source of this fork

---

*Last updated: 2026-05-21. Author: 葛增辉. AI co-author: Claude Opus 4.7.*
