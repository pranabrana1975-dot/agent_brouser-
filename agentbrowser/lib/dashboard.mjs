// dashboard.mjs — Zero-dependency Live Supervisor Mission Control & Human Takeover UI.
// Served at GET /dashboard. Uses strict CSP, relative URLs (proxy/iframe safe),
// sessionStorage-only Bearer auth, and XSS-safe DOM construction.

export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function renderDashboardHtml({ requiresAuth = false } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AgentBrowser · Mission Control</title>
<style>
  :root {
    --bg: #0b0f17;
    --panel: #111827;
    --panel2: #182234;
    --border: #24324a;
    --text: #e6edf7;
    --muted: #8ea0bc;
    --accent: #38bdf8;
    --ok: #22c55e;
    --warn: #f59e0b;
    --err: #f43f5e;
    --takeover: #a855f7;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 13px/1.45 var(--sans); }
  button, input, select { font: inherit; color: inherit; }
  button {
    background: var(--panel2); border: 1px solid var(--border); border-radius: 6px;
    padding: 5px 10px; cursor: pointer; transition: border-color .15s, background .15s;
  }
  button:hover { border-color: var(--accent); background: #1e2b42; }
  button.primary { background: #0369a1; border-color: #0ea5e9; color: #fff; font-weight: 600; }
  button.ok { background: #15803d; border-color: var(--ok); color: #fff; font-weight: 600; }
  button.danger { background: #9f1239; border-color: var(--err); color: #fff; font-weight: 600; }
  button.takeover-active { background: #6b21a8; border-color: var(--takeover); color: #fff; font-weight: 600; box-shadow: 0 0 0 2px rgba(168,85,247,.3); }
  button.rec-active { background: #9f1239; border-color: var(--err); color: #fff; animation: pulse 1.4s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .72; } }
  input, select {
    background: #0d1422; border: 1px solid var(--border); border-radius: 6px;
    padding: 5px 9px; outline: none;
  }
  input:focus, select:focus { border-color: var(--accent); }

  .app { display: grid; grid-template-rows: auto auto 1fr; height: 100vh; overflow: hidden; }
  header {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 8px 12px; background: var(--panel); border-bottom: 1px solid var(--border);
  }
  .brand { font-weight: 700; font-size: 14px; letter-spacing: .2px; display: flex; align-items: center; gap: 7px; margin-right: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; }
  .dot.live { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
  .dot.warn { background: var(--warn); }
  .dot.err { background: var(--err); }
  .pill { font: 11px var(--mono); padding: 2px 7px; border-radius: 999px; background: var(--panel2); border: 1px solid var(--border); color: var(--muted); }
  .spacer { flex: 1; }

  #approvals-bar { display: none; padding: 8px 12px; background: rgba(245,158,11,.12); border-bottom: 1px solid var(--warn); gap: 8px; flex-direction: column; }
  #approvals-bar.visible { display: flex; }
  .approval-card {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    background: var(--panel); border: 1px solid var(--warn); border-radius: 8px; padding: 7px 11px;
  }
  .approval-meta { flex: 1; min-width: 220px; }
  .approval-title { font-weight: 600; color: #fde68a; }
  .approval-detail { font: 12px var(--mono); color: var(--text); }

  main { display: grid; grid-template-columns: minmax(420px, 1.35fr) minmax(360px, 1fr); min-height: 0; overflow: hidden; }
  @media (max-width: 980px) { main { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; } }

  .stage-col { display: flex; flex-direction: column; border-right: 1px solid var(--border); min-height: 0; }
  .nav-bar, .tab-bar, .takeover-bar {
    display: flex; align-items: center; gap: 6px; padding: 6px 10px;
    background: var(--panel); border-bottom: 1px solid var(--border);
  }
  .tab-bar { overflow-x: auto; padding: 4px 10px; background: #0d1422; }
  .tab-chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px;
    border-radius: 6px; border: 1px solid var(--border); background: var(--panel);
    font-size: 12px; white-space: nowrap; cursor: pointer;
  }
  .tab-chip.active { border-color: var(--accent); color: #fff; background: #16253b; }
  .tab-close { opacity: .65; font-weight: 700; padding: 0 2px; cursor: pointer; }
  .tab-close:hover { opacity: 1; color: var(--err); }
  #url-input { flex: 1; font: 12px var(--mono); }

  .takeover-bar { display: none; background: rgba(168,85,247,.13); border-bottom-color: var(--takeover); flex-wrap: wrap; }
  .takeover-bar.visible { display: flex; }
  #takeover-text { flex: 1; min-width: 150px; }

  .viewport-wrap {
    flex: 1; display: flex; align-items: center; justify-content: center;
    background: #06090f; overflow: auto; position: relative; padding: 10px; min-height: 0;
  }
  #viewport-img {
    max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 6px;
    border: 1px solid var(--border); background: #111; display: none; user-select: none;
  }
  #viewport-img.takeover { cursor: crosshair; border-color: var(--takeover); box-shadow: 0 0 0 2px rgba(168,85,247,.35); }
  .empty-stage { color: var(--muted); text-align: center; max-width: 340px; }

  .inspector-col { display: flex; flex-direction: column; min-height: 0; background: var(--panel); }
  .panel-tabs { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid var(--border); overflow-x: auto; }
  .panel-tab {
    border: 1px solid transparent; border-bottom: none; border-radius: 6px 6px 0 0;
    padding: 5px 9px; background: transparent; color: var(--muted); font-size: 12px;
  }
  .panel-tab.active { background: var(--bg); color: var(--text); border-color: var(--border); font-weight: 600; }
  .panel-body { flex: 1; overflow: auto; padding: 10px; background: var(--bg); font: 12px/1.5 var(--mono); }
  .panel-view { display: none; }
  .panel-view.active { display: block; }
  .toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; font-family: var(--sans); }

  .log-row { padding: 3px 6px; border-bottom: 1px solid #162033; display: flex; gap: 7px; word-break: break-word; }
  .tag { padding: 0 5px; border-radius: 4px; font-size: 10px; text-transform: uppercase; flex-shrink: 0; height: 17px; line-height: 17px; }
  .tag-act { background: #1e3a5f; color: #7dd3fc; }
  .tag-nav { background: #164e63; color: #67e8f9; }
  .tag-policy, .tag-approval { background: #451a03; color: #fcd34d; }
  .tag-err, .tag-error, .tag-pageerror { background: #4c0519; color: #fda4af; }
  .tag-warning { background: #422006; color: #fde047; }
  .tag-devtools { background: #1f2937; color: #c4b5fd; }
  .tag-human { background: #3b0764; color: #e9d5ff; }
  .tag-agent { background: #052e16; color: #86efac; }

  .net-row { padding: 4px 6px; border-bottom: 1px solid #162033; cursor: pointer; display: grid; grid-template-columns: 44px 44px 58px 54px 1fr; gap: 6px; align-items: center; }
  .net-row:hover { background: var(--panel2); }
  .net-url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-ok { color: var(--ok); } .s-err { color: var(--err); } .s-warn { color: var(--warn); }

  pre.box {
    background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 6px 0;
  }
  .score-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(95px, 1fr)); gap: 7px; margin-bottom: 10px; font-family: var(--sans); }
  .score-card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 8px; text-align: center; }
  .score-val { font-size: 20px; font-weight: 700; }
  .score-lbl { font-size: 11px; color: var(--muted); }

  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.72); display: none;
    align-items: center; justify-content: center; z-index: 50;
  }
  .modal-backdrop.open { display: flex; }
  .modal { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; width: min(400px, 92vw); }
  .modal h3 { margin: 0 0 8px; font-size: 15px; }
  .modal p { margin: 0 0 12px; color: var(--muted); font-size: 12px; }
  .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
  .toast-msg { position: fixed; right: 14px; bottom: 14px; background: var(--panel2); border: 1px solid var(--accent); padding: 7px 12px; border-radius: 7px; display: none; z-index: 60; }
</style>
</head>
<body data-requires-auth="${requiresAuth ? '1' : '0'}">
<div class="app">
  <header>
    <div class="brand"><span id="conn-dot" class="dot"></span>AgentBrowser <span class="pill">v2.0 Mission Control</span></div>
    <label for="session-select" style="color:var(--muted)">Session</label>
    <select id="session-select" title="Active Session"></select>
    <button id="new-session-btn" title="Create isolated session">+ Session</button>
    <span id="status-pill" class="pill">idle</span>
    <span id="devtools-pill" class="pill">0 req · 0 err</span>
    <div class="spacer"></div>
    <button id="takeover-btn" title="Pause agent and control browser directly for CAPTCHA / OTP / 2FA">Human Takeover</button>
    <button id="rec-btn" title="Record reusable workflow">● Record</button>
    <button id="annotate-btn" title="Toggle [eN] Set-of-Mark ref badges">Refs [eN]</button>
    <button id="reset-btn" title="Reset current session">Reset</button>
    <button id="auth-btn" title="Configure Bearer Token">Token</button>
  </header>

  <section id="approvals-bar" aria-live="polite"></section>

  <main>
    <section class="stage-col">
      <div class="nav-bar">
        <button id="back-btn" title="Back">←</button>
        <button id="fwd-btn" title="Forward">→</button>
        <button id="reload-btn" title="Reload">↻</button>
        <input id="url-input" type="text" placeholder="https://example.com — press Enter to open" />
        <button id="go-btn" class="primary">Open</button>
        <button id="shot-btn" title="Refresh live screenshot">Snap</button>
      </div>
      <div id="tab-bar" class="tab-bar"></div>
      <div id="takeover-bar" class="takeover-bar">
        <strong style="color:#e9d5ff">TAKEOVER ACTIVE</strong>
        <span style="color:var(--muted);font-size:12px">Agent paused · click/scroll viewport or type OTP/2FA:</span>
        <input id="takeover-text" type="text" placeholder="Type text / OTP / 2FA code…" />
        <label style="font-size:11px;display:inline-flex;align-items:center;gap:3px"><input id="takeover-secret" type="checkbox" />mask</label>
        <button id="send-text-btn" class="primary">Send</button>
        <button data-key="Enter">Enter</button>
        <button data-key="Tab">Tab</button>
        <button data-key="Backspace">⌫</button>
        <button data-key="Escape">Esc</button>
        <button id="handback-btn" class="ok">Hand Back to Agent</button>
      </div>
      <div class="viewport-wrap">
        <img id="viewport-img" alt="Live browser viewport" draggable="false" />
        <div id="empty-stage" class="empty-stage">
          <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px">Live Browser Viewport</div>
          <div>Open a URL above or let an MCP/SDK agent act. Enable <b>Human Takeover</b> any time to solve CAPTCHA, OTP, or 2FA directly.</div>
        </div>
      </div>
    </section>

    <section class="inspector-col">
      <nav class="panel-tabs">
        <button class="panel-tab active" data-panel="timeline">Timeline</button>
        <button class="panel-tab" data-panel="network">Network</button>
        <button class="panel-tab" data-panel="console">Console</button>
        <button class="panel-tab" data-panel="audit">Audit &amp; Perf</button>
        <button class="panel-tab" data-panel="snapshot">Snapshot</button>
        <button class="panel-tab" data-panel="workflows">Workflows &amp; Metrics</button>
      </nav>
      <div class="panel-body">
        <div id="panel-timeline" class="panel-view active">
          <div id="timeline-list"></div>
        </div>

        <div id="panel-network" class="panel-view">
          <div class="toolbar">
            <select id="net-filter">
              <option value="all">All requests</option>
              <option value="api">XHR / Fetch</option>
              <option value="document">Documents</option>
              <option value="script">Scripts</option>
            </select>
            <button id="net-refresh-btn">Refresh</button>
            <button id="net-clear-btn">Clear</button>
          </div>
          <div id="net-list"></div>
          <pre id="net-detail" class="box" style="display:none"></pre>
        </div>

        <div id="panel-console" class="panel-view">
          <div class="toolbar">
            <select id="cons-level">
              <option value="all">All levels</option>
              <option value="error">Errors only</option>
              <option value="warning">Warnings + Errors</option>
            </select>
            <button id="cons-refresh-btn">Refresh</button>
            <button id="cons-clear-btn">Clear</button>
          </div>
          <div id="cons-list"></div>
        </div>

        <div id="panel-audit" class="panel-view">
          <div class="toolbar">
            <button id="run-audit-btn" class="primary">Run Lighthouse Audit</button>
            <button id="run-perf-btn">Collect Web Vitals</button>
            <button id="run-sec-btn">Security Check</button>
          </div>
          <div id="audit-scores" class="score-grid"></div>
          <pre id="audit-out" class="box">Click "Run Lighthouse Audit" or "Collect Web Vitals" to inspect the active page.</pre>
        </div>

        <div id="panel-snapshot" class="panel-view">
          <div class="toolbar">
            <button id="snap-refresh-btn" class="primary">Capture Snapshot</button>
            <button id="snap-delta-btn">Preview Delta</button>
            <span id="snap-meta" style="color:var(--muted);font-size:12px"></span>
          </div>
          <pre id="snap-out" class="box">(no snapshot yet)</pre>
        </div>

        <div id="panel-workflows" class="panel-view">
          <div class="toolbar">
            <button id="wf-refresh-btn">Refresh</button>
          </div>
          <div id="metrics-cards" class="score-grid"></div>
          <div style="font-weight:600;margin:8px 0 5px;font-family:var(--sans)">Saved Workflows</div>
          <div id="wf-list"></div>
          <pre id="wf-code" class="box" style="display:none"></pre>
        </div>
      </div>
    </section>
  </main>
</div>

<div id="auth-modal" class="modal-backdrop">
  <div class="modal">
    <h3>Control Plane Bearer Token</h3>
    <p>Stored only in this browser tab's sessionStorage — never written to URLs or cookies.</p>
    <div class="field">
      <label for="token-input">AGENT_BROWSER_TOKEN</label>
      <input id="token-input" type="password" placeholder="Paste bearer token…" autocomplete="off" />
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button id="auth-cancel-btn">Cancel</button>
      <button id="auth-save-btn" class="primary">Connect</button>
    </div>
  </div>
</div>

<div id="session-modal" class="modal-backdrop">
  <div class="modal">
    <h3>New Isolated Browser Session</h3>
    <div class="field">
      <label for="ns-id">Session ID (optional)</label>
      <input id="ns-id" type="text" placeholder="e.g. qa-mobile" />
    </div>
    <div class="field">
      <label for="ns-proxy">Proxy URL (optional)</label>
      <input id="ns-proxy" type="text" placeholder="http://proxy.example.com:8080" />
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button id="ns-cancel-btn">Cancel</button>
      <button id="ns-create-btn" class="primary">Create</button>
    </div>
  </div>
</div>

<div id="toast" class="toast-msg"></div>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    token: sessionStorage.getItem('ab_token') || '',
    sessionId: sessionStorage.getItem('ab_session') || 'default',
    current: null,
    annotate: false,
    activePanel: 'timeline',
    sseAbort: null,
    shotUrl: null,
    dragStart: null,
  };

  function notify(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(notify._t);
    notify._t = setTimeout(() => { el.style.display = 'none'; }, 2800);
  }

  function authHeaders(extra = {}) {
    const h = { 'x-session-id': state.sessionId, ...extra };
    if (state.token) h.authorization = 'Bearer ' + state.token;
    return h;
  }

  async function api(path, body, opts = {}) {
    const method = opts.method || (body !== undefined ? 'POST' : 'GET');
    const headers = authHeaders(body !== undefined ? { 'content-type': 'application/json' } : {});
    const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (res.status === 401) {
      openAuthModal();
      throw new Error('Authentication required');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error || data.blocked || data.result?.error || data.result?.blocked) {
      throw new Error(data.error || data.reason || data.result?.error || data.result?.reason || ('HTTP ' + res.status));
    }
    return data.result !== undefined ? data.result : data;
  }

  async function refreshShot(fresh = false) {
    try {
      const qs = new URLSearchParams({ session: state.sessionId, t: String(Date.now()) });
      if (fresh) qs.set('fresh', '1');
      if (state.annotate) qs.set('annotate', '1');
      const res = await fetch('./api/shot.jpg?' + qs.toString(), { headers: authHeaders() });
      if (!res.ok) return;
      const blob = await res.blob();
      if (state.shotUrl) URL.revokeObjectURL(state.shotUrl);
      state.shotUrl = URL.createObjectURL(blob);
      const img = $('viewport-img');
      img.src = state.shotUrl;
      img.style.display = 'block';
      $('empty-stage').style.display = 'none';
    } catch {}
  }

  function renderApprovals(pending = []) {
    const bar = $('approvals-bar');
    bar.replaceChildren();
    bar.classList.toggle('visible', pending.length > 0);
    for (const p of pending) {
      const card = document.createElement('div');
      card.className = 'approval-card';
      const meta = document.createElement('div');
      meta.className = 'approval-meta';
      const title = document.createElement('div');
      title.className = 'approval-title';
      const secs = p.expiresAt ? Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000)) + 's left' : '';
      title.textContent = 'Approval Required [' + (p.rule || 'policy') + '] — ' + p.reason + (secs ? ' · ' + secs : '');
      const detail = document.createElement('div');
      detail.className = 'approval-detail';
      detail.textContent = p.detail || '';
      meta.append(title, detail);

      const allowBtn = document.createElement('button');
      allowBtn.className = 'ok';
      allowBtn.textContent = 'Approve';
      allowBtn.onclick = () => api('./api/approval', { id: p.id, allow: true }).then(() => notify('Approved ' + p.id)).catch((e) => notify(e.message));

      const denyBtn = document.createElement('button');
      denyBtn.className = 'danger';
      denyBtn.textContent = 'Deny';
      denyBtn.onclick = () => api('./api/approval', { id: p.id, allow: false }).then(() => notify('Denied ' + p.id)).catch((e) => notify(e.message));

      card.append(meta, allowBtn, denyBtn);
      bar.appendChild(card);
    }
  }

  function renderTabs(tabs = []) {
    const bar = $('tab-bar');
    bar.replaceChildren();
    for (const t of tabs) {
      const chip = document.createElement('div');
      chip.className = 'tab-chip' + (t.active ? ' active' : '');
      const lbl = document.createElement('span');
      lbl.textContent = (t.title || t.host || 'about:blank').slice(0, 32);
      chip.appendChild(lbl);
      chip.onclick = () => api('./api/tab', { op: 'select', id: t.id }).then(() => refreshShot(true)).catch((e) => notify(e.message));
      if (tabs.length > 1) {
        const x = document.createElement('span');
        x.className = 'tab-close';
        x.textContent = '×';
        x.onclick = (ev) => {
          ev.stopPropagation();
          api('./api/tab', { op: 'close', id: t.id }).then(() => refreshShot(true)).catch((e) => notify(e.message));
        };
        chip.appendChild(x);
      }
      bar.appendChild(chip);
    }
    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Tab';
    addBtn.style.padding = '2px 8px';
    addBtn.onclick = () => api('./api/tab', { op: 'new', url: 'about:blank' }).catch((e) => notify(e.message));
    bar.appendChild(addBtn);
  }

  function renderTimeline(logs = []) {
    const list = $('timeline-list');
    list.replaceChildren();
    for (const entry of logs.slice().reverse()) {
      const row = document.createElement('div');
      row.className = 'log-row';
      const time = document.createElement('span');
      time.style.color = 'var(--muted)';
      time.textContent = new Date(entry.at).toLocaleTimeString();
      const tag = document.createElement('span');
      tag.className = 'tag tag-' + (entry.kind || 'sys');
      tag.textContent = entry.kind || 'sys';
      const txt = document.createElement('span');
      txt.textContent = entry.text || '';
      row.append(time, tag, txt);
      list.appendChild(row);
    }
  }

  function applyState(s) {
    if (!s) return;
    const prevShot = state.current?.shotVersion;
    state.current = s;
    $('status-pill').textContent = s.paused ? 'PAUSED (takeover)' : (s.agentStatus || 'idle');
    const netCount = s.devtools?.network?.total || 0;
    const errCount = (s.devtools?.console?.errors || 0) + (s.devtools?.network?.failed || 0);
    $('devtools-pill').textContent = netCount + ' req · ' + errCount + ' err';
    if (document.activeElement !== $('url-input')) $('url-input').value = s.url || '';

    const paused = Boolean(s.paused);
    $('takeover-btn').classList.toggle('takeover-active', paused);
    $('takeover-btn').textContent = paused ? 'Hand Back' : 'Human Takeover';
    $('takeover-bar').classList.toggle('visible', paused);
    $('viewport-img').classList.toggle('takeover', paused);

    const rec = Boolean(s.workflow?.recording);
    $('rec-btn').classList.toggle('rec-active', rec);
    $('rec-btn').textContent = rec ? ('■ Stop (' + (s.workflow.stepCount || 0) + ')') : '● Record';

    renderApprovals(s.pending || []);
    renderTabs(s.tabs || []);
    renderTimeline(s.log || []);

    if (s.snapshot?.text) {
      $('snap-out').textContent = s.snapshot.text;
      $('snap-meta').textContent = (s.snapshot.tokens || 0) + ' tokens · ' + (s.snapshot.boxes?.length || 0) + ' refs';
    }
    if (s.shotVersion && s.shotVersion !== prevShot) refreshShot(false);
  }

  async function loadSessions() {
    const data = await api('./api/sessions');
    const sel = $('session-select');
    const ids = new Set((data.sessions || []).map((s) => s.id));
    ids.add(state.sessionId);
    sel.replaceChildren();
    for (const id of ids) {
      const opt = document.createElement('option');
      opt.value = id;
      const info = (data.sessions || []).find((s) => s.id === id);
      opt.textContent = id + (info?.pending ? ' (' + info.pending + ' approval)' : '') + (info?.paused ? ' [paused]' : '');
      opt.selected = id === state.sessionId;
      sel.appendChild(opt);
    }
  }

  // Authenticated fetch-based SSE reader so tokens never leak into query strings.
  async function connectEvents() {
    state.sseAbort?.abort();
    const ctrl = new AbortController();
    state.sseAbort = ctrl;
    $('conn-dot').className = 'dot warn';
    try {
      const res = await fetch('./api/events?session=' + encodeURIComponent(state.sessionId), {
        headers: authHeaders({ accept: 'text/event-stream' }),
        signal: ctrl.signal,
      });
      if (res.status === 401) {
        $('conn-dot').className = 'dot err';
        openAuthModal();
        return;
      }
      if (!res.ok || !res.body) throw new Error('SSE failed');
      $('conn-dot').className = 'dot live';
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\\n\\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === 'hello' || ev.type === 'state') applyState(ev.state);
              else if (ev.type === 'shot') refreshShot(false);
              else if (ev.type === 'approval') api('./api/state').then(applyState).catch(() => {});
            } catch {}
          }
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        $('conn-dot').className = 'dot err';
        setTimeout(connectEvents, 2500);
      }
    }
  }

  // Translate client pointer on rendered <img> to exact Chromium viewport coordinates.
  function imgCoords(ev) {
    const img = $('viewport-img');
    const r = img.getBoundingClientRect();
    const vw = state.current?.viewport?.width || img.naturalWidth || 1280;
    const vh = state.current?.viewport?.height || img.naturalHeight || 800;
    const x = Math.round(((ev.clientX - r.left) / Math.max(1, r.width)) * vw);
    const y = Math.round(((ev.clientY - r.top) / Math.max(1, r.height)) * vh);
    return { x: Math.max(0, Math.min(vw, x)), y: Math.max(0, Math.min(vh, y)) };
  }

  async function toggleTakeover(force) {
    const next = typeof force === 'boolean' ? force : !state.current?.paused;
    await api('./api/pause', { paused: next });
    if (next) await refreshShot(true);
    notify(next ? 'Human Takeover enabled — agent paused' : 'Control handed back to agent');
  }

  $('takeover-btn').onclick = () => toggleTakeover().catch((e) => notify(e.message));
  $('handback-btn').onclick = () => toggleTakeover(false).catch((e) => notify(e.message));

  const vImg = $('viewport-img');
  vImg.addEventListener('mousedown', (ev) => {
    if (!state.current?.paused || ev.button !== 0) return;
    state.dragStart = imgCoords(ev);
  });
  vImg.addEventListener('mouseup', (ev) => {
    if (!state.current?.paused || ev.button !== 0 || !state.dragStart) return;
    const end = imgCoords(ev);
    const start = state.dragStart;
    state.dragStart = null;
    if (Math.hypot(end.x - start.x, end.y - start.y) > 10) {
      api('./api/takeover', { op: 'drag', x: start.x, y: start.y, targetX: end.x, targetY: end.y }).then(() => refreshShot(false)).catch((e) => notify(e.message));
    } else {
      api('./api/takeover', { op: 'click', x: end.x, y: end.y }).then(() => refreshShot(false)).catch((e) => notify(e.message));
    }
  });
  vImg.addEventListener('dblclick', (ev) => {
    if (!state.current?.paused) return;
    const c = imgCoords(ev);
    api('./api/takeover', { op: 'dblclick', x: c.x, y: c.y }).then(() => refreshShot(false)).catch((e) => notify(e.message));
  });
  vImg.addEventListener('contextmenu', (ev) => {
    if (!state.current?.paused) return;
    ev.preventDefault();
    const c = imgCoords(ev);
    api('./api/takeover', { op: 'rightclick', x: c.x, y: c.y }).then(() => refreshShot(false)).catch((e) => notify(e.message));
  });
  vImg.addEventListener('wheel', (ev) => {
    if (!state.current?.paused) return;
    ev.preventDefault();
    api('./api/takeover', { op: 'wheel', dx: Math.round(ev.deltaX), dy: Math.round(ev.deltaY) }).then(() => refreshShot(false)).catch(() => {});
  }, { passive: false });

  $('send-text-btn').onclick = async () => {
    const input = $('takeover-text');
    if (!input.value) return;
    const secret = $('takeover-secret').checked;
    try {
      await api('./api/takeover', { op: 'type', text: input.value, secret });
      input.value = '';
      refreshShot(false);
    } catch (e) { notify(e.message); }
  };
  $('takeover-text').onkeydown = (ev) => { if (ev.key === 'Enter') $('send-text-btn').click(); };
  $('takeover-secret').onchange = (ev) => { $('takeover-text').type = ev.target.checked ? 'password' : 'text'; };
  document.querySelectorAll('[data-key]').forEach((btn) => {
    btn.onclick = () => api('./api/takeover', { op: 'press', key: btn.dataset.key }).then(() => refreshShot(false)).catch((e) => notify(e.message));
  });

  // Navigation & Toolbar
  async function goUrl() {
    const u = $('url-input').value.trim();
    if (!u) return;
    const endpoint = state.current?.paused ? './api/takeover' : './api/act';
    const payload = state.current?.paused ? { op: 'goto', url: u } : { op: 'open', url: u };
    await api(endpoint, payload);
    await refreshShot(true);
  }
  $('go-btn').onclick = () => goUrl().catch((e) => notify(e.message));
  $('url-input').onkeydown = (e) => { if (e.key === 'Enter') goUrl().catch((err) => notify(err.message)); };
  $('back-btn').onclick = () => api(state.current?.paused ? './api/takeover' : './api/act', { op: 'back' }).then(() => refreshShot(true)).catch((e) => notify(e.message));
  $('fwd-btn').onclick = () => api(state.current?.paused ? './api/takeover' : './api/act', { op: 'forward' }).then(() => refreshShot(true)).catch((e) => notify(e.message));
  $('reload-btn').onclick = () => api(state.current?.paused ? './api/takeover' : './api/act', { op: 'reload' }).then(() => refreshShot(true)).catch((e) => notify(e.message));
  $('shot-btn').onclick = () => refreshShot(true);
  $('annotate-btn').onclick = () => {
    state.annotate = !state.annotate;
    $('annotate-btn').classList.toggle('primary', state.annotate);
    refreshShot(true);
  };
  $('reset-btn').onclick = () => api('./api/reset', {}).then(() => notify('Session reset')).catch((e) => notify(e.message));

  $('rec-btn').onclick = async () => {
    try {
      if (state.current?.workflow?.recording) {
        const res = await api('./api/act', { op: 'workflow', sub: 'record_stop', save: true });
        notify('Saved workflow "' + res.data.workflow.name + '" (' + res.data.workflow.steps.length + ' steps)');
        loadWorkflowsAndMetrics();
      } else {
        const name = (prompt('Workflow name (letters, digits, - or _):', 'flow-' + Date.now().toString(36)) || '').trim();
        if (!name) return;
        await api('./api/act', { op: 'workflow', sub: 'record_start', name });
        notify('Recording "' + name + '"…');
      }
    } catch (e) { notify(e.message); }
  };

  $('session-select').onchange = (e) => {
    state.sessionId = e.target.value;
    sessionStorage.setItem('ab_session', state.sessionId);
    connectEvents();
    refreshShot(false);
  };

  // Inspector panels
  document.querySelectorAll('.panel-tab').forEach((btn) => {
    btn.onclick = () => {
      state.activePanel = btn.dataset.panel;
      document.querySelectorAll('.panel-tab').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.panel-view').forEach((v) => v.classList.toggle('active', v.id === 'panel-' + state.activePanel));
      if (state.activePanel === 'network') loadNetwork();
      if (state.activePanel === 'console') loadConsole();
      if (state.activePanel === 'workflows') loadWorkflowsAndMetrics();
    };
  });

  async function loadNetwork() {
    try {
      const type = $('net-filter').value;
      const data = await api('./api/network?limit=80&type=' + encodeURIComponent(type));
      const list = $('net-list');
      list.replaceChildren();
      for (const r of (data.requests || []).slice().reverse()) {
        const row = document.createElement('div');
        row.className = 'net-row';
        const stCls = r.failed || r.status >= 400 ? 's-err' : (r.status >= 300 ? 's-warn' : 's-ok');
        const cells = [
          [r.method, ''],
          [r.failed ? 'ERR' : String(r.status ?? '…'), stCls],
          [r.resourceType, ''],
          [r.durationMs != null ? r.durationMs + 'ms' : '—', ''],
          [r.url, 'net-url'],
        ];
        for (const [txt, cls] of cells) {
          const sp = document.createElement('span');
          if (cls) sp.className = cls;
          sp.textContent = txt;
          row.appendChild(sp);
        }
        row.onclick = async () => {
          const d = await api('./api/network?id=' + encodeURIComponent(r.id));
          const pre = $('net-detail');
          pre.style.display = 'block';
          pre.textContent = JSON.stringify(d, null, 2);
        };
        list.appendChild(row);
      }
    } catch (e) { notify(e.message); }
  }
  $('net-refresh-btn').onclick = loadNetwork;
  $('net-filter').onchange = loadNetwork;
  $('net-clear-btn').onclick = () => api('./api/act', { op: 'network', sub: 'clear' }).then(loadNetwork).catch((e) => notify(e.message));

  async function loadConsole() {
    try {
      const lvl = $('cons-level').value;
      const data = await api('./api/console?limit=100&level=' + encodeURIComponent(lvl));
      const list = $('cons-list');
      list.replaceChildren();
      for (const c of (data.entries || []).slice().reverse()) {
        const row = document.createElement('div');
        row.className = 'log-row';
        const tag = document.createElement('span');
        tag.className = 'tag tag-' + c.level;
        tag.textContent = c.level;
        const txt = document.createElement('span');
        txt.textContent = c.text + (c.stack ? '\\n' + c.stack : '');
        txt.style.whiteSpace = 'pre-wrap';
        row.append(tag, txt);
        list.appendChild(row);
      }
    } catch (e) { notify(e.message); }
  }
  $('cons-refresh-btn').onclick = loadConsole;
  $('cons-level').onchange = loadConsole;
  $('cons-clear-btn').onclick = () => api('./api/act', { op: 'console', sub: 'clear' }).then(loadConsole).catch((e) => notify(e.message));

  function renderScoreCards(container, items) {
    container.replaceChildren();
    for (const [label, val] of items) {
      const card = document.createElement('div');
      card.className = 'score-card';
      const v = document.createElement('div');
      v.className = 'score-val';
      v.textContent = String(val);
      const l = document.createElement('div');
      l.className = 'score-lbl';
      l.textContent = label;
      card.append(v, l);
      container.appendChild(card);
    }
  }

  $('run-audit-btn').onclick = async () => {
    try {
      const d = await api('./api/audit');
      const sc = d.scores || {};
      renderScoreCards($('audit-scores'), [
        ['Overall', sc.overall ?? '—'],
        ['A11y', sc.accessibility ?? '—'],
        ['SEO', sc.seo ?? '—'],
        ['Security', sc.security ?? '—'],
        ['Reliability', sc.reliability ?? '—'],
      ]);
      $('audit-out').textContent = JSON.stringify(d.issues || [], null, 2);
    } catch (e) { notify(e.message); }
  };
  $('run-perf-btn').onclick = () => api('./api/perf').then((d) => { $('audit-out').textContent = JSON.stringify(d, null, 2); }).catch((e) => notify(e.message));
  $('run-sec-btn').onclick = () => api('./api/security').then((d) => { $('audit-out').textContent = JSON.stringify(d, null, 2); }).catch((e) => notify(e.message));

  $('snap-refresh-btn').onclick = () => api('./api/act', { op: 'snapshot' }).then((d) => { $('snap-out').textContent = d.snapshot?.text || ''; }).catch((e) => notify(e.message));
  $('snap-delta-btn').onclick = () => api('./api/act', { op: 'snapshot', delta: true }).then((d) => {
    $('snap-out').textContent = d.snapshot?.text || '';
    if (d.snapshot?.savedTokens != null) notify('Delta saved ' + d.snapshot.savedTokens + ' tokens');
  }).catch((e) => notify(e.message));

  async function loadWorkflowsAndMetrics() {
    try {
      const [m, w] = await Promise.all([api('./api/metrics'), api('./api/workflows')]);
      renderScoreCards($('metrics-cards'), [
        ['Sessions', m.activeSessions],
        ['Actions', m.actionsTotal],
        ['Avg Latency', m.avgActionMs + 'ms'],
        ['Error Rate', (m.errorRate * 100).toFixed(1) + '%'],
        ['RSS MB', Math.round((m.memory?.rssBytes || 0) / 1048576)],
      ]);
      const list = $('wf-list');
      list.replaceChildren();
      for (const wf of w.workflows || []) {
        const row = document.createElement('div');
        row.className = 'log-row';
        row.style.alignItems = 'center';
        const title = document.createElement('span');
        title.style.flex = '1';
        title.textContent = wf.name + ' (' + wf.stepCount + ' steps' + (wf.variables?.length ? ' · vars: ' + wf.variables.join(', ') : '') + ')';
        const play = document.createElement('button');
        play.textContent = 'Replay';
        play.onclick = () => api('./api/act', { op: 'workflow', sub: 'replay', name: wf.name }).then((r) => { notify('Replayed ' + r.data.completed + '/' + r.data.total + ' steps'); refreshShot(true); }).catch((e) => notify(e.message));
        const exp = document.createElement('button');
        exp.textContent = '.spec.mjs';
        exp.onclick = () => api('./api/act', { op: 'workflow', sub: 'export', name: wf.name }).then((r) => {
          $('wf-code').style.display = 'block';
          $('wf-code').textContent = r.data.code;
        }).catch((e) => notify(e.message));
        row.append(title, play, exp);
        list.appendChild(row);
      }
      if (!(w.workflows || []).length) list.textContent = 'No saved workflows yet — click "● Record" in the header.';
    } catch (e) { notify(e.message); }
  }
  $('wf-refresh-btn').onclick = loadWorkflowsAndMetrics;

  // Modals
  function openAuthModal() {
    $('token-input').value = state.token;
    $('auth-modal').classList.add('open');
    $('token-input').focus();
  }
  $('auth-btn').onclick = openAuthModal;
  $('auth-cancel-btn').onclick = () => $('auth-modal').classList.remove('open');
  $('auth-save-btn').onclick = () => {
    state.token = $('token-input').value.trim();
    sessionStorage.setItem('ab_token', state.token);
    $('auth-modal').classList.remove('open');
    boot();
  };

  $('new-session-btn').onclick = () => $('session-modal').classList.add('open');
  $('ns-cancel-btn').onclick = () => $('session-modal').classList.remove('open');
  $('ns-create-btn').onclick = async () => {
    try {
      const payload = {};
      if ($('ns-id').value.trim()) payload.id = $('ns-id').value.trim();
      if ($('ns-proxy').value.trim()) payload.proxy = $('ns-proxy').value.trim();
      const created = await api('./api/sessions', payload);
      $('session-modal').classList.remove('open');
      state.sessionId = created.id || created.session?.id || 'default';
      sessionStorage.setItem('ab_session', state.sessionId);
      await loadSessions();
      connectEvents();
      notify('Switched to session "' + state.sessionId + '"');
    } catch (e) { notify(e.message); }
  };

  async function boot() {
    if (document.body.dataset.requiresAuth === '1' && !state.token) {
      openAuthModal();
      return;
    }
    await loadSessions().catch(() => {});
    connectEvents();
  }
  boot();
})();
</script>
</body>
</html>`;
}
