// Agent client for the headless control plane (Node 18+).
export class AgentBrowser {
  constructor(base = 'http://127.0.0.1:3000', { token } = {}) {
    this.base = base.replace(/\/$/, '');
    this.token = token;
  }
  async request(path, body) {
    const headers = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(this.base + path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }
  async act(action) {
    const { result } = await this.request('/api/act', action);
    if (result?.blocked || result?.error) throw new Error(result.reason || result.error);
    return result?.data ?? result?.snapshot ?? null;
  }
  open(url) { return this.act({ op: 'open', url }); }
  async snapshot() { return this.act({ op: 'snapshot' }); }
  click(ref) { return this.act({ op: 'click', ref }); }
  type(ref, text, { submit = false } = {}) { return this.act({ op: 'type', ref, text, submit }); }
  extract(format = 'text', maxChars = 20000) { return this.act({ op: 'extract', format, maxChars }); }
  waitFor(selector, timeoutMs = 10000) { return this.act({ op: 'wait', selector, timeoutMs }); }
  screenshot() { return this.act({ op: 'screenshot' }); }
  scroll(dy = 700) { return this.act({ op: 'scroll', dy }); }
  nav(op) { if (!['back', 'forward', 'reload'].includes(op)) throw new Error('invalid navigation operation'); return this.act({ op }); }
  async tabs(op = 'list', id) { return op === 'list' ? (await this.state()).tabs : (await this.request('/api/tab', { op, id })).tabs; }
  async state() { return this.request('/api/state'); }
  async task(goal) { const { answer } = await this.request('/api/task', { goal }); if (!answer?.ok) throw new Error(answer?.error || 'task failed'); return answer; }
  async approve(id, allow) { return this.request('/api/approval', { id, allow }); }
}
