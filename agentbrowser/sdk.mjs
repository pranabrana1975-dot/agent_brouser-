// sdk.mjs — Agent client for the headless AgentBrowser control plane (Node 20+).

const DEFAULT_TIMEOUT_MS = 60_000;

export class AgentBrowser {
  constructor(base = 'http://127.0.0.1:3000', { token, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS, fetch: fetchImpl } = {}) {
    this.base = String(base).replace(/\/$/, '');
    this.token = token || '';
    this.sessionId = sessionId || '';
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

  async request(path, body, { method, timeoutMs, sessionId } = {}) {
    const httpMethod = method || (body === undefined ? 'GET' : 'POST');
    const headers = this._headers(
      body !== undefined ? { 'content-type': 'application/json' } : {},
      sessionId,
    );
    const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.timeoutMs;
    const init = {
      method: httpMethod,
      headers,
      signal: AbortSignal.timeout(ms),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const r = await this._getFetch()(this.base + path, init);
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
    return result?.snapshot ?? null;
  }

  // ---------- page & element actions ----------
  open(url, opts = {}) {
    return this.act({ op: 'open', url, ...(opts.compact ? { compact: true } : {}) });
  }

  snapshot({ full = true, compact = false } = {}) {
    return this.act({ op: 'snapshot', full: compact ? false : full, compact });
  }

  click(ref, { button, doubleClick, compact } = {}) {
    return this.act({ op: 'click', ref, button, doubleClick, compact });
  }

  type(ref, text, { submit = false, clear = true, secret = false, compact } = {}) {
    return this.act({ op: 'type', ref, text, submit, clear, secret, compact });
  }

  select(ref, value, { compact } = {}) {
    return this.act({ op: 'select', ref, value, compact });
  }

  press(key, { ref, compact } = {}) {
    return this.act({ op: 'press', key, ref, compact });
  }

  hover(ref, { compact } = {}) {
    return this.act({ op: 'hover', ref, compact });
  }

  scroll(dy = 700, { dx = 0, ref, compact } = {}) {
    return this.act({ op: 'scroll', dy, dx, ref, compact });
  }

  wait({ text, selector, url, state, timeoutMs = 8000, compact } = {}) {
    const reqTimeout = Math.max(this.timeoutMs, Number(timeoutMs || 8000) + 5000);
    return this.act({ op: 'wait', text, selector, url, state, timeoutMs, compact }, { timeoutMs: reqTimeout });
  }

  async read({ maxChars = 20000 } = {}) {
    const res = await this._actRaw({ op: 'read', maxChars });
    return res?.article ?? { title: '', url: '', text: '', length: 0, truncated: false };
  }

  async screenshot({ fullPage = false, quality, encoding = 'buffer' } = {}) {
    const res = await this._actRaw({ op: 'screenshot', fullPage, quality });
    const shot = res?.screenshot;
    if (!shot?.data) throw new Error('screenshot capture failed');
    if (encoding === 'raw' || encoding === 'object') return shot;
    if (encoding === 'base64') return shot.data;
    return Buffer.from(shot.data, 'base64');
  }

  upload(ref, paths, { compact } = {}) {
    return this.act({ op: 'upload', ref, paths, compact });
  }

  nav(op, { compact } = {}) {
    if (!['back', 'forward', 'reload'].includes(op)) {
      throw new Error('invalid navigation operation');
    }
    return this.act({ op, compact });
  }

  // ---------- tabs & planner ----------
  async tabs(op = 'list', id, url) {
    if (op === 'list') return (await this.state()).tabs;
    return (await this.request('/api/tab', { op, id, url })).tabs;
  }

  async task(goal, { timeoutMs = 120_000 } = {}) {
    const { answer } = await this.request('/api/task', { goal }, { timeoutMs });
    if (!answer?.ok) throw new Error(answer?.error || 'task failed');
    return answer;
  }

  // ---------- governance, storage & introspection ----------
  health() { return this.request('/api/health'); }
  tools() { return this.request('/api/tools'); }
  state() { return this.request('/api/state'); }
  approve(id, allow) { return this.request('/api/approval', { id, allow }); }
  policy(patch) { return this.request('/api/policy', patch); }
  pause(paused) { return this.request('/api/pause', { paused: Boolean(paused) }); }
  reset() { return this.request('/api/reset', {}); }
  getStorage() { return this.request('/api/storage'); }
  setStorage(storageState) { return this.request('/api/storage', storageState); }
  downloads() { return this.request('/api/downloads'); }

  // ---------- multi-session management ----------
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
