#!/usr/bin/env python3
"""Sigma Switcher — local HTTP server that browser extension polls.

Endpoints:
  GET  /next-command       → returns next queued command (or 204)
  POST /result             → extension reports command result
  POST /enqueue            → queue a new command (used by switcher logic + popup)
  GET  /status             → server status (used by popup)
"""
import json, os, time, uuid, threading
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get('SWITCHER_HTTP_PORT', '17222'))

# ─── State ─────────────────────────────────────
state_lock = threading.Lock()
pending = deque()                       # commands waiting for extension
results = {}                            # cmd_id -> result (extension reported)
result_events = {}                      # cmd_id -> threading.Event
last_poll_at = None
last_command = None

# Callbacks registered by switcher.py on startup.
#   switch_handler(email, cooldown_hours=None) — runs the switch flow.
#   state_provider() -> dict — returns current state.json contents for GET /state.
switch_handler = None
state_provider = None


def _run_switch(email, cooldown_hours=None):
    try:
        switch_handler(email, cooldown_hours=cooldown_hours)
    except Exception as e:
        print(f'[server] switch_handler({email!r}) failed: {e}', flush=True)

def enqueue(cmd_dict, wait_timeout=None):
    """Add a command. If wait_timeout, block until extension returns result."""
    global last_command
    if 'id' not in cmd_dict:
        cmd_dict['id'] = str(uuid.uuid4())
    ev = threading.Event()
    with state_lock:
        pending.append(cmd_dict)
        result_events[cmd_dict['id']] = ev
        last_command = cmd_dict.get('type')
    if wait_timeout:
        if ev.wait(wait_timeout):
            with state_lock:
                return results.pop(cmd_dict['id'], None)
        else:
            return {'ok': False, 'error': 'timeout', 'cmd_id': cmd_dict['id']}
    return cmd_dict

# ─── HTTP handler ──────────────────────────────
class H(BaseHTTPRequestHandler):
    def log_message(self, *a, **k): pass  # silence

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def _ok(self, obj=None): self._json(200, obj if obj is not None else {'ok': True})
    def _empty(self): self.send_response(204); self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        global last_poll_at
        if self.path == '/next-command':
            with state_lock:
                last_poll_at = time.strftime('%H:%M:%S')
                cmd = pending.popleft() if pending else None
            if cmd: self._json(200, cmd)
            else: self._empty()
        elif self.path == '/status':
            self._json(200, {
                'last_poll': last_poll_at,
                'last_command': last_command,
                'pending': len(pending),
            })
        elif self.path == '/state':
            if state_provider is None:
                self._json(503, {'error': 'state_provider not registered'}); return
            try:
                self._json(200, state_provider())
            except Exception as e:
                self._json(500, {'error': str(e)})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        ln = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(ln) if ln else b'{}'
        try:
            data = json.loads(body or b'{}')
        except Exception:
            self._json(400, {'error': 'bad json'}); return

        if self.path == '/result':
            cid = data.get('id')
            with state_lock:
                results[cid] = data.get('result')
                ev = result_events.pop(cid, None)
            if ev: ev.set()
            self._ok()
        elif self.path == '/enqueue':
            r = enqueue(data, wait_timeout=data.get('wait', 30))
            self._json(200, r)
        elif self.path == '/trigger_switch':
            email = (data.get('email') or '').strip()
            if not email:
                self._json(400, {'error': 'missing email'}); return
            if switch_handler is None:
                self._json(503, {'error': 'switch_handler not registered'}); return
            cooldown_hours = data.get('cooldown_hours')
            threading.Thread(target=_run_switch, args=(email,),
                             kwargs={'cooldown_hours': cooldown_hours},
                             daemon=True).start()
            self._ok({'ok': True, 'triggered': email, 'cooldown_hours': cooldown_hours})
        elif self.path == '/pause':
            # Touch a flag file; main_loop checks it before each auto-trigger.
            Path(os.path.expanduser('~/.sigma-switcher/PAUSED')).touch()
            self._ok({'ok': True, 'paused': True})
        elif self.path == '/resume':
            p = Path(os.path.expanduser('~/.sigma-switcher/PAUSED'))
            if p.exists():
                p.unlink()
            self._ok({'ok': True, 'paused': False})
        else:
            self._json(404, {'error': 'not found'})

# ─── Run ───────────────────────────────────────
def run():
    s = ThreadingHTTPServer(('127.0.0.1', PORT), H)
    print(f'sigma-switcher server listening on 127.0.0.1:{PORT}')
    s.serve_forever()

if __name__ == '__main__':
    run()
