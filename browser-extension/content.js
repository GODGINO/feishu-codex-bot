/**
 * Content Script — DOM operations for remote browser control
 *
 * Receives commands from service worker, executes DOM operations,
 * and returns results. Manages a UID→element mapping for interaction.
 */

// UID tracking
let uidMap = new Map(); // uid string → WeakRef<Element>
let nextUid = 1;

function assignUid(el) {
  // Check if element already has a uid
  const existing = el.getAttribute('data-sigma-uid');
  if (existing && uidMap.has(existing)) {
    const ref = uidMap.get(existing).deref();
    if (ref === el) return existing;
  }
  const uid = 'e' + (nextUid++);
  el.setAttribute('data-sigma-uid', uid);
  uidMap.set(uid, new WeakRef(el));
  return uid;
}

function getElement(uid) {
  // Try from map first
  const ref = uidMap.get(uid);
  if (ref) {
    const el = ref.deref();
    if (el) return el;
    uidMap.delete(uid);
  }
  // Fallback: query by attribute
  const el = document.querySelector(`[data-sigma-uid="${uid}"]`);
  if (el) {
    uidMap.set(uid, new WeakRef(el));
  }
  return el;
}

// ── Snapshot: build a11y tree ──

function getRole(el) {
  const role = el.getAttribute('role');
  if (role) return role;
  const tag = el.tagName.toLowerCase();
  const roleMap = {
    a: 'link', button: 'button', input: 'textbox', textarea: 'textbox',
    select: 'combobox', img: 'image', h1: 'heading', h2: 'heading',
    h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    nav: 'navigation', main: 'main', footer: 'contentinfo',
    header: 'banner', form: 'form', table: 'table', ul: 'list',
    ol: 'list', li: 'listitem', section: 'region',
  };
  if (tag === 'input') {
    const type = el.type?.toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button') return 'button';
  }
  return roleMap[tag] || 'generic';
}

function getAccessibleName(el) {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return labelEl.textContent?.trim();
  }
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) return label.textContent?.trim();
    }
    if (el.placeholder) return el.placeholder;
  }
  if (el.tagName === 'IMG') return el.alt || '';
  if (el.tagName === 'A') return el.textContent?.trim();
  return '';
}

function isVisible(el) {
  if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function isInteractive(el) {
  const tag = el.tagName.toLowerCase();
  if (['a', 'button', 'input', 'textarea', 'select'].includes(tag)) return true;
  if (el.getAttribute('role') === 'button') return true;
  if (el.getAttribute('tabindex') !== null) return true;
  if (el.onclick || el.getAttribute('onclick')) return true;
  return false;
}

function buildSnapshot(verbose) {
  const lines = [];
  const interactiveSelector = 'a, button, input, textarea, select, [role="button"], [tabindex], [onclick]';

  function walk(el, depth) {
    if (!el || el.nodeType !== 1) return;
    if (!isVisible(el)) return;

    const tag = el.tagName.toLowerCase();
    // Skip script/style/svg internals
    if (['script', 'style', 'noscript', 'svg'].includes(tag)) return;

    const interactive = isInteractive(el);
    const role = getRole(el);
    const name = getAccessibleName(el);

    // Decide if this node should appear in the snapshot
    const hasText = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3 &&
      el.childNodes[0].textContent?.trim();
    const shouldShow = interactive || (verbose && (name || hasText));

    if (shouldShow) {
      const uid = assignUid(el);
      const indent = '  '.repeat(depth);
      let line = `${indent}[${uid}] ${role}`;
      if (name) line += ` "${name}"`;
      if (hasText && !name) {
        const text = el.childNodes[0].textContent.trim();
        if (text.length <= 80) line += ` "${text}"`;
        else line += ` "${text.substring(0, 77)}..."`;
      }
      // Extra info for inputs
      if (tag === 'input' || tag === 'textarea') {
        const val = el.value;
        if (val) line += ` value="${val.length > 40 ? val.substring(0, 37) + '...' : val}"`;
        if (el.type && el.type !== 'text') line += ` type=${el.type}`;
        if (el.checked) line += ' [checked]';
        if (el.disabled) line += ' [disabled]';
      }
      if (tag === 'a' && el.href) {
        line += ` href="${el.href}"`;
      }
      lines.push(line);
    }

    for (const child of el.children) {
      walk(child, shouldShow ? depth + 1 : depth);
    }
  }

  walk(document.body, 0);
  return lines.join('\n');
}

// ── Tool implementations ──

function doClick(uid, dblClick) {
  const el = getElement(uid);
  if (!el) throw new Error(`Element ${uid} not found`);
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  if (dblClick) {
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  } else {
    el.click();
  }
  return { clicked: uid };
}

function doFill(uid, value) {
  const el = getElement(uid);
  if (!el) throw new Error(`Element ${uid} not found`);
  el.focus();
  if (el.tagName === 'SELECT') {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // Clear and set value using native input setter for React compatibility
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { filled: uid, value };
}

function doTypeText(text, submitKey) {
  const el = document.activeElement;
  if (!el) throw new Error('No focused element');
  for (const char of text) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
    // Insert character
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const start = el.selectionStart || 0;
      const end = el.selectionEnd || 0;
      const val = el.value;
      el.value = val.substring(0, start) + char + val.substring(end);
      el.selectionStart = el.selectionEnd = start + 1;
    } else if (el.isContentEditable) {
      document.execCommand('insertText', false, char);
    }
    el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  if (submitKey) {
    doPressKey(submitKey);
  }
  return { typed: text };
}

function doPressKey(keyStr) {
  const el = document.activeElement || document.body;
  const parts = keyStr.split('+');
  const key = parts.pop();
  const modifiers = {
    ctrlKey: parts.includes('Control'),
    shiftKey: parts.includes('Shift'),
    altKey: parts.includes('Alt'),
    metaKey: parts.includes('Meta'),
  };
  const opts = { key, bubbles: true, cancelable: true, ...modifiers };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  // Special key actions
  if (key === 'Enter' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
    const form = el.closest('form');
    if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
  return { pressed: keyStr };
}

function doHover(uid) {
  const el = getElement(uid);
  if (!el) throw new Error(`Element ${uid} not found`);
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  return { hovered: uid };
}

function doFillForm(elements) {
  const results = [];
  for (const { uid, value } of elements) {
    results.push(doFill(uid, value));
  }
  return results;
}

async function doWaitFor(texts, timeout) {
  const maxWait = timeout || 30000;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const pageText = document.body.innerText;
      for (const t of texts) {
        if (pageText.includes(t)) {
          resolve({ found: t });
          return;
        }
      }
      if (Date.now() - start > maxWait) {
        reject(new Error(`Timeout waiting for text: ${texts.join(', ')}`));
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

function doEvaluateScript(fnStr, args) {
  try {
    // Resolve element args
    const resolvedArgs = (args || []).map(a => {
      if (a.uid) return getElement(a.uid);
      return a;
    });
    const fn = new Function('return ' + fnStr)();
    const result = fn(...resolvedArgs);
    // Handle promises
    if (result && typeof result.then === 'function') {
      return result;
    }
    return result;
  } catch (err) {
    throw new Error(`Script error: ${err.message}`);
  }
}

function getElementRect(uid) {
  const el = getElement(uid);
  if (!el) throw new Error(`Element ${uid} not found`);
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

// ── Message handler ──

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg.action) return false;

  const handle = async () => {
    const { action, params } = msg;
    switch (action) {
      case 'take_snapshot':
        return buildSnapshot(params?.verbose);
      case 'click':
        return doClick(params.uid, params.dblClick);
      case 'fill':
        return doFill(params.uid, params.value);
      case 'type_text':
        return doTypeText(params.text, params.submitKey);
      case 'press_key':
        return doPressKey(params.key);
      case 'hover':
        return doHover(params.uid);
      case 'fill_form':
        return doFillForm(params.elements);
      case 'wait_for':
        return await doWaitFor(params.text, params.timeout);
      case 'evaluate_script':
        return await doEvaluateScript(params.function, params.args);
      case 'get_element_rect':
        return getElementRect(params.uid);
      case 'navigate':
        if (params.type === 'back') { history.back(); return { navigated: 'back' }; }
        if (params.type === 'forward') { history.forward(); return { navigated: 'forward' }; }
        return { error: 'Unknown navigate type' };
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  };

  handle()
    .then(result => sendResponse({ result }))
    .catch(err => sendResponse({ error: err.message }));

  return true; // Keep channel open for async response
});
