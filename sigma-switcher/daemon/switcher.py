#!/usr/bin/env python3
"""Sigma Claude Switcher — main daemon (round-robin + cooldown skip)."""
import json, time, re, os, sys, threading, subprocess
from datetime import datetime, timedelta
import yaml, requests
from pathlib import Path
from imap_tools import MailBox

sys.path.insert(0, str(Path(__file__).parent))
import server as srv

ROOT = Path(__file__).parent

# Load yaml config if present (non-sensitive defaults). Sensitive fields
# (IMAP credentials, account list, webhook URL) should come from env vars
# so they live in .env alongside FEISHU_APP_SECRET etc. — never in yaml.
CFG_PATH = ROOT / 'config.yaml'
CFG = yaml.safe_load(open(CFG_PATH)) if CFG_PATH.exists() else {}

def env_override(cfg, path, env_key, cast=str):
    """Override a nested config value with an env var if present."""
    val = os.environ.get(env_key)
    if val is None or val == '':
        return
    try:
        val = cast(val)
    except Exception:
        return
    # Navigate / create the nested dict
    cur = cfg
    for key in path[:-1]:
        cur = cur.setdefault(key, {})
    cur[path[-1]] = val

# Non-sensitive numeric / string overrides
env_override(CFG, ['threshold'], 'SWITCHER_THRESHOLD', int)
env_override(CFG, ['check_interval_seconds'], 'SWITCHER_CHECK_INTERVAL', int)
env_override(CFG, ['cooldown_hours'], 'SWITCHER_COOLDOWN_HOURS', float)
env_override(CFG, ['http_port'], 'SWITCHER_HTTP_PORT', int)

# IMAP settings — password is sensitive, user/host less so but still PII
env_override(CFG, ['imap', 'host'], 'SWITCHER_IMAP_HOST')
env_override(CFG, ['imap', 'port'], 'SWITCHER_IMAP_PORT', int)
env_override(CFG, ['imap', 'user'], 'SWITCHER_IMAP_USER')
env_override(CFG, ['imap', 'password'], 'SWITCHER_IMAP_PASSWORD')
env_override(CFG, ['imap', 'poll_interval_seconds'], 'SWITCHER_IMAP_POLL_INTERVAL', int)
env_override(CFG, ['imap', 'poll_timeout_seconds'], 'SWITCHER_IMAP_POLL_TIMEOUT', int)
env_override(CFG, ['imap', 'scan_recent'], 'SWITCHER_IMAP_SCAN_RECENT', int)

# Feishu webhook (sensitive — contains secret token)
env_override(CFG, ['feishu_webhook'], 'SWITCHER_FEISHU_WEBHOOK')

# Accounts — env var `SWITCHER_ACCOUNTS` takes precedence, formatted as JSON:
#   SWITCHER_ACCOUNTS='[{"email":"a@x.com","label":"Max-A"},{"email":"b@x.com","label":"Max-B"}]'
_accts_env = os.environ.get('SWITCHER_ACCOUNTS')
if _accts_env:
    try:
        CFG['accounts'] = json.loads(_accts_env)
    except Exception as e:
        print(f'[warn] SWITCHER_ACCOUNTS is not valid JSON, falling back to yaml: {e}', flush=True)

# Baseline defaults if nothing else provided
CFG.setdefault('threshold', 90)
CFG.setdefault('check_interval_seconds', 120)          # 2 min — faster reaction to weekly 100% and session hits
CFG.setdefault('cooldown_hours', 5)                    # default cooldown when trigger is "Current session" (5h rolling)
CFG.setdefault('weekly_cooldown_hours', 168)           # 7-day fallback if we can't parse the DOM reset time
CFG.setdefault('cli_login_retries', 3)                 # OAuth login retry attempts when CLI fails to log in (browser already has new session)
env_override(CFG, ['weekly_cooldown_hours'], 'SWITCHER_WEEKLY_COOLDOWN_HOURS', float)
env_override(CFG, ['cli_login_retries'], 'SWITCHER_CLI_LOGIN_RETRIES', int)
CFG.setdefault('http_port', 17222)
CFG.setdefault('accounts', [])
CFG.setdefault('feishu_webhook', '')
CFG.setdefault('imap', {}).setdefault('magic_link_regex', r'https://claude\.ai/magic-link#[a-f0-9]+:[A-Za-z0-9+/=]+')
CFG['imap'].setdefault('poll_interval_seconds', 5)
# Default 2 minutes — legacy default before magic-link retry logic was added; the
# real per-attempt timeout is CFG['magic_link']['per_attempt_timeout_seconds']=60s.
# This value is a ceiling for direct fetch_magic_link callers that don't pass timeout.
CFG['imap'].setdefault('poll_timeout_seconds', 120)
# Magic-link resend retry: forwarding occasionally drops a single delivery. Resend
# the magic link up to N times with a short per-attempt timeout. If all attempts
# exhaust, perform_switch raises MagicLinkExhausted and main_loop tries the next
# account in the same iteration.
CFG.setdefault('magic_link', {})
CFG['magic_link'].setdefault('per_attempt_timeout_seconds', 60)
CFG['magic_link'].setdefault('max_attempts', 5)
env_override(CFG, ['magic_link', 'per_attempt_timeout_seconds'], 'SWITCHER_MAGIC_LINK_ATTEMPT_TIMEOUT', int)
env_override(CFG, ['magic_link', 'max_attempts'], 'SWITCHER_MAGIC_LINK_MAX_ATTEMPTS', int)
CFG['imap'].setdefault('scan_recent', 30)
CFG.setdefault('paths', {}).setdefault('state_file', '~/.sigma-switcher/state.json')
CFG['paths'].setdefault('log_file', '~/.sigma-switcher/logs/switcher.log')

# Fail fast if required sensitive fields are missing
_missing = []
if not CFG['accounts']: _missing.append('accounts (SWITCHER_ACCOUNTS)')
if not CFG['imap'].get('user'): _missing.append('imap.user (SWITCHER_IMAP_USER)')
if not CFG['imap'].get('password'): _missing.append('imap.password (SWITCHER_IMAP_PASSWORD)')
if not CFG['imap'].get('host'): _missing.append('imap.host (SWITCHER_IMAP_HOST)')
if _missing:
    print(f'[fatal] Missing required config: {", ".join(_missing)}', flush=True)
    print(f'        Set via .env or {CFG_PATH}', flush=True)
    sys.exit(1)

# Minimum interval between two switches (anti ping-pong throttle, post user
# policy that removed 5h/weekly cooldowns). Pure rotation otherwise.
MIN_SWITCH_INTERVAL_S = 300

STATE_FILE = Path(os.path.expanduser(CFG['paths']['state_file']))
LOG_FILE = Path(os.path.expanduser(CFG['paths']['log_file']))
LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
LINK_RE = re.compile(CFG['imap']['magic_link_regex'])

def log(msg):
    line = f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] {msg}'
    print(line, flush=True)
    with open(LOG_FILE, 'a') as f: f.write(line + '\n')

def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {'current': CFG['accounts'][0]['email'], 'cooldowns': {}, 'switch_count': 0}

def save_state(st): STATE_FILE.write_text(json.dumps(st, indent=2))

def notify(msg):
    log(msg)
    hook = CFG.get('feishu_webhook')
    if hook:
        try: requests.post(hook, json={'msg_type':'text','content':{'text':f'[Switcher] {msg}'}}, timeout=5)
        except Exception as e: log(f'feishu notify failed: {e}')

def cmd(type_, wait=60, **kwargs):
    return srv.enqueue({'type': type_, **kwargs}, wait_timeout=wait)

# ─── IMAP ─────────────────────────────────────
def fetch_magic_link(target_email, after_timestamp=None, timeout=None):
    """Poll IMAP until a magic-link email for target_email arrives.

    Loop each `poll_interval_seconds` until `poll_timeout_seconds` elapses.
    With email-forwarding chains (Claude → real account → auto-forward → aggregator),
    arrival can take 30s-5min — default timeout is 10min to cover that.
    Logs a heartbeat every 30s so the log shows progress.
    """
    timeout = timeout or CFG['imap']['poll_timeout_seconds']
    start = time.time()
    deadline = start + timeout
    interval = CFG['imap']['poll_interval_seconds']
    log(f'  IMAP polling for magic link → {target_email} (timeout={timeout}s, interval={interval}s)')
    last_heartbeat = start
    attempts = 0
    considered_count = 0  # emails matched from=anthropic but failed other filters
    while time.time() < deadline:
        attempts += 1
        try:
            with MailBox(CFG['imap']['host'], CFG['imap']['port']).login(
                    CFG['imap']['user'], CFG['imap']['password']) as mb:
                msgs = list(mb.fetch('ALL', limit=CFG['imap']['scan_recent'],
                                     reverse=True, mark_seen=False, bulk=True))
                for m in msgs:
                    if 'anthropic.com' not in (m.from_ or '').lower(): continue
                    if 'claude.ai' not in (m.subject or '').lower(): continue
                    considered_count += 1
                    # Check To + Cc + Bcc (forwarded mails often land in Cc only)
                    # imap_tools returns these as tuples; use () default so + works
                    recipients = ','.join((m.to or ()) + (m.cc or ()) + (m.bcc or ())).lower()
                    if target_email.lower() not in recipients: continue
                    # Skip old emails if we have a baseline timestamp (anti-replay)
                    if after_timestamp:
                        msg_ts = m.date.timestamp() if m.date else 0
                        if msg_ts < after_timestamp: continue
                    body = (m.text or '') + (m.html or '')
                    mt = LINK_RE.search(body)
                    if not mt: continue
                    elapsed = int(time.time() - start)
                    log(f'  ✓ magic link found after {elapsed}s (attempt #{attempts}, UID={m.uid}): {mt.group(0)[:80]}…')
                    return mt.group(0)
        except Exception as e:
            log(f'  IMAP error (attempt #{attempts}): {e}')
        # Heartbeat: every 30s, tell the log we're still waiting + what we saw
        now = time.time()
        if now - last_heartbeat >= 30:
            elapsed = int(now - start)
            remaining = int(deadline - now)
            log(f'  ⏳ still polling... {elapsed}s elapsed, {remaining}s left (saw {considered_count} anthropic mails, none matched {target_email})')
            last_heartbeat = now
        time.sleep(interval)
    elapsed = int(time.time() - start)
    raise TimeoutError(f'No magic link for {target_email} within {elapsed}s (saw {considered_count} anthropic mails total — check forwarding config)')

# ─── Limit classification ────────────────────
# Weekly limits reset on Friday 4PM (per usage page). Session rolls every 5h.
WEEKLY_LIMIT_LABELS = ('all models', 'sonnet only', 'opus only', 'haiku only',
                       'claude design', 'claude code', 'weekly')
SESSION_LIMIT_LABEL = 'current session'

def is_weekly_trigger(label):
    """True if the dominant limit is a weekly bucket (needs ~week-long cooldown)."""
    if not label: return False
    lc = label.lower()
    return any(w in lc for w in WEEKLY_LIMIT_LABELS)

def cooldown_hours_for(label):
    """Cooldown duration in hours based on which limit triggered the switch."""
    if is_weekly_trigger(label):
        return CFG['weekly_cooldown_hours']
    return CFG['cooldown_hours']


def classify_limit(lim):
    """Return (kind, cooldown_hours). kind in {'weekly', 'session'}.

    Unknown label at pct>=100 is treated as weekly — Claude likely renamed a
    section header. A genuine session limit reading 100% is rare (session
    triggers at 90 and usually switches before saturation), whereas weekly
    hitting 100 is the normal saturation state. Erring on 168h is safer:
    if we're wrong we lose a 5h-recoverable account for longer, but at least
    we don't ping-pong to a still-saturated account every 5h.
    """
    label = lim.get('label', '') or ''
    pct = lim.get('pct_int', 0)
    if is_weekly_trigger(label):
        return 'weekly', CFG['weekly_cooldown_hours']
    if pct >= 100 and 'current session' not in label.lower():
        return 'weekly', CFG['weekly_cooldown_hours']
    return 'session', CFG['cooldown_hours']


def effective_trigger(limits):
    """Decide whether any single limit crosses its per-kind trigger rule.

    Rules:
      - Weekly limits (All models / Sonnet only / etc.) only trigger at pct >= 100.
        At 90-99% there's still useful headroom, so we don't burn a switch early.
      - Session limit ("Current session") triggers at SWITCHER_THRESHOLD (default 90).

    When multiple limits trigger in the same probe, pick the highest-pct one
    (with weekly winning ties — weekly is harder to recover from, so its
    cooldown semantics should dominate).

    Returns the chosen limit dict, or None if nothing triggers.
    """
    if not limits:
        return None
    triggered = []
    for lim in limits:
        pct = lim.get('pct_int', 0)
        if is_weekly_trigger(lim.get('label', '')):
            if pct >= 100:
                triggered.append(lim)
        else:
            if pct >= CFG['threshold']:
                triggered.append(lim)
    if not triggered:
        return None
    return max(triggered, key=lambda l: (l.get('pct_int', 0), is_weekly_trigger(l.get('label', ''))))

_DOW_MAP = {'mon':0, 'tue':1, 'wed':2, 'thu':3, 'fri':4, 'sat':5, 'sun':6}
_RESETS_RE = re.compile(r'Resets?\s+(\w{3,})\s+(\d{1,2}):(\d{1,2})\s*(AM|PM)', re.I)

def parse_reset_timestamp(text):
    """Parse 'Resets Fri 3:59 PM' → unix timestamp of the NEXT occurrence in local tz.

    Local timezone = whatever `datetime.now()` returns (Mac's system tz, Beijing
    per your setup). Claude.ai formats the reset time in the browser's detected
    timezone, which is the same tz Chrome sees, so this matches.

    Returns None if unparseable.
    """
    if not text: return None
    m = _RESETS_RE.search(text)
    if not m: return None
    dow_str, hh, mm, ampm = m.groups()
    target_dow = _DOW_MAP.get(dow_str[:3].lower())
    if target_dow is None: return None
    hour = int(hh) % 12
    if ampm.upper() == 'PM': hour += 12
    minute = int(mm)
    now = datetime.now()
    days_ahead = (target_dow - now.weekday()) % 7
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0) + timedelta(days=days_ahead)
    # If target already passed today (e.g. today IS Fri and it's past 3:59 PM), push to next week
    if target <= now:
        target += timedelta(days=7)
    return target.timestamp()

# ─── Round-robin pick ────────────────────────
def pick_next(state):
    """Walk forward from current; skip accounts still in cooldown.

    Cooldown semantics: state['cooldowns'][email] stores a DEADLINE timestamp
    (Unix seconds). The account is reusable once now() >= deadline.
    Backward compat: old state files store a "start time"; those timestamps
    are all in the past, so they'll be treated as already-expired (safe).

    Phase 1: prefer ready next in round-robin order.
    Phase 2 (fallback): all in cooldown → pick earliest-expiring (closest to recovery).
    """
    accounts = CFG["accounts"]
    n = len(accounts)
    if n == 0: return None
    # Anti ping-pong throttle: refuse to switch if we already switched
    # less than MIN_SWITCH_INTERVAL_S ago (replaces the old 5h/weekly
    # cooldowns; user policy: 3 accounts rotate freely).
    last_switch = state.get("last_switch_ts", 0)
    if time.time() - last_switch < MIN_SWITCH_INTERVAL_S:
        return None
    emails = [a["email"] for a in accounts]
    try: cur_idx = emails.index(state["current"])
    except ValueError: cur_idx = -1
    now = time.time()
    # Phase 1: first ready-to-use account after current.
    # cooldowns dict is now only populated by MagicLinkExhausted (30min
    # short-cool for accounts whose magic-link mailbox is broken).
    for step in range(1, n + 1):
        i = (cur_idx + step) % n
        a = accounts[i]
        if a["email"] == state["current"]: continue
        deadline = state["cooldowns"].get(a["email"], 0)
        if now >= deadline:
            return a
    # All cooling — return None so caller can sleep until earliest wake.
    # (Previously: aggressive-switched to earliest-cooled account, which caused
    # infinite ping-pong when multiple accounts saturated on the same weekly
    # reset — every 120s a full OAuth chain was burned switching to a still-
    # saturated account.)
    return None

# ─── claude auth login (real Terminal.app) ───────────────────────
# Rationale: `claude auth login` inspects its stdin and, when attached to a real TTY,
# uses a localhost-callback OAuth flow that completes automatically after the user (or
# our extension) clicks Authorize. Under pexpect it falls back to a paste-code mode
# that waits silently on stdin for "<code>#<state>". Opening a real Terminal.app window
# side-steps that fallback and matches what a human would do.

CLAUDE_PATH = os.environ.get('CLAUDE_PATH', os.path.expanduser('~/.local/bin/claude'))


SWITCHER_TERMINAL_TITLE = 'Sigma Switcher'


def spawn_claude_auth_login_in_terminal():
    """Run `claude auth login` in the dedicated "Sigma Switcher" Terminal.app window.
    Reuses the window across switches (identified by its custom tab title) instead of
    opening a new window every time. Creates the window on first use."""
    if '"' in CLAUDE_PATH:
        raise RuntimeError(f'CLAUDE_PATH contains unsafe char: {CLAUDE_PATH!r}')
    cmd_str = f'{CLAUDE_PATH} auth login'
    apple_script = f'''
    tell application "Terminal"
        activate
        set targetWindow to missing value
        repeat with w in windows
            try
                if (custom title of selected tab of w) is "{SWITCHER_TERMINAL_TITLE}" then
                    set targetWindow to w
                    exit repeat
                end if
            end try
        end repeat
        if targetWindow is missing value then
            set newTab to do script "{cmd_str}"
            set custom title of newTab to "{SWITCHER_TERMINAL_TITLE}"
        else
            do script "{cmd_str}" in targetWindow
        end if
    end tell
    '''
    subprocess.Popen(['osascript', '-e', apple_script],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _kill_pending_claude_login():
    """Kill any lingering `claude auth login` process so the next spawn starts clean.
    Used between OAuth login retries — old CLI process may be stuck waiting on a
    callback that never came, blocking a new spawn from getting a fresh shell prompt."""
    try:
        subprocess.run(['pkill', '-f', f'{CLAUDE_PATH} auth login'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       check=False)
    except Exception as e:
        log(f'  pkill claude auth login failed (non-fatal): {e}')


def poll_claude_auth_status(target_email, timeout_s=120):
    """Poll `claude auth status` until it reports the target email logged in.
    The CLI returns JSON like {"loggedIn": true, "email": "...", ...}."""
    deadline = time.time() + timeout_s
    target = target_email.lower()
    while time.time() < deadline:
        try:
            out = subprocess.run([CLAUDE_PATH, 'auth', 'status'],
                                 capture_output=True, text=True, timeout=8)
            try:
                data = json.loads(out.stdout or '{}')
                if data.get('loggedIn') and (data.get('email', '').lower() == target):
                    return True
            except Exception:
                pass
        except Exception:
            pass
        time.sleep(3)
    return False


# ─── Switch flow ──────────────────────────────
class MagicLinkExhausted(Exception):
    """Raised when all magic-link resend attempts time out — caller should try a different account."""


def perform_switch(target_email):
    log(f'━━━ Switching to {target_email} ━━━')

    r = cmd('clear_claude_cookies', wait=15)
    log(f'  cleared cookies: {r}')

    max_attempts = CFG['magic_link']['max_attempts']
    per_attempt_timeout = CFG['magic_link']['per_attempt_timeout_seconds']
    link = None
    for attempt in range(1, max_attempts + 1):
        baseline_ts = time.time()  # fresh baseline each attempt → only accept emails from THIS resend
        log(f'  magic-link attempt {attempt}/{max_attempts} → re-submitting email')
        r = cmd('fill_email_and_continue', email=target_email, wait=30)
        if not r or not r.get('ok'):
            log(f'  fill_email failed on attempt {attempt}: {r}')
            if attempt < max_attempts:
                time.sleep(5)
                continue
            raise RuntimeError(f'fill_email kept failing after {max_attempts} attempts: {r}')
        try:
            link = fetch_magic_link(target_email, after_timestamp=baseline_ts, timeout=per_attempt_timeout)
            log(f'  ✓ magic link received on attempt {attempt}')
            break
        except TimeoutError as e:
            log(f'  ⏰ attempt {attempt} timed out: {e}')
            if attempt >= max_attempts:
                raise MagicLinkExhausted(
                    f'No magic link for {target_email} after {max_attempts} resend attempts '
                    f'(per-attempt timeout {per_attempt_timeout}s) — forwarding may be broken'
                )
            # else loop continues, fill_email_and_continue will resend
    if not link:
        raise MagicLinkExhausted(f'No magic link obtained for {target_email}')

    r = cmd('open_url', url=link, wait_url_match=r'claude\.ai(?!.*magic-link)', wait=45)
    log(f'  magic link visited: {r}')

    # Clean stale OAuth / usage tabs so click_authorize picks up the fresh OAuth tab.
    try: cmd('close_stale_tabs', wait=10)
    except Exception: pass

    # OAuth login retry loop: spawn CLI → click_authorize → poll status.
    # If CLI fails to log in (e.g. extension didn't see OAuth tab, CLI hung,
    # browser/CLI desync), kill the lingering CLI process and retry from spawn.
    # Browser already has the new account session — no need to redo magic-link.
    max_attempts = int(CFG.get('cli_login_retries', 3))
    last_click_result = None
    for attempt in range(1, max_attempts + 1):
        log(f'  CLI login attempt {attempt}/{max_attempts}')
        if attempt > 1:
            _kill_pending_claude_login()
            time.sleep(2)  # let pkill propagate before respawn

        log('  launching `claude auth login` in Terminal.app…')
        spawn_claude_auth_login_in_terminal()

        # CLI opens Chrome to the OAuth URL; poll click_authorize until it succeeds (the CLI
        # may take a couple of seconds to emit `open <url>`).
        click_deadline = time.time() + 60
        click_result = None
        while time.time() < click_deadline:
            click_result = cmd('click_authorize', wait=20)
            log(f'  click_authorize: ok={click_result and click_result.get("ok")} '
                f'method={click_result and click_result.get("method")} '
                f'error={click_result and click_result.get("error")}')
            if click_result and click_result.get('ok'):
                break
            time.sleep(2)
        last_click_result = click_result

        log('  polling `claude auth status` for new login…')
        if poll_claude_auth_status(target_email, timeout_s=120):
            log(f'  ✅ claude CLI logged in as {target_email} (attempt {attempt})')
            break
        log(f'  ⚠️ attempt {attempt} failed: claude CLI did not log in as {target_email} within 120s')
    else:
        # All attempts exhausted. Browser is on target_email but CLI is still on the old
        # account — inconsistent state. Caller (main_loop) handles notify + cooldown.
        raise RuntimeError(f'claude CLI did not log in as {target_email} after {max_attempts} attempts '
                           f'(last click_authorize={last_click_result}). '
                           f'⚠️ 浏览器已是 {target_email}, CLI 仍是旧账号，请人工处理')

    # Tidy up transient tabs (OAuth consent, magic-link landing, stale usage probes).
    try:
        cleanup = cmd('close_stale_tabs', wait=10)
        log(f'  closed stale tabs: {cleanup}')
    except Exception as e:
        log(f'  stale-tab cleanup skipped: {e}')

    # Navigate to /settings/usage so (1) user sees the new account's usage immediately,
    # (2) the next get_usage probe finds a pre-warmed tab instead of closing+reopening,
    # (3) extension popup shows a meaningful "open_url" status instead of "close_stale_tabs".
    try:
        nav = cmd('open_url', url='https://claude.ai/settings/usage', wait=20)
        log(f'  navigated to /settings/usage: {nav}')
    except Exception as e:
        log(f'  usage-page nav skipped (next get_usage will handle): {e}')
    return True

# ─── Usage parsing ────────────────────────────
def parse_usage(get_usage_result):
    """Return (pct_int, detail_dict) or ('NOT_LOGGED_IN', None) or (None, None).

    The usage page has multiple limit sections: Current session (5h rolling),
    Weekly All models (hard stop when 100%), Weekly Sonnet only, etc.
    Even when Current session is 0%, Weekly All models at 100% makes the
    account unusable. So switch on MAX of all limits, and log which one hit.
    """
    if not get_usage_result or not get_usage_result.get('ok'):
        return None, None
    data = get_usage_result.get('data', {})
    url = data.get('url', '')
    if '/login' in url or '/magic-link' in url:
        return 'NOT_LOGGED_IN', None

    # Primary: extension returned structured `limits` list with per-section pct
    limits = data.get('limits') or []
    if limits:
        max_pct = max((l.get('pct_int', 0) for l in limits), default=None)
        if max_pct is not None:
            return max_pct, {'limits': limits, 'dominant': data.get('dominant')}

    # Fallback: older shape with flat `pct` field (single aria-progressbar era)
    if isinstance(data.get('pct'), (int, float)):
        v = int(data['pct'])
        if 0 <= v <= 100:
            return v, {'dominant': 'legacy-aria'}

    # Last resort: legacy % text scan
    for label in data.get('labels', []):
        m = re.search(r'(\d{1,3})\s*%', label)
        if m:
            return int(m.group(1)), {'dominant': 'legacy-label'}
    pcts = []
    for h in data.get('hits', []):
        m = re.search(r'(\d{1,3})\s*%', h.get('text', ''))
        if m:
            v = int(m.group(1))
            if 0 <= v <= 100: pcts.append(v)
    if pcts:
        return max(pcts), {'dominant': 'legacy-scan'}
    return None, None

# ─── Main loop ────────────────────────────────
def _format_limits(detail):
    """Render the limits breakdown for log/notification."""
    if not detail or not detail.get('limits'):
        return detail.get('dominant') or '?'
    parts = [f"{l.get('label','?')}={l.get('pct_int',0)}%" for l in detail['limits']]
    return ', '.join(parts)

# Serializes the extension command queue so a manually-triggered switch
# (POST /trigger_switch) never interleaves with main_loop's periodic polls.
action_lock = threading.Lock()


def triggered_switch(email, cooldown_hours=None):
    """Entry point registered with server for POST /trigger_switch.

    Cooldown semantics (post-fix): cooldowns[X] = X's 5h rolling deadline,
    set when X is *activated* — so prev_email is naturally still in
    cooldown from when *it* was last activated, no need to re-freeze it.

    Exception: when caller passes a weekly cooldown (cooldown_hours >= 24),
    we still freeze prev_email — a weekly-saturated account really is
    unavailable until the parsed reset time, regardless of when it was
    last "activated".
    """
    with action_lock:
        log(f'━━━ Manual switch triggered → {email} ━━━')
        state = load_state()
        prev_email = state['current']
        perform_switch(email)
        # Cooldown writes removed (user policy: pure rotation, no freeze).
        # cooldown_hours arg accepted for backward compat, used only as a
        # 'kind' hint in the notify text (weekly vs session).
        cd = cooldown_hours if cooldown_hours is not None else CFG['cooldown_hours']
        kind = 'weekly' if float(cd) >= 24 else 'session'
        state['current'] = email
        state['last_switch_ts'] = time.time()
        state['switch_count'] = state.get('switch_count', 0) + 1
        save_state(state)
        notify(f'✅ manual switch → {email}\n'
               f'   prev={prev_email} kind={kind} (no cooldown)\n'
               f'   #{state["switch_count"]}')
        log('━━━ Manual switch complete ━━━')


def main_loop():
    log('Switcher main loop started')
    not_logged_in_warned = False
    consecutive_failures = 0
    backoff_notified = False
    parse_fail_count = 0
    parse_fail_warned = False
    all_cooled_warned = False
    paused_warned = False
    BACKOFF_START = 3       # after N consecutive failures, start exponential backoff
    BACKOFF_MAX_S = 3600    # cap sleep at 1 hour no matter how many failures
    PARSE_FAIL_WARN_AT = 3  # notify after N consecutive pct=None probes
    while True:
        iteration_ok = True
        sleep_override = None
        with action_lock:
            try:
                state = load_state()
                r = cmd('get_usage', wait=20)
                pct, detail = parse_usage(r)
                breakdown = _format_limits(detail) if detail else ''
                log(f'current={state["current"]} usage={pct} [{breakdown}]')

                if pct == 'NOT_LOGGED_IN':
                    # Auto-recover: Chrome lost its session (cookie expiry / manual logout).
                    # Run the same flow we use for a normal switch, re-logging into the
                    # current account so the next get_usage has real data.
                    if not not_logged_in_warned:
                        notify(f'⚠️ Chrome 未登录 → 自动登录 {state["current"]}')
                        not_logged_in_warned = True
                    try:
                        perform_switch(state['current'])
                        state['switch_count'] = state.get('switch_count', 0) + 1
                        save_state(state)
                        not_logged_in_warned = False
                        notify(f'✅ re-logged in → {state["current"]} (#{state["switch_count"]})')
                        # Fast post-relogin verify: usage may already be over threshold
                        # (the re-login itself doesn't reduce quota), so probe in 10s
                        # rather than the default 300s — lets the trigger branch fire
                        # promptly if a real switch is needed.
                        sleep_override = (10, 'post-relogin verify')
                    except Exception as e:
                        log(f'  ⚠️ NOT_LOGGED_IN auto-recovery failed: {e}')
                        iteration_ok = False
                elif pct is None:
                    parse_fail_count += 1
                    # Diagnostic: dump raw extension response so we can see what claude.ai
                    # actually returned (URL, limits list shape, page state) when parsing failed.
                    try:
                        raw_dump = json.dumps(r, ensure_ascii=False)[:1500]
                    except Exception:
                        raw_dump = repr(r)[:1500]
                    log(f'  could not parse usage (#{parse_fail_count} in a row), skipping this round')
                    log(f'  raw get_usage response: {raw_dump}')
                    if parse_fail_count >= PARSE_FAIL_WARN_AT and not parse_fail_warned:
                        notify(f'⚠️ usage 解析连续失败 {parse_fail_count} 次 (current={state["current"]}) — '
                               f'检查 Chrome/扩展是否正常、claude.ai 是否改版')
                        parse_fail_warned = True
                    not_logged_in_warned = False
                else:
                    if parse_fail_count > 0:
                        if parse_fail_warned:
                            notify(f'✅ usage 解析已恢复 (pct={pct})')
                        parse_fail_count = 0
                        parse_fail_warned = False
                    not_logged_in_warned = False
                    # Pause flag — when ~/.sigma-switcher/PAUSED exists, skip auto-trigger entirely.
                    # POST /pause / /resume to the server toggles this file.
                    if Path(os.path.expanduser('~/.sigma-switcher/PAUSED')).exists():
                        if not paused_warned:
                            log('  ⏸ switcher paused — auto-trigger disabled')
                            notify('⏸ switcher paused — 不再自动切换 (POST /resume 解除)')
                            paused_warned = True
                        trigger_lim = None
                    else:
                        if paused_warned:
                            log('  ▶️ switcher resumed — auto-trigger re-enabled')
                            notify('▶️ switcher resumed — 自动切换已恢复')
                            paused_warned = False
                        trigger_lim = effective_trigger((detail or {}).get('limits', []))
                    if trigger_lim:
                        trigger = trigger_lim.get('label', '?')
                        trigger_pct = trigger_lim.get('pct_int', 0)
                        kind, cd_hours = classify_limit(trigger_lim)
                        weekly = (kind == 'weekly')
                        # Compute deadline: weekly prefers PARSED reset time (exact), falls back to cd_hours.
                        deadline = None
                        reset_source = 'default'
                        if weekly and trigger_lim.get('resets_text'):
                            parsed = parse_reset_timestamp(trigger_lim['resets_text'])
                            if parsed and parsed > time.time():
                                deadline = parsed + 60  # small buffer past reset
                                reset_source = f'parsed "{trigger_lim["resets_text"]}"'
                        if deadline is None:
                            deadline = time.time() + cd_hours * 3600
                        cd_hours_actual = (deadline - time.time()) / 3600
                        readable = time.strftime('%Y-%m-%d %H:%M', time.localtime(deadline))
                        kind = 'weekly' if weekly else 'session'
                        log(f'  ⚠️ trigger — {trigger} at {trigger_pct}% → {kind} cooldown {cd_hours_actual:.1f}h (until {readable}, source: {reset_source})')
                        # Cooldown writes removed (user policy: pure rotation, no freeze).
                        # `weekly` and `deadline` are still computed above for log/notify use,
                        # but we no longer persist a deadline that would block re-activation.
                        # Anti ping-pong is handled by MIN_SWITCH_INTERVAL_S in pick_next.
                        # Try accounts in pick_next order; if a candidate's magic-link
                        # delivery exhausts retries (forwarding broken for that mailbox),
                        # short-cool it for 30 min and immediately try the next candidate.
                        # Limit to N candidates to avoid burning every account in one go.
                        rotate_attempts = 0
                        max_rotate = len(CFG['accounts'])
                        switched_to = None
                        while rotate_attempts < max_rotate:
                            nxt = pick_next(state)
                            if not nxt:
                                break
                            rotate_attempts += 1
                            try:
                                perform_switch(nxt['email'])
                                switched_to = nxt
                                break
                            except MagicLinkExhausted as e:
                                short_cool = 30 * 60
                                state['cooldowns'][nxt['email']] = time.time() + short_cool
                                save_state(state)
                                log(f'  ⚠️ {e} — cooled {nxt["email"]} for 30min, trying next account')
                                notify(f'⚠️ {nxt["email"]} 邮件未到，30 分钟内不再尝试 — 切换下一个账号')
                                continue

                        if switched_to:
                            all_cooled_warned = False
                            prev_email = state['current']
                            state['current'] = switched_to['email']
                            # Session/weekly cooldown writes removed (user policy: pure rotation).
                            state['last_switch_ts'] = time.time()
                            state['switch_count'] = state.get('switch_count', 0) + 1
                            save_state(state)
                            timer_line = f'   kind={kind} (no cooldown — pure rotation)'
                            notify(f'✅ switched → {state["current"]}\n'
                                   f'   trigger: {trigger} {trigger_pct}%\n'
                                   f'{timer_line}\n'
                                   f'   #{state["switch_count"]}')
                            # Fast post-switch verify: don't wait the full 120s, do an
                            # immediate get_usage on the new account to confirm it works
                            # and to keep the extension popup status moving (instead of
                            # idling on "close_stale_tabs" / "open_url" for 2 minutes).
                            sleep_override = (10, 'post-switch verify')
                        else:
                            # No reachable candidate (either pick_next returned None, or every
                            # candidate exhausted magic-link retries). Persist current's cooldown
                            # and sleep until the earliest non-current wake.
                            save_state(state)
                            # Only consider real (non-zero) cooldowns — under user policy
                            # we no longer write 5h/weekly deadlines, so this list is
                            # typically empty. The remaining cause of pick_next() returning
                            # None is the MIN_SWITCH_INTERVAL_S throttle (or MagicLinkExhausted
                            # short-cool, which does write a real deadline).
                            real_deadlines = [d for d in (state["cooldowns"].get(a["email"], 0)
                                                          for a in CFG["accounts"]
                                                          if a["email"] != state["current"])
                                              if d > time.time()]
                            if real_deadlines:
                                earliest = min(real_deadlines)
                                wait_sec = max(60, int(earliest - time.time()) + 60)
                                readable_w = time.strftime('%Y-%m-%d %H:%M', time.localtime(earliest))
                                sleep_override = (wait_sec, f'all-cooled until {readable_w}')
                                if not all_cooled_warned:
                                    notify(f'⚠️ no reachable account '
                                           f'(trigger: {trigger} {trigger_pct}%, kind={kind})\n'
                                           f'   sleeping until earliest wake at {readable_w}')
                                    all_cooled_warned = True
                            elif len(CFG["accounts"]) <= 1:
                                if not all_cooled_warned:
                                    notify(f'⚠️ only one account configured — cannot rotate '
                                           f'(trigger: {trigger} {trigger_pct}%)')
                                    all_cooled_warned = True
                            else:
                                # No real deadlines — pick_next was throttled by
                                # MIN_SWITCH_INTERVAL_S. Just sleep a short interval
                                # and retry; throttle will expire naturally.
                                sleep_override = (60, f'switch throttled (recent switch < {MIN_SWITCH_INTERVAL_S}s ago)')
            except Exception as e:
                iteration_ok = False
                log(f'main loop error: {e}')
        # --- Update failure counter & backoff state ---
        if iteration_ok:
            if consecutive_failures > 0 and backoff_notified:
                notify(f'✅ switcher recovered after {consecutive_failures} failure(s)')
            consecutive_failures = 0
            backoff_notified = False
        else:
            consecutive_failures += 1
            if consecutive_failures >= BACKOFF_START and not backoff_notified:
                notify(f'⚠️ switcher: {consecutive_failures} consecutive failures — backing off')
                backoff_notified = True
        # --- Compute sleep ---
        base = CFG['check_interval_seconds']
        if sleep_override:
            sleep_secs, reason = sleep_override
        elif consecutive_failures >= BACKOFF_START:
            sleep_secs = min(base * (2 ** (consecutive_failures - BACKOFF_START + 1)), BACKOFF_MAX_S)
            reason = f'backoff({consecutive_failures} failures)'
        elif not_logged_in_warned:
            sleep_secs = base
            reason = 'not-logged-in'
        else:
            sleep_secs = base
            reason = 'normal'
        log(f'  sleep {sleep_secs}s [{reason}]')
        time.sleep(sleep_secs)

if __name__ == '__main__':
    srv.switch_handler = triggered_switch
    srv.state_provider = load_state
    t = threading.Thread(target=srv.run, daemon=True); t.start()
    log(f'HTTP server listening on 127.0.0.1:{srv.PORT}')
    try: main_loop()
    except KeyboardInterrupt:
        log('shutdown'); sys.exit(0)
