// sdk.mjs — a tiny client so *other* agents can drive this browser.
// The browser has no human UI contract: everything is 4 primitives.
//
//   const b = new AgentBrowser('http://localhost:3000');
//   await b.open('https://en.wikipedia.org/wiki/Headless_browser');
//   const doc = await b.snapshot();        // token-cheap Agent Document
//   await b.click('e12');
//   await b.type('e5', 'tokyo', { submit: true });

export class AgentBrowser {
  constructor(base = 'http://localhost:3000') {
    this.base = base.replace(/\/$/, '');
    this.lastDoc = null;
  }

  async #post(path, body) {
    const r = await fetch(this.base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  }

  /** tool: open(url) → Agent Document */
  async open(url) { const r = await this.#post('/api/act', { op: 'open', url }); return this.#doc(r); }

  /** tool: snapshot() → Agent Document (refs, roles, names, tokens) */
  async snapshot() {
    const r = await fetch(this.base + '/api/state').then((x) => x.json());
    this.lastDoc = r.snapshot || null;
    return this.lastDoc;
  }

  /** tool: click(ref) */
  async click(ref) { const r = await this.#post('/api/act', { op: 'click', ref }); return this.#doc(r); }

  /** tool: type(ref, text, {submit}) */
  async type(ref, text, { submit = false } = {}) { const r = await this.#post('/api/act', { op: 'type', ref, text, submit }); return this.#doc(r); }

  /** tool: scroll(dy) */
  async scroll(dy = 700) { const r = await this.#post('/api/act', { op: 'scroll', dy }); return this.#doc(r); }

  /** tool: navigate(back|forward|reload) */
  async nav(op) { const r = await this.#post('/api/act', { op }); return this.#doc(r); }

  /** tool: answer(goal) → { bullets, sources } — the built-in planner does the whole task */
  async task(goal) { const r = await this.#post('/api/task', { goal }); return r.answer; }

  async #doc(r) {
    if (r?.result?.blocked) return { blocked: true, reason: r.result.reason };
    return this.snapshot();
  }
}

// demo when run directly: `node sdk.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const b = new AgentBrowser(process.env.AB || 'http://localhost:3000');
  const doc = await b.open('https://en.wikipedia.org/wiki/Headless_browser');
  console.log(doc.text.split('\n').slice(0, 14).join('\n'));
  console.log(`\n— ${doc.tokens} tokens, ${doc.boxes.length} actionable refs`);
}
