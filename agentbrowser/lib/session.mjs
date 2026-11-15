// session.mjs — one agent browser session: real Chromium, tabs, actions,
// approvals, screenshots. The agent talks to this; the human only watches.

import { chromium } from 'playwright';
import { takeSnapshot } from './snapshot.mjs';
import { Policy, MIN_ACTION_INTERVAL_MS, MAX_ACTIONS_PER_TASK } from './policy.mjs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Session {
  constructor() {
    this.browser = null;
    this.ctx = null;
    this.tabs = [];
    this.activeId = null;
    this.nextTab = 1;
    this.log = [];
    this.listeners = new Set();
    this.policy = new Policy();
    this.pending = new Map();
    this.nextApproval = 1;
    this.snapshot = null;
    this.shotBuf = null;
    this.shotAt = 0;
    this.shotVersion = 0;
    this.busy = null;
    this.paused = false;
    this.stats = { actions: 0, snapshots: 0, tokens: 0, htmlBytes: 0, approvals: 0, taskRuns: 0 };
    this.lastActionAt = 0;
    this.agentStatus = 'idle';
  }

  // ---------- plumbing ----------
  emit(type, data) {
    const payload = { type, ...data };
    for (const fn of this.listeners) { try { fn(payload); } catch {} }
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  addLog(kind, text, meta) {
    const entry = { i: this.log.length + 1, at: Date.now(), kind, text, ...(meta || {}) };
    this.log.push(entry);
    if (this.log.length > 600) this.log.shift();
    this.emit('log', { entry });
    return entry;
  }

  setAgentStatus(s, detail) {
    this.agentStatus = s;
    this.emit('state', { state: this.state() });
  }

  async init() {
    if (this.browser) return;
    this.browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--disable-gpu'],
    });
    this.ctx = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: UA,
      locale: 'en-US',
      colorScheme: 'light',
      timezoneId: 'Asia/Kolkata',
    });
    await this.ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await this.newTab('about:blank');
    this.addLog('sys', `engine up · Chromium ${this.browser.version()} · viewport 1280×800`);
  }

  active() {
    const t = this.tabs.find((x) => x.id === this.activeId);
    return t ? t.page : null;
  }

  async newTab(url) {
    await this.init0();
    const page = await this.ctx.newPage();
    const id = 't' + this.nextTab++;
    page.on('dialog', async (d) => {
      this.addLog('policy', `dialog auto-dismissed (${d.type()}): ${String(d.message()).slice(0, 120)}`);
      try { await d.dismiss(); } catch {}
    });
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) this.emit('nav', { url: f.url() }); });
    this.tabs.push({ id, page, createdAt: Date.now() });
    this.activeId = id;
    if (url && url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
      this.addLog('err', `navigation failed: ${e.message.slice(0, 120)}`);
    });
    this.emit('state', { state: this.state() });
    return id;
  }

  async init0() { if (!this.browser) await this.init(); }

  async closeTab(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    try { await this.tabs[i].page.close(); } catch {}
    this.tabs.splice(i, 1);
    if (this.activeId === id) this.activeId = this.tabs[0]?.id || null;
    this.emit('state', { state: this.state() });
  }

  selectTab(id) {
    if (this.tabs.some((t) => t.id === id)) { this.activeId = id; this.emit('state', { state: this.state() }); }
  }

  tabList() {
    return this.tabs.map((t) => {
      let host = 'about:blank';
      try { host = new URL(t.page.url()).host || 'about:blank'; } catch {}
      return { id: t.id, url: t.page.url(), host, title: t.page.title ? '' : '' };
    });
  }

  async capture() {
    const page = this.active();
    if (!page) return;
    try {
      this.shotBuf = await page.screenshot({ type: 'jpeg', quality: 62, timeout: 8000 });
      this.shotAt = Date.now();
      this.shotVersion++;
      this.emit('shot', { v: this.shotVersion });
    } catch {}
  }

  async snap() {
    const page = this.active();
    if (!page) return null;
    const s = await takeSnapshot(page);
    this.snapshot = s;
    this.stats.snapshots++;
    this.stats.tokens += s.tokens;
    this.stats.htmlBytes += s.htmlBytes;
    await this.capture();
    this.emit('state', { state: this.state() });
    return s;
  }

  state() {
    return {
      ready: !!this.browser,
      engine: this.browser ? `Chromium ${this.browser.version()}` : 'not launched',
      activeId: this.activeId,
      tabs: this.tabs.map((t) => ({ id: t.id, url: t.page.url(), title: this.snapshot?.meta?.title || '' })),
      url: this.active()?.url() || '',
      title: this.snapshot?.meta?.title || '',
      shotVersion: this.shotVersion,
      shotAt: this.shotAt,
      snapshot: this.snapshot ? {
        text: this.snapshot.text,
        boxes: this.snapshot.boxes,
        tokens: this.snapshot.tokens,
        htmlBytes: this.snapshot.htmlBytes,
        meta: this.snapshot.meta,
      } : null,
      log: this.log.slice(-120),
      pending: [...this.pending.values()].map((p) => ({ id: p.id, reason: p.reason, detail: p.detail, rule: p.rule })),
      stats: this.stats,
      policy: {
        approvalsEnabled: this.policy.approvalsEnabled,
        blockedHosts: this.policy.blockedHosts,
        allowedHosts: this.policy.allowedHosts,
      },
      agentStatus: this.agentStatus,
      paused: this.paused,
    };
  }

  // ---------- approvals ----------
  requestApproval({ reason, detail, rule }) {
    const id = 'a' + this.nextApproval++;
    this.stats.approvals++;
    return new Promise((resolve) => {
      this.pending.set(id, { id, reason, detail, rule, resolve, at: Date.now() });
      this.addLog('approval', `approval requested · ${reason} · ${detail}`, { approvalId: id });
      this.emit('approval', { id, reason, detail, rule });
      this.emit('state', { state: this.state() });
    });
  }

  decideApproval(id, allow) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    this.addLog('approval', `${allow ? 'APPROVED' : 'DENIED'} by human · ${p.detail}`, { approvalId: id });
    p.resolve(allow);
    this.emit('state', { state: this.state() });
    return true;
  }

  // ---------- actions ----------
  async waitPause() {
    while (this.paused) await sleep(250);
  }

  async throttle() {
    const dt = Date.now() - this.lastActionAt;
    if (dt < MIN_ACTION_INTERVAL_MS) await sleep(MIN_ACTION_INTERVAL_MS - dt);
    this.lastActionAt = Date.now();
    if (this.stats.actions > MAX_ACTIONS_PER_TASK * 40) throw new Error('action budget exhausted');
  }

  async act(a) {
    await this.init();
    await this.waitPause();
    await this.throttle();
    const page = this.active();
    if (!page) throw new Error('no active tab');
    this.stats.actions++;

    switch (a.op) {
      case 'open': {
        let url = String(a.url || '').trim();
        if (!/^[a-z]+:/i.test(url)) url = 'https://' + url;
        const check = this.policy.hostAllowed(url);
        if (!check.ok) {
          this.addLog('policy', `navigation refused · ${check.reason} · ${url}`);
          return { blocked: true, reason: check.reason };
        }
        this.addLog('nav', `open ${url}`);
        this.setAgentStatus('navigating');
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
          await sleep(250);
        } catch (e) {
          this.addLog('err', `load problem: ${e.message.split('\n')[0].slice(0, 140)}`);
        }
        this.setAgentStatus('reading');
        return { ok: true, snapshot: await this.snap() };
      }

      case 'click': {
        const loc = page.locator(`[data-agent-ref="${a.ref}"]`).first();
        const box = this.snapshot?.boxes?.find((b) => b.ref === a.ref);
        if (!box) return { blocked: true, reason: `unknown ref ${a.ref} — take a snapshot first` };
        const verdict = this.policy.inspect({ name: box.name, href: '', text: box.role });
        if (verdict.requireApproval) {
          const allow = await this.requestApproval({ reason: verdict.reason, detail: `click ${a.ref} "${box.name}"`, rule: verdict.rule });
          if (!allow) { this.addLog('policy', `action denied · click ${a.ref}`); return { blocked: true, reason: 'denied by human' }; }
        }
        this.addLog('act', `click ${a.ref} ${box.role} "${box.name}"`);
        try {
          await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await loc.click({ timeout: 6000 });
          await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
          await sleep(300);
          return { ok: true, snapshot: await this.snap() };
        } catch (e) {
          return { error: e.message.split('\n')[0].slice(0, 160) };
        }
      }

      case 'type': {
        const box = this.snapshot?.boxes?.find((b) => b.ref === a.ref);
        if (!box) return { blocked: true, reason: `unknown ref ${a.ref}` };
        const verdict = this.policy.inspect({ name: box.name, text: a.text });
        if (verdict.requireApproval && a.submit) {
          const allow = await this.requestApproval({ reason: verdict.reason, detail: `type + submit in ${a.ref} "${box.name}"`, rule: verdict.rule });
          if (!allow) return { blocked: true, reason: 'denied by human' };
        }
        this.addLog('act', `type ${a.ref} ← ${JSON.stringify(String(a.text).slice(0, 80))}${a.submit ? ' + Enter' : ''}`);
        try {
          const loc = page.locator(`[data-agent-ref="${a.ref}"]`).first();
          await loc.click({ timeout: 5000 }).catch(() => {});
          await loc.fill(String(a.text), { timeout: 5000 }).catch(async () => {
            await loc.type(String(a.text), { delay: 18 });
          });
          if (a.submit) {
            await page.keyboard.press('Enter');
            await page.waitForLoadState('domcontentloaded', { timeout: 9000 }).catch(() => {});
            await sleep(400);
          }
          return { ok: true, snapshot: await this.snap() };
        } catch (e) {
          return { error: e.message.split('\n')[0].slice(0, 160) };
        }
      }

      case 'press': {
        this.addLog('act', `press ${a.key}`);
        try {
          await page.keyboard.press(String(a.key || 'Enter'));
          await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
          await sleep(300);
          return { ok: true, snapshot: await this.snap() };
        } catch (e) { return { error: e.message.slice(0, 160) }; }
      }

      case 'scroll': {
        const dy = a.dy ?? 700;
        this.addLog('act', `scroll ${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)}px`);
        await page.mouse.wheel(0, dy).catch(() => {});
        await sleep(300);
        return { ok: true, snapshot: await this.snap() };
      }

      case 'back':
      case 'forward': {
        this.addLog('act', a.op);
        await (a.op === 'back' ? page.goBack({ timeout: 15000 }) : page.goForward({ timeout: 15000 })).catch(() => {});
        await sleep(300);
        return { ok: true, snapshot: await this.snap() };
      }

      case 'reload': {
        this.addLog('act', 'reload');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await sleep(250);
        return { ok: true, snapshot: await this.snap() };
      }

      case 'snapshot':
      default: {
        return { ok: true, snapshot: await this.snap() };
      }
    }
  }

  // ---------- text extraction helper used by the agent ----------
  async pageText() {
    const page = this.active();
    if (!page) return { title: '', url: '', text: '' };
    // Chrome-only trick: clone the content root off-screen, delete chrome/nav
    // furniture from the clone, then read innerText so the agent gets prose —
    // not menus, cookie banners and category footers.
    const r = await page.evaluate(() => {
      const JUNK = 'nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo], '
        + '#catlinks, .navbox, .printfooter, .mw-editsection, .vector-toc, .sidebar, #toc, .cookie, '
        + '[class*=cookie], [id*=cookie], .advertisement, [class*=advert], .newsletter, .related-posts, '
        + '.site-header, .site-footer, .menu, [class*=nav], .breadcrumb, [aria-label*=navigation i], '
        + '#centralNotice, .centralNotice, .frb, #frb-inline, .mwe-popups, .vector-sticky-header, [class*=fundrais], '
        + '[id*=fundrais], [class*=donat], [class*=push-notif]';
      const src = document.querySelector('#bodyContent, main, article, [role=main]') || document.body;
      const clone = src.cloneNode(true);
      try { clone.querySelectorAll(JUNK + ', script, style, noscript, svg, iframe, template, link, meta').forEach((e) => e.remove()); } catch {}
      clone.style.cssText = 'position:fixed;left:-99999px;top:0;width:900px';
      document.body.appendChild(clone);
      const t = clone.innerText || clone.textContent || '';
      clone.remove();
      return {
        title: document.title,
        url: location.href,
        text: t.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim().slice(0, 20000),
      };
    });
    return r;
  }

  async results() {
    const page = this.active();
    if (!page) return [];
    return page.evaluate(() => {
      const clean = (s) => (s || '')
        .replace(/Translate this result/gi, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Bing wraps result urls in ?u=a1<base64url>
      const decodeBing = (href) => {
        try {
          const u = new URL(href);
          const raw = u.searchParams.get('u');
          if (!raw) return href;
          if (raw.startsWith('a1')) {
            let b = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
            while (b.length % 4) b += '=';
            return atob(b);
          }
          return href;
        } catch { return href; }
      };

      const out = [];
      for (const li of document.querySelectorAll('li.b_algo, div.b_algo')) {
        const a = li.querySelector('h2 a, a');
        if (!a) continue;
        const snipEl = li.querySelector('.b_caption p, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4, .b_algoSlug, p');
        out.push({
          title: clean(a.innerText).slice(0, 140),
          url: decodeBing(a.href),
          snippet: clean(snipEl ? snipEl.innerText : '').slice(0, 340),
        });
        if (out.length >= 6) break;
      }
      if (!out.length) {
        for (const li of document.querySelectorAll('#b_results > li')) {
          const a = li.querySelector('h2 a');
          if (!a) continue;
          out.push({ title: clean(a.innerText).slice(0, 140), url: decodeBing(a.href), snippet: clean(li.innerText).slice(0, 340) });
          if (out.length >= 6) break;
        }
      }
      if (!out.length) {
        for (const g of document.querySelectorAll('div.g, div.MjjYud')) {
          const a = g.querySelector('a[href^="http"]');
          const h = g.querySelector('h3, h2');
          if (!a || !h) continue;
          out.push({ title: clean(h.innerText).slice(0, 140), url: decodeBing(a.href), snippet: clean(g.innerText).slice(0, 340) });
          if (out.length >= 6) break;
        }
      }
      if (!out.length) {
        for (const a of document.querySelectorAll('a[href^="http"]')) {
          const t = clean(a.innerText);
          if (t.length < 25) continue;
          if (/^(home|about|login|sign in|privacy|terms|help)/i.test(t)) continue;
          out.push({ title: t.slice(0, 100), url: a.href, snippet: '' });
          if (out.length >= 6) break;
        }
      }
      return out;
    }).catch(() => []);
  }

  async shutdown() { try { await this.browser?.close(); } catch {} }
}
