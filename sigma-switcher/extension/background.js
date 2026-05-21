// Sigma Claude Switcher — service worker
// Polls local Python switcher for commands and executes them inside this Chrome.

const ENDPOINT = 'http://127.0.0.1:17222';
const POLL_MS = 3000;

// ─── Logging ─────────────────────────────────────────
function log(...args) { console.log('[Sigma]', ...args); }

// ─── Long-poll Python for next command ───────────────
async function poll() {
  try {
    const resp = await fetch(`${ENDPOINT}/next-command`, {
      method: 'GET',
      cache: 'no-store',
    });
    if (!resp.ok) {
      if (resp.status !== 204) log('poll status', resp.status);
      return;
    }
    const cmd = await resp.json();
    if (!cmd || !cmd.id) return;
    log('command', cmd.type, 'id=', cmd.id);
    let result;
    try {
      result = await dispatch(cmd);
    } catch (e) {
      result = { ok: false, error: String(e && e.stack || e) };
    }
    await fetch(`${ENDPOINT}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: cmd.id, result }),
    });
  } catch (e) {
    // silent — Python may not be running
  }
}

chrome.alarms.create('sigma-poll', { periodInMinutes: POLL_MS / 60000 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'sigma-poll') poll(); });
// Also poll right away on startup
poll();
setInterval(poll, POLL_MS);

// ─── Command dispatcher ──────────────────────────────
async function dispatch(cmd) {
  switch (cmd.type) {
    case 'ping': return { ok: true, pong: Date.now() };
    case 'get_usage': return await getUsage();
    case 'clear_claude_cookies': return await clearClaudeCookies();
    case 'open_url': return await openUrl(cmd.url, cmd.wait_url_match);
    case 'click_authorize': return await clickAuthorize();
    case 'fill_email_and_continue': return await fillEmailAndContinue(cmd.email);
    case 'check_login': return await checkLogin();
    case 'close_stale_tabs': return await closeStaleTabs();
    case 'read_oauth_code': return await readOAuthCode();
    default: throw new Error('unknown command: ' + cmd.type);
  }
}

// ─── Helpers ─────────────────────────────────────────
async function findOrCreateTab(url) {
  // try to find existing tab on same origin
  const u = new URL(url);
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    try {
      const tu = new URL(t.url || '');
      if (tu.hostname === u.hostname) {
        await chrome.tabs.update(t.id, { active: true, url });
        return t.id;
      }
    } catch {}
  }
  const t = await chrome.tabs.create({ url, active: false });
  return t.id;
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return t;
    await sleep(300);
  }
  throw new Error('tab load timeout');
}

async function execInTab(tabId, fn, args = []) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: fn,
    args,
    world: 'MAIN',
  });
  return r && r.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Commands ────────────────────────────────────────
async function getUsage() {
  const tabId = await findOrCreateTab('https://claude.ai/settings/usage');
  await waitForTabComplete(tabId);
  await sleep(3000); // let SPA render

  const data = await execInTab(tabId, () => {
    const url = location.href;

    // ── Scan all "N% used" cells, then associate each with nearest section label.
    // The usage page (claude.ai/settings/usage) has multiple independent limits:
    //   • Current session (5h rolling)
    //   • Weekly: All models  ← hard stop when 100%
    //   • Weekly: Sonnet only
    //   • Weekly: Opus only
    //   • Weekly: Haiku only
    //   • Weekly: Claude Design / Claude Code / etc.
    //
    // Each has its own <p>N% used</p>. The switch trigger should be the MAX,
    // because hitting 100% on any single hard-stop limit makes the account unusable.

    // Build the list of pct leaves
    const pctLeaves = [...document.querySelectorAll('p, span, div')]
      .filter(e => e.children.length === 0 && /^\d+(?:\.\d+)?\s*%\s*used$/i.test((e.innerText || '').trim()))
      .map(e => ({
        el: e,
        pct: parseFloat(e.innerText.trim().match(/^(\d+(?:\.\d+)?)/)[1]),
        text: e.innerText.trim(),
      }));

    // For each pct leaf, walk up the DOM to find the nearest "section label"
    // (a short heading-like text that isn't percent/descriptive).
    const DESCRIPTIVE_RE = /^(Resets|Starts when|You haven|Last updated|Learn more|All models|Plan usage limits|Weekly limits|Settings)/i;
    const findSectionLabel = (leaf) => {
      let cur = leaf.el;
      for (let depth = 0; depth < 6; depth++) {
        cur = cur.parentElement;
        if (!cur) break;
        // Look for heading or the first short non-descriptive text among preceding siblings or direct children
        const candidates = [...cur.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span')]
          .filter(e => e !== leaf.el)
          .map(e => (e.innerText || '').trim())
          .filter(t => t && t.length > 0 && t.length < 40 && !/%/.test(t));
        for (const t of candidates) {
          // "All models" is special — it's the section header for weekly "All models" limit,
          // so DON'T skip it. Only skip truly descriptive sentences.
          if (DESCRIPTIVE_RE.test(t) && t.toLowerCase() !== 'all models') continue;
          return t;
        }
      }
      return 'Unknown';
    };

    // For weekly limits, find the associated "Resets Fri 3:59 PM" text in the same section.
    // Session limit shows "Starts when a message is sent" instead — no fixed reset, return null.
    const RESETS_RE = /^Resets?\s+\w{3,}\s+\d{1,2}:\d{1,2}\s*(AM|PM)/i;
    const findResetsText = (leaf) => {
      let cur = leaf.el;
      for (let depth = 0; depth < 6; depth++) {
        cur = cur.parentElement;
        if (!cur) break;
        const matches = [...cur.querySelectorAll('p, span, div')]
          .filter(e => e.children.length === 0)
          .map(e => (e.innerText || '').trim())
          .filter(t => RESETS_RE.test(t));
        if (matches.length > 0) return matches[0];
      }
      return null;
    };

    const limits = pctLeaves.map(leaf => ({
      label: findSectionLabel(leaf),
      pct: leaf.pct,
      pct_int: Math.round(leaf.pct),
      raw: leaf.text,
      resets_text: findResetsText(leaf),      // e.g. "Resets Fri 4:00 PM" or null
    }));

    // Effective pct: MAX across all limits (most conservative — switch if anything is full)
    const effective = limits.length > 0 ? Math.max(...limits.map(l => l.pct_int)) : null;
    const dominantLimit = limits.length > 0 ? limits.find(l => l.pct_int === effective) : null;

    return {
      url,
      title: document.title,
      limits,                                       // all sections with labels
      pct: effective,                               // max across all — primary switch signal
      dominant: dominantLimit ? dominantLimit.label : null,
      source: limits.length > 0 ? 'multi-section' : 'empty',
    };
  });
  return { ok: true, data };
}

async function clearClaudeCookies() {
  const domains = ['claude.ai', '.claude.ai', 'claude.com', '.claude.com', 'anthropic.com', '.anthropic.com'];
  let n = 0;
  for (const d of domains) {
    const cookies = await chrome.cookies.getAll({ domain: d });
    for (const c of cookies) {
      const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path}`;
      await chrome.cookies.remove({ url, name: c.name }).catch(() => {});
      n++;
    }
  }
  return { ok: true, removed: n };
}

async function openUrl(url, waitUrlMatch) {
  const tabId = await findOrCreateTab(url);
  await waitForTabComplete(tabId, 30000);
  if (waitUrlMatch) {
    const re = new RegExp(waitUrlMatch);
    const start = Date.now();
    while (Date.now() - start < 30000) {
      const t = await chrome.tabs.get(tabId);
      if (re.test(t.url || '')) return { ok: true, finalUrl: t.url };
      await sleep(500);
    }
    return { ok: false, error: 'wait_url_match timeout', lastUrl: (await chrome.tabs.get(tabId)).url };
  }
  const t = await chrome.tabs.get(tabId);
  return { ok: true, finalUrl: t.url };
}

async function readOAuthCode() {
  // After clicking Authorize, the browser lands on platform.claude.com/oauth/code/callback
  // with ?code=<CODE>&state=<STATE> — that page displays "<CODE>#<STATE>" as the paste
  // string for `claude auth login` (which, when spawned via pexpect without a real TTY
  // attached, can't use the localhost-callback flow). We poll up to 20s for the tab
  // to appear, then read code+state from the URL.
  const urlFilter = [
    'https://platform.claude.com/oauth/code/*',
    'https://*.claude.com/oauth/code/*',
  ];
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const tabs = await chrome.tabs.query({ url: urlFilter });
    for (const t of tabs) {
      try {
        const u = new URL(t.url || '');
        const code = u.searchParams.get('code');
        const state = u.searchParams.get('state');
        if (code && state) {
          return { ok: true, code: `${code}#${state}`, url: t.url, tabId: t.id };
        }
      } catch {}
    }
    await sleep(400);
  }
  return { ok: false, error: 'no callback tab with code+state seen within 20s' };
}

async function closeStaleTabs() {
  // Close transient tabs that pile up across repeated switches: OAuth consent pages,
  // magic-link landers, usage probes. Keep the main session tab (claude.ai/new,
  // /chats, /projects, etc.) so the next get_usage can reuse it.
  const urlFilter = [
    'https://claude.com/*', 'https://*.claude.com/*',
    'https://claude.ai/*',  'https://*.claude.ai/*',
  ];
  const staleRe = /\/(oauth|authorize|magic-link|login|settings\/usage)(\/|\?|#|$)/i;
  const tabs = await chrome.tabs.query({ url: urlFilter });
  const toClose = tabs.filter(t => staleRe.test(t.url || ''));
  const ids = toClose.map(t => t.id);
  if (ids.length) {
    try { await chrome.tabs.remove(ids); } catch (e) { return { ok: false, error: String(e) }; }
  }
  return { ok: true, closed: ids.length, urls: toClose.map(t => t.url) };
}

async function clickAuthorize() {
  // The OAuth consent button rejects synthetic clicks (React handler appears to check
  // event.isTrusted). We use chrome.debugger + CDP Input.dispatchMouseEvent to inject
  // a real trusted click — same approach Playwright/Puppeteer use to simulate humans.
  // Falls back to .click() if debugger attach fails. Narrows to OAuth-URL tabs so stale
  // /settings/usage tabs don't distract us, and never force-activates other tabs.
  const urlFilter = [
    'https://claude.com/*', 'https://*.claude.com/*',
    'https://claude.ai/*',  'https://*.claude.ai/*',
  ];
  const isOAuthUrl = (url) => /\/(oauth|authorize)(\/|\?|$)/i.test(url || '');
  const deadline = Date.now() + 15000;
  let lastSeen = [];
  let lastUrl = '';
  let sawOAuthTab = false;

  let activatedTabId = null;

  while (Date.now() < deadline) {
    const allTabs = await chrome.tabs.query({ url: urlFilter });
    // Newest tab first — open_url just created this tab, older ones are stale.
    const oauthTabs = allTabs.filter(t => isOAuthUrl(t.url)).sort((a, b) => b.id - a.id);
    if (oauthTabs.length > 0) sawOAuthTab = true;

    const t = oauthTabs[0];
    if (!t) { await sleep(500); continue; }

    // Chrome throttles React rendering on backgrounded tabs, which makes the probe
    // find zero buttons. Activate the tab AND focus its window before probing.
    if (activatedTabId !== t.id) {
      try {
        await chrome.tabs.update(t.id, { active: true });
        const tab = await chrome.tabs.get(t.id);
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch {}
      activatedTabId = t.id;
      await sleep(600);  // let React mount + render with focus
    }

    // (single-tab path below, no inner for-loop needed)
    {
      const probe = await execInTab(t.id, () => {
        const cands = [...document.querySelectorAll('button, a[role="button"], input[type="submit"]')];
        const label = (el) => ((el.innerText || el.value || el.textContent || '').trim());
        const btn = cands.find(b => {
          const txt = label(b).toLowerCase();
          return txt === 'authorize' || txt.startsWith('authorize ');
        });
        if (!btn) {
          return { found: false, url: location.href, seen: cands.map(l => ({ text: label(l), disabled: l.disabled })).filter(x => x.text).slice(0, 10) };
        }
        const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
        const rect = btn.getBoundingClientRect();
        return {
          found: true,
          disabled,
          text: label(btn),
          cx: rect.x + rect.width / 2,
          cy: rect.y + rect.height / 2,
          url: location.href,
        };
      }).catch(() => null);

      if (!probe) continue;
      lastUrl = probe.url || lastUrl;
      if (!probe.found) { lastSeen = probe.seen || lastSeen; continue; }
      if (probe.disabled) continue;  // wait for button to enable

      // Real click via CDP. Focus the tab first so the click lands on the visible viewport.
      const target = { tabId: t.id };
      let method = 'debugger';
      let debuggerError = null;
      let clicked = false;
      try {
        try { await chrome.tabs.update(t.id, { active: true }); } catch {}
        await chrome.debugger.attach(target, '1.3');
        try {
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: probe.cx, y: probe.cy, button: 'none',
          });
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mousePressed', x: probe.cx, y: probe.cy, button: 'left', clickCount: 1, buttons: 1,
          });
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: probe.cx, y: probe.cy, button: 'left', clickCount: 1,
          });
          clicked = true;
        } finally {
          try { await chrome.debugger.detach(target); } catch {}
        }
      } catch (e) {
        debuggerError = String(e);
        // Fallback: synthetic click
        const r = await execInTab(t.id, () => {
          const btn = [...document.querySelectorAll('button, a[role="button"], input[type="submit"]')]
            .find(b => /^authorize\b/i.test((b.innerText || b.value || '').trim()));
          if (btn && !btn.disabled) { btn.click(); return true; }
          return false;
        }).catch(() => false);
        if (r) { clicked = true; method = 'synthetic'; }
      }
      if (clicked) return { ok: true, tabId: t.id, text: probe.text, url: probe.url, method, debuggerError };
    }
    await sleep(500);
  }

  if (!sawOAuthTab) {
    // fail-closed: no OAuth tab observed in 15s window. Daemon retries CLI login.
    return { ok: false, error: 'no_oauth_tab', note: 'no oauth/authorize tab observed in 15s window' };
  }
  return { ok: false, error: 'no Authorize button found or clickable', seen: lastSeen, lastUrl };
}

async function fillEmailAndContinue(email) {
  const tabId = await findOrCreateTab('https://claude.ai/login');
  await waitForTabComplete(tabId);
  await sleep(2000);
  const r = await execInTab(tabId, (em) => {
    const input = document.querySelector('input[data-testid="email"], input[type="email"]');
    if (!input) return { ok: false, error: 'no email input' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, em);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const btn = document.querySelector('button[data-testid="continue"]');
    if (!btn) return { ok: false, error: 'no continue button' };
    btn.click();
    return { ok: true };
  }, [email]);
  return r;
}

async function checkLogin() {
  const tabId = await findOrCreateTab('https://claude.ai/');
  await waitForTabComplete(tabId);
  await sleep(2000);
  const r = await execInTab(tabId, () => {
    const isLogin = location.pathname.startsWith('/login') || location.pathname.startsWith('/magic-link');
    return { url: location.href, loggedIn: !isLogin };
  });
  return { ok: true, ...r };
}
