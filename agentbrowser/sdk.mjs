// sdk.mjs — Zero-dependency JavaScript client for AgentBrowser v2.0 (Node 20+).

const DEFAULT_TIMEOUT_MS = 60_000;

export class AgentBrowser {
  constructor(base = 'http://127.0.0.1:3000', { token, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS, fetch: fetchImpl } = {}) {
    this.base = String(base).replace(/\/+$/, '');
    this.token = token ?? '';
    this.sessionId = sessionId ?? '';
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this._fetch = fetchImpl || null;
  }

  _getFetch() {
    return this._fetch || globalThis.fetch;
  }

  _headers(extra = {}, sessionOverride) {
    const headers = { ...extra };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const sid = sessionOverride !== undefined ? sessionOverride : this.sessionId;
    if (sid) headers['x-session-id'] = sid;
    return headers;
  }

  withSession(sessionId) {
    return new AgentBrowser(this.base, {
      token: this.token,
      sessionId,
      timeoutMs: this.timeoutMs,
      fetch: this._fetch,
    });
  }

  async request(path, body, { method, timeoutMs, sessionId, responseType = 'json', signal } = {}) {
    const httpMethod = method || (body === undefined ? 'GET' : 'POST');
    const headers = this._headers(
      body !== undefined ? { 'content-type': 'application/json' } : {},
      sessionId,
    );
    const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.timeoutMs;
    const timeoutSig = AbortSignal.timeout(ms);
    const init = {
      method: httpMethod,
      headers,
      signal: signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig,
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const r = await this._getFetch()(this.base + path, init);

    if (responseType === 'text') {
      const txt = await r.text();
      if (!r.ok) {
        const err = new Error(txt.slice(0, 180) || `HTTP ${r.status}`);
        err.status = r.status;
        throw err;
      }
      return txt;
    }

    if (responseType === 'buffer') {
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        const err = new Error(txt.slice(0, 180) || `HTTP ${r.status}`);
        err.status = r.status;
        throw err;
      }
      return Buffer.from(await r.arrayBuffer());
    }

    let data = null;
    try {
      data = await r.json();
    } catch {
      const text = typeof r.text === 'function' ? await r.text().catch(() => '') : '';
      if (!r.ok) throw new Error(text.slice(0, 180) || `HTTP ${r.status}`);
      throw new Error('invalid JSON response from server');
    }
    if (!r.ok) {
      const err = new Error(data?.error || `HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  }

  async _actRaw(action, reqOpts) {
    const { result } = await this.request('/api/act', action, reqOpts);
    if (result?.blocked || result?.error) {
      const err = new Error(result.reason || result.error);
      err.blocked = Boolean(result.blocked);
      throw err;
    }
    return result;
  }

  async act(action, reqOpts) {
    const result = await this._actRaw(action, reqOpts);
    return result?.data ?? result?.snapshot ?? null;
  }

  // ---------- Core Page & Advanced Element Actions ----------
  open(url, opts = {}) {
    return this.act({
      op: 'open',
      url,
      ...(opts.compact ? { compact: true } : {}),
      ...(opts.includeBody ? { includeBody: true } : {}),
    });
  }

  snapshot({ full = true, compact = false, delta, deltaMode } = {}) {
    return this.act({
      op: 'snapshot',
      full: compact ? false : full,
      compact,
      ...(delta !== undefined ? { delta: Boolean(delta) } : {}),
      ...(deltaMode !== undefined ? { deltaMode: Boolean(deltaMode) } : {}),
    });
  }

  delta({ full = true, compact = false } = {}) {
    return this.snapshot({ full, compact, delta: true });
  }

  click(ref, { button, doubleClick, modifiers, delta, compact } = {}) {
    return this.act({
      op: 'click',
      ref,
      button,
      doubleClick,
      ...(modifiers ? { modifiers } : {}),
      ...(delta !== undefined ? { delta: Boolean(delta) } : {}),
      compact,
    });
  }

  dblclick(ref, opts = {}) {
    return this.click(ref, { ...opts, doubleClick: true });
  }

  rightclick(ref, opts = {}) {
    return this.click(ref, { ...opts, button: 'right' });
  }

  drag(ref, targetOrOpts = {}, extra = {}) {
    const payload = typeof targetOrOpts === 'string'
      ? { op: 'drag', ref, targetRef: targetOrOpts, ...extra }
      : { op: 'drag', ref, ...targetOrOpts };
    return this.act(payload);
  }

  type(ref, text, submitOrOpts = {}) {
    const o = typeof submitOrOpts === 'boolean' ? { submit: submitOrOpts } : (submitOrOpts || {});
    const { submit = false, clear = true, secret = false, delta, compact } = o;
    return this.act({
      op: 'type',
      ref,
      text,
      submit,
      clear,
      secret,
      ...(delta !== undefined ? { delta: Boolean(delta) } : {}),
      compact,
    });
  }

  select(ref, value, { delta, compact } = {}) {
    return this.act({ op: 'select', ref, value, ...(delta !== undefined ? { delta: Boolean(delta) } : {}), compact });
  }

  press(keyOrKeys, refOrOpts) {
    const o = typeof refOrOpts === 'string' ? { ref: refOrOpts } : (refOrOpts || {});
    const { ref, delta, compact } = o;
    return this.act({
      op: 'press',
      ...(Array.isArray(keyOrKeys) ? { keys: keyOrKeys } : { key: keyOrKeys }),
      ...(ref ? { ref } : {}),
      ...(delta !== undefined ? { delta: Boolean(delta) } : {}),
      compact,
    });
  }

  clipboard(opOrText = 'read', opts = {}) {
    const known = new Set(['read', 'write', 'clear']);
    const payload = typeof opOrText === 'string' && known.has(opOrText)
      ? { op: 'clipboard', sub: opOrText, ...opts }
      : { op: 'clipboard', sub: 'write', text: String(opOrText ?? ''), ...opts };
    return this.act(payload);
  }

  hover(ref, { delta, compact } = {}) {
    return this.act({ op: 'hover', ref, ...(delta !== undefined ? { delta: Boolean(delta) } : {}), compact });
  }

  scroll(dyOrOpts = 700, extra = {}) {
    const payload = typeof dyOrOpts === 'object' && dyOrOpts !== null
      ? { op: 'scroll', ...dyOrOpts }
      : { op: 'scroll', dy: dyOrOpts, ...extra };
    return this.act(payload);
  }

  wait(opts = {}) {
    return this.act({ op: 'wait', ...opts });
  }

  waitFor(selector, timeoutMs = 8000, opts = {}) {
    return this.act({ op: 'wait', selector, timeoutMs, ...opts });
  }

  // ---------- Batch Actions & Workflow Record / Replay / Playwright Codegen ----------
  batch(steps, opts = {}) {
    return this.act({ op: 'batch', steps, ...opts });
  }

  workflow(opOrOpts = 'list', extra = {}) {
    if (typeof opOrOpts === 'object' && opOrOpts !== null) {
      const { op = 'list', sub, ...rest } = opOrOpts;
      return this.act({ op: 'workflow', sub: sub || op, ...rest });
    }
    return this.act({ op: 'workflow', sub: opOrOpts, ...extra });
  }

  startRecording(name, opts = {}) {
    return this.workflow('record_start', { name, ...opts });
  }

  stopRecording(opts = {}) {
    return this.workflow('record_stop', opts);
  }

  replayWorkflow(name, vars = {}, opts = {}) {
    return this.workflow('replay', { name, vars, ...opts });
  }

  exportPlaywright(name, opts = {}) {
    return this.workflow('export', { name, ...opts });
  }

  // ---------- Extraction, PDF, Downloads, Visual Regression & Browsing ----------
  extract(format = 'text', maxCharsOrOpts = 20000) {
    const opts = typeof maxCharsOrOpts === 'object' && maxCharsOrOpts !== null
      ? maxCharsOrOpts
      : { maxChars: maxCharsOrOpts };
    return this.act({ op: 'extract', format, ...opts });
  }

  async read({ maxChars = 20000 } = {}) {
    const r = await this._actRaw({ op: 'read', maxChars });
    return r.article;
  }

  async screenshot({ fullPage = false, type = 'png', quality, annotate = false, encoding } = {}) {
    const data = await this.act({ op: 'screenshot', fullPage, type, quality, annotate });
    if (encoding === 'buffer') return Buffer.from(data.base64, 'base64');
    return data;
  }

  async pdf(opts = {}) {
    const { encoding, ...rest } = opts || {};
    const data = await this.act({ op: 'pdf', ...rest });
    if (encoding === 'buffer') return Buffer.from(data.base64 || '', 'base64');
    return data;
  }

  downloads(idOrOpts) {
    if (idOrOpts === undefined) return this.request('/api/downloads');
    if (typeof idOrOpts === 'string') return this.act({ op: 'downloads', sub: 'inspect', id: idOrOpts });
    const { op = 'inspect', sub, ...rest } = idOrOpts;
    return this.act({ op: 'downloads', sub: sub || op, ...rest });
  }

  inspectDownload(id, opts = {}) {
    return this.act({ op: 'downloads', sub: 'inspect', ...(id ? { id } : {}), ...opts });
  }

  visualDiff(opOrName = 'compare', opts = {}) {
    const known = new Set(['baseline', 'capture', 'compare', 'list', 'delete']);
    if (typeof opOrName === 'object' && opOrName !== null) {
      const { op = 'compare', sub, ...rest } = opOrName;
      return this.act({ op: 'visual_diff', sub: sub || op, ...rest });
    }
    if (known.has(opOrName)) return this.act({ op: 'visual_diff', sub: opOrName, ...opts });
    return this.act({ op: 'visual_diff', sub: 'compare', name: opOrName, ...opts });
  }

  upload(ref, paths, { compact } = {}) {
    const list = Array.isArray(paths) ? paths : [paths];
    return this.act({ op: 'upload', ref, paths: list, compact });
  }

  navigate(action, { delta, compact } = {}) {
    if (!['back', 'forward', 'reload'].includes(action)) {
      throw new Error(`invalid navigate action: ${action}`);
    }
    return this.act({ op: action, ...(delta !== undefined ? { delta: Boolean(delta) } : {}), compact });
  }

  back(opts) { return this.navigate('back', opts); }
  forward(opts) { return this.navigate('forward', opts); }
  reload(opts) { return this.navigate('reload', opts); }

  async tabs(op = 'list', id, url) {
    if (op === 'list') return (await this.state()).tabs;
    return (await this.request('/api/tab', { op, id, url })).tabs;
  }

  async task(goal, opts = {}) {
    const { timeoutMs = 120_000, signal, ...taskOpts } = opts || {};
    const { answer } = await this.request('/api/task', { goal, ...taskOpts }, { timeoutMs, signal });
    if (!answer?.ok) throw new Error(answer?.error || 'task failed');
    return answer;
  }

  // ---------- F12 Agent DevTools ----------
  devtools() { return this.request('/api/devtools'); }

  network(optsOrId = {}) {
    if (typeof optsOrId === 'string') return this.act({ op: 'network', sub: 'get', id: optsOrId });
    const { op = 'list', sub, mockStatus, ...rest } = optsOrId || {};
    const chosen = sub || op;
    return this.act({
      op: 'network',
      sub: chosen,
      ...rest,
      ...(chosen === 'mock' && mockStatus !== undefined ? { status: mockStatus } : {}),
    });
  }

  console(opts = {}) {
    const { op = 'list', sub, ...rest } = opts || {};
    return this.act({ op: 'console', sub: sub || op, ...rest });
  }

  evaluate(expression, opts = {}) {
    return this.act({ op: 'evaluate', expression, ...opts });
  }

  inspect(refOrSelector, opts = {}) {
    if (typeof refOrSelector === 'object' && refOrSelector !== null) {
      return this.act({ op: 'inspect', ...refOrSelector });
    }
    const s = String(refOrSelector || '').trim();
    const key = /^e\d{1,8}$/.test(s) ? { ref: s } : { selector: s };
    return this.act({ op: 'inspect', ...key, ...opts });
  }

  a11y(opts = {}) {
    if (typeof opts === 'string') {
      const s = opts.trim();
      return this.act({ op: 'a11y', ...(/^e\d{1,8}$/.test(s) ? { ref: s } : { selector: s }) });
    }
    return this.act({ op: 'a11y', ...opts });
  }

  diff(opts = {}) {
    const o = typeof opts === 'string' ? { op: opts } : (opts || {});
    const { op = 'diff', sub, ...rest } = o;
    return this.act({ op: 'diff', sub: sub || op, ...rest });
  }

  perf() { return this.act({ op: 'perf' }); }
  audit() { return this.act({ op: 'audit' }); }

  storage(opts = {}) {
    const o = typeof opts === 'string' ? { op: opts } : (opts || {});
    const { op = 'inspect', sub, ...rest } = o;
    return this.act({ op: 'storage', sub: sub || op, ...rest });
  }

  security() { return this.act({ op: 'security' }); }

  emulate(opts = {}) {
    const payload = typeof opts === 'string' ? { op: 'emulate', device: opts } : { op: 'emulate', ...opts };
    return this.act(payload);
  }

  dialog(opts = {}) {
    const o = typeof opts === 'string' ? { op: opts } : (opts || {});
    const { op = 'list', sub, ...rest } = o;
    return this.act({ op: 'dialog', sub: sub || op, ...rest });
  }

  trace(opOrOpts = 'status') {
    if (typeof opOrOpts === 'string') return this.act({ op: 'trace', sub: opOrOpts });
    const { op = 'status', sub, ...rest } = opOrOpts || {};
    return this.act({ op: 'trace', sub: sub || op, ...rest });
  }

  // ---------- Governance, Human Takeover, Observability, Storage & Multi-Session ----------
  takeover(input) { return this.request('/api/takeover', input); }
  health() { return this.request('/api/health'); }
  metrics(format = 'json') {
    return format === 'prometheus'
      ? this.request('/metrics', undefined, { responseType: 'text' })
      : this.request('/api/metrics');
  }
  tools() { return this.request('/api/tools'); }
  state() { return this.request('/api/state'); }
  approve(id, allow) { return this.request('/api/approval', { id, allow }); }
  policy(patch) { return this.request('/api/policy', patch); }
  pause(paused = true) { return this.request('/api/pause', { paused: Boolean(paused) }); }
  reset() { return this.request('/api/reset', {}); }
  getStorage() { return this.request('/api/storage'); }
  setStorage(storageState) { return this.request('/api/storage', storageState); }

  async listSessions() {
    return (await this.request('/api/sessions', undefined, { sessionId: '' })).sessions;
  }

  createSession(opts = {}) {
    return this.request('/api/sessions', opts, { sessionId: '' });
  }

  closeSession(id = this.sessionId) {
    if (!id) throw new Error('session id required');
    return this.request(`/api/sessions/${encodeURIComponent(id)}`, undefined, { method: 'DELETE', sessionId: '' });
  }
}
