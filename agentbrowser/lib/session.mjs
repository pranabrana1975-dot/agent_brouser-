// session.mjs — one isolated agent browser session: BrowserContext, tabs,
// actions, human approvals, reader extraction, screenshots, and storage state.

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { takeSnapshot, toWireSnapshot } from './snapshot.mjs';
import { extractPage } from './extract.mjs';
import { TabDevTools, ContextNetworkControls, NETWORK_PRESETS } from './devtools.mjs';
import {
  DEVICE_PRESETS,
  DEVTOOLS_INIT_SCRIPT,
  readToasts,
  inspectElement,
  captureA11yTree,
  diffSnapshots,
  collectPerformance,
  inspectStorage,
  clearStorage,
  inspectSecurity,
  runPageAudit,
  evaluateExpression,
  withAnnotatedOverlay,
} from './inspector.mjs';
import {
  Policy,
  envFlag,
  MIN_ACTION_INTERVAL_MS,
  MAX_ACTIONS_PER_SESSION,
} from './policy.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REF_RE = /^e\d{1,8}$/;
const FRAME_RE = /^f\d{1,3}$/;
const SAFE_KEY_RE = /^[a-zA-Z0-9+_.:-]{1,40}$/;

function parseViewport(input) {
  if (input && typeof input === 'object') {
    const width = Math.min(3840, Math.max(320, Math.trunc(Number(input.width) || 1280)));
    const height = Math.min(2160, Math.max(240, Math.trunc(Number(input.height) || 800)));
    return { width, height };
  }
  if (typeof input === 'string') {
    const m = input.trim().match(/^(\d{3,4})\s*[xX×,]\s*(\d{3,4})$/);
    if (m) {
      return {
        width: Math.min(3840, Math.max(320, Number(m[1]))),
        height: Math.min(2160, Math.max(240, Number(m[2]))),
      };
    }
  }
  return { width: 1280, height: 800 };
}

function buildUserAgent(browserVersion, override) {
  if (override && String(override).trim()) return String(override).trim();
  const m = String(browserVersion || '').match(/\d+\.\d+\.\d+\.\d+/);
  const ver = m ? m[0] : '136.0.0.0';
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
}

export function defaultLaunchOptions(opts = {}) {
  const noSandbox = typeof opts.noSandbox === 'boolean'
    ? opts.noSandbox
    : envFlag('AGENT_BROWSER_NO_SANDBOX', false);
  const headless = typeof opts.headless === 'boolean'
    ? opts.headless
    : envFlag('AGENT_BROWSER_HEADLESS', true);
  const executablePath = opts.executablePath ?? process.env.CHROMIUM_EXECUTABLE_PATH ?? '';
  const args = [
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-gpu',
  ];
  if (noSandbox) args.unshift('--no-sandbox', '--disable-setuid-sandbox');
  return {
    headless,
    args,
    noSandbox,
    ...(executablePath ? { executablePath } : {}),
  };
}

export class Session {
  constructor(opts = {}) {
    this.id = opts.id || 'default';
    this._getBrowser = typeof opts.getBrowser === 'function' ? opts.getBrowser : null;
    this._browserLauncher = opts.browserLauncher || ((launchOpts) => chromium.launch(launchOpts));
    this._ownsBrowser = !this._getBrowser;
    this._launchOpts = defaultLaunchOptions(opts);

    this.viewport = parseViewport(opts.viewport ?? process.env.AGENT_BROWSER_VIEWPORT);
    this.locale = String(opts.locale || process.env.AGENT_BROWSER_LOCALE || 'en-US');
    this.timezoneId = String(opts.timezoneId || process.env.AGENT_BROWSER_TIMEZONE || 'Asia/Kolkata');
    this.colorScheme = opts.colorScheme === 'dark' ? 'dark' : 'light';
    this.userAgentOverride = opts.userAgent ?? process.env.AGENT_BROWSER_UA ?? '';
    this.minActionIntervalMs = Number.isFinite(opts.minActionIntervalMs)
      ? Math.max(0, opts.minActionIntervalMs)
      : MIN_ACTION_INTERVAL_MS;
    this.maxActions = Number.isFinite(opts.maxActions) && opts.maxActions > 0
      ? opts.maxActions
      : MAX_ACTIONS_PER_SESSION;
    this.maxTabs = Number.isFinite(opts.maxTabs) && opts.maxTabs > 0
      ? opts.maxTabs
      : Number(process.env.AGENT_BROWSER_MAX_TABS || 12);
    this.uploadDir = opts.uploadDir ?? process.env.AGENT_BROWSER_UPLOAD_DIR ?? '';
    this.downloadDir = opts.downloadDir ?? process.env.AGENT_BROWSER_DOWNLOAD_DIR ?? '';
    this.traceDir = opts.traceDir ?? process.env.AGENT_BROWSER_TRACE_DIR ?? '';
    this.allowEval = typeof opts.allowEval === 'boolean'
      ? opts.allowEval
      : envFlag('AGENT_BROWSER_ALLOW_EVAL', false);
    this.allowSensitiveStorage = typeof opts.allowSensitiveStorage === 'boolean'
      ? opts.allowSensitiveStorage
      : envFlag('AGENT_BROWSER_ALLOW_STORAGE_VALUES', false);
    this.autoCaptureOnViewers = opts.autoCaptureOnViewers !== false;
    this.netControls = new ContextNetworkControls({ traceDir: this.traceDir });

    this.createdAt = Date.now();
    this.lastActiveAt = this.createdAt;
    this.browser = null;
    this.ctx = null;
    this.initPromise = null;
    this.tabs = [];
    this._knownPages = new WeakSet();
    this.activeId = null;
    this.nextTab = 1;
    this.nextRef = 0;
    this.log = [];
    this.nextLog = 1;
    this.listeners = new Set();
    this.policy = opts.policy instanceof Policy ? opts.policy : new Policy(opts.policy);
    this.pending = new Map();
    this.nextApproval = 1;
    this.snapshot = null;
    this.prevSnapshot = null;
    this.markedSnapshot = null;
    this.shotBuf = null;
    this.shotAt = 0;
    this.shotVersion = 0;
    this.busy = null;
    this.taskAbort = null;
    this.paused = false;
    this.stats = { actions: 0, snapshots: 0, tokens: 0, htmlBytes: 0, approvals: 0, taskRuns: 0 };
    this.sessionActions = 0;
    this.lastMutatingActionSeq = 0;
    this.lastActionAt = 0;
    this.agentStatus = 'idle';
    this.actionQueue = Promise.resolve();
    this.dirtyRisk = null;
    this.hasPassword = false;
    this.downloads = [];
    this._generation = 0;
    this._closed = false;
  }

  touch() {
    this.lastActiveAt = Date.now();
  }

  // ---------- events & logs ----------
  emit(type, data) {
    const payload = { type, sessionId: this.id, ...data };
    for (const fn of this.listeners) {
      try { fn(payload); } catch {}
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  addLog(kind, text, meta) {
    const entry = { i: this.nextLog++, at: Date.now(), kind, text, ...(meta || {}) };
    this.log.push(entry);
    if (this.log.length > 600) this.log.shift();
    this.emit('log', { entry });
    return entry;
  }

  setAgentStatus(s) {
    this.agentStatus = s;
    this.emit('state', { state: this.state() });
  }

  // ---------- browser & context lifecycle ----------
  async init() {
    if (this._closed) throw new Error(`session "${this.id}" is closed`);
    const connected = typeof this.browser?.isConnected === 'function' ? this.browser.isConnected() : Boolean(this.browser);
    if (this.ctx && connected) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init().finally(() => { this.initPromise = null; });
    return this.initPromise;
  }

  async _init() {
    if (this._getBrowser) {
      this.browser = await this._getBrowser();
    } else {
      const { headless, args, noSandbox, executablePath } = this._launchOpts;
      this.browser = await this._browserLauncher({
        headless,
        args,
        ...(executablePath ? { executablePath } : {}),
      });
      this.browser.on?.('disconnected', () => {
        this.browser = null;
        this.ctx = null;
        this.tabs = [];
        this.activeId = null;
        this.addLog('err', 'browser process disconnected — will relaunch on next action');
        this.emit('state', { state: this.state() });
      });
      if (noSandbox) {
        this.addLog('sys', 'warning · Chromium launched with --no-sandbox (AGENT_BROWSER_NO_SANDBOX=1)');
      }
    }

    const version = typeof this.browser.version === 'function' ? this.browser.version() : 'unknown';
    const userAgent = buildUserAgent(version, this.userAgentOverride);

    this.ctx = await this.browser.newContext({
      viewport: this.viewport,
      userAgent,
      locale: this.locale,
      colorScheme: this.colorScheme,
      timezoneId: this.timezoneId,
      acceptDownloads: Boolean(this.downloadDir),
    });

    this.ctx.on?.('close', () => {
      this.ctx = null;
    });

    // Capture popups and target="_blank" pages automatically instead of leaking them.
    this.ctx.on?.('page', (page) => {
      if (this._knownPages.has(page)) return;
      const tab = this._attachPage(page, { activate: true, source: 'popup' });
      if (tab) {
        this.addLog('nav', `popup captured → ${tab.id}`);
        this.emit('state', { state: this.state() });
      }
    });

    // Enforce host & SSRF policy first, then DevTools block rules & QA API mocks.
    await this.ctx.route('**/*', async (route) => {
      const req = route.request();
      const url = req.url();
      const rtype = typeof req.resourceType === 'function' ? req.resourceType() : '';
      if ((url.startsWith('data:') || url.startsWith('blob:')) && ['image', 'font', 'media', 'stylesheet'].includes(rtype)) {
        return route.continue();
      }
      const check = await this.policy.resolveAllowed(url);
      if (!check.ok) {
        this.addLog('policy', `request refused · ${check.reason}`);
        return route.abort('blockedbyclient');
      }
      const blockReason = this.netControls.shouldBlock(url);
      if (blockReason) {
        this.addLog('devtools', blockReason);
        return route.abort('blockedbyclient');
      }
      const method = typeof req.method === 'function' ? req.method() : 'GET';
      const mock = this.netControls.findMock(url, method);
      if (mock && typeof route.fulfill === 'function') {
        this.addLog('devtools', `mocked ${method} ${url.slice(0, 80)} → ${mock.status}`);
        return route.fulfill({
          status: mock.status,
          contentType: mock.contentType,
          headers: mock.headers,
          body: mock.body,
        });
      }
      return route.continue();
    });

    await this.ctx.addInitScript(DEVTOOLS_INIT_SCRIPT);

    await this._openNewTab('about:blank');
    this.addLog('sys', `session "${this.id}" up · Chromium ${version} · viewport ${this.viewport.width}×${this.viewport.height}`);
  }

  _clearFormTaint() {
    this.dirtyRisk = null;
    this.hasPassword = false;
  }

  async _refreshTabTitle(tab) {
    if (!tab?.page) return;
    try {
      const t = await tab.page.title();
      if (typeof t === 'string') tab.title = t.slice(0, 160);
    } catch {}
  }

  _attachPage(page, { activate = true, source = 'tab' } = {}) {
    if (this._knownPages.has(page)) {
      return this.tabs.find((t) => t.page === page) || null;
    }
    this._knownPages.add(page);

    if (this.tabs.length >= this.maxTabs) {
      this.addLog('policy', `${source} refused · max tabs (${this.maxTabs}) reached`);
      Promise.resolve(page.close?.()).catch(() => {});
      return null;
    }

    const id = 't' + this.nextTab++;
    const devtools = new TabDevTools(page, {
      getActionSeq: () => this.stats.actions,
      onDialogEvent: (rec) => {
        this.addLog('policy', `dialog ${rec.action} (${rec.type}): ${rec.message.slice(0, 120)}`);
        this.emit('dialog', { tabId: id, dialog: rec });
      },
    });
    const tab = { id, page, title: '', createdAt: Date.now(), devtools };
    this.tabs.push(tab);

    page.on?.('framenavigated', (f) => {
      const isMain = typeof page.mainFrame === 'function' ? f === page.mainFrame() : true;
      if (!isMain) return;
      if (this.activeId === id) this._clearFormTaint();
      void this._refreshTabTitle(tab);
      this.emit('nav', { tabId: id, url: f.url() });
    });

    page.on?.('load', () => {
      void this._refreshTabTitle(tab).then(() => this.emit('state', { state: this.state() }));
    });

    page.on?.('download', async (download) => {
      await this._handleDownload(download);
    });

    page.on?.('close', () => {
      void devtools.detach();
      const idx = this.tabs.findIndex((x) => x.id === id);
      if (idx >= 0) this.tabs.splice(idx, 1);
      if (this.activeId === id) {
        this.activeId = this.tabs[this.tabs.length - 1]?.id || null;
        this.snapshot = null;
        this.prevSnapshot = null;
        this.markedSnapshot = null;
        this.shotBuf = null;
        this._clearFormTaint();
      }
      this.emit('state', { state: this.state() });
    });

    if (activate) {
      this.activeId = id;
      this.snapshot = null;
      this.prevSnapshot = null;
      this.markedSnapshot = null;
      this.shotBuf = null;
      this._clearFormTaint();
    }
    return tab;
  }

  async _handleDownload(download) {
    const rawName = (typeof download.suggestedFilename === 'function' && download.suggestedFilename()) || 'download.bin';
    const safeName = path.basename(rawName).replace(/[^\w.\-() ]+/g, '_').slice(0, 120) || 'download.bin';
    if (!this.downloadDir) {
      this.addLog('policy', `download cancelled (AGENT_BROWSER_DOWNLOAD_DIR not set): ${safeName}`);
      try { await download.cancel?.(); } catch {}
      return;
    }
    try {
      await fs.mkdir(this.downloadDir, { recursive: true });
      const target = path.join(this.downloadDir, `${Date.now()}-${this.id}-${safeName}`);
      await download.saveAs(target);
      const item = {
        filename: safeName,
        path: target,
        url: typeof download.url === 'function' ? download.url() : '',
        at: Date.now(),
      };
      this.downloads.push(item);
      if (this.downloads.length > 50) this.downloads.shift();
      this.addLog('act', `download saved · ${safeName}`);
      this.emit('download', { download: item });
    } catch (e) {
      this.addLog('err', `download failed: ${String(e.message || e).slice(0, 120)}`);
    }
  }

  activeTab() {
    return this.tabs.find((x) => x.id === this.activeId) || null;
  }

  active() {
    return this.activeTab()?.page || null;
  }

  async _openNewTab(url = 'about:blank') {
    if (this.tabs.length >= this.maxTabs) {
      throw new Error(`maximum tab limit (${this.maxTabs}) reached`);
    }
    let target = String(url || 'about:blank').trim() || 'about:blank';
    if (target !== 'about:blank' && !/^[a-z]+:/i.test(target)) target = 'https://' + target;
    if (target !== 'about:blank') {
      const check = await this.policy.resolveAllowed(target);
      if (!check.ok) throw new Error(check.reason);
    }
    const page = await this.ctx.newPage();
    const tab = this._attachPage(page, { activate: true, source: 'tab' });
    if (!tab) throw new Error(`maximum tab limit (${this.maxTabs}) reached`);
    if (target !== 'about:blank') {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
        this.addLog('err', `navigation failed: ${String(e.message || e).slice(0, 120)}`);
      });
      await this._refreshTabTitle(tab);
    }
    this.emit('state', { state: this.state() });
    return tab.id;
  }

  // Serialized tab operations so tab switches/closes never interleave mid-action.
  enqueue(fn) {
    this.touch();
    const run = this.actionQueue.then(fn);
    this.actionQueue = run.catch(() => {});
    return run;
  }

  async tabOp(op, id, url) {
    return this.enqueue(async () => {
      await this.init();
      if (op === 'new') {
        await this._openNewTab(url || 'about:blank');
        await this.snap();
      } else if (op === 'close') {
        const idx = this.tabs.findIndex((t) => t.id === id);
        if (idx < 0) throw new Error(`unknown tab: ${id}`);
        const closing = this.tabs[idx];
        const wasActive = this.activeId === id;
        this.tabs.splice(idx, 1);
        try { await closing.page.close(); } catch {}
        if (wasActive) {
          this.activeId = this.tabs[this.tabs.length - 1]?.id || null;
          this.snapshot = null;
          this.prevSnapshot = null;
          this.markedSnapshot = null;
          this.shotBuf = null;
          this._clearFormTaint();
          if (this.activeId) await this.snap();
        }
        this.emit('state', { state: this.state() });
      } else if (op === 'select') {
        if (!this.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`);
        this.activeId = id;
        this.snapshot = null;
        this.prevSnapshot = null;
        this.markedSnapshot = null;
        this.shotBuf = null;
        this._clearFormTaint();
        await this.snap();
      } else {
        throw new Error(`invalid tab operation: ${op}`);
      }
      return this.tabList();
    });
  }

  async newTab(url = 'about:blank') {
    return this.enqueue(async () => {
      await this.init();
      const id = await this._openNewTab(url);
      await this.snap();
      return id;
    });
  }

  async closeTab(id) { return this.tabOp('close', id); }
  async selectTab(id) { return this.tabOp('select', id); }

  tabList() {
    return this.tabs.map((t) => {
      const url = typeof t.page?.url === 'function' ? t.page.url() : '';
      let host = 'about:blank';
      try { host = new URL(url).host || 'about:blank'; } catch {}
      return {
        id: t.id,
        url,
        host,
        title: t.title || '',
        active: t.id === this.activeId,
      };
    });
  }

  async capture({ fullPage = false, quality = 65, annotate = false } = {}) {
    await this.init();
    const page = this.active();
    if (!page) throw new Error('no active tab');
    const q = Math.min(95, Math.max(20, Math.trunc(Number(quality) || 65)));
    if (annotate && !this.snapshot) {
      await this.snap();
    }
    const doShot = async () => {
      const buf = await page.screenshot({ type: 'jpeg', quality: q, fullPage: Boolean(fullPage), timeout: 10000 });
      return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    };
    const buf = annotate
      ? await withAnnotatedOverlay(page, this.snapshot?.boxes || [], doShot)
      : await doShot();
    this.shotBuf = buf;
    this.shotAt = Date.now();
    this.shotVersion++;
    this.emit('shot', { v: this.shotVersion, at: this.shotAt });
    return this.shotBuf;
  }

  async snap(opts = {}) {
    const tab = this.activeTab();
    if (!tab) return null;
    let devtoolsBadge = '';
    if (tab.devtools) {
      const toasts = await readToasts(tab.page, { clear: false });
      const toastCount = Array.isArray(toasts) ? toasts.length : 0;
      devtoolsBadge = tab.devtools.badgeSummary({ toastCount });
    }
    const probeOpts = typeof opts === 'number'
      ? { startRef: opts, devtoolsBadge }
      : { startRef: this.nextRef, devtoolsBadge, ...(opts || {}) };
    const s = await takeSnapshot(tab.page, probeOpts);
    this.nextRef += s.boxes.length;
    if (this.snapshot) this.prevSnapshot = this.snapshot;
    this.snapshot = s;
    if (s.meta?.title !== undefined) tab.title = s.meta.title;
    this.stats.snapshots++;
    this.stats.tokens += s.tokens;
    this.stats.htmlBytes += s.htmlBytes;
    // Keep live screenshot buffer updated when observers subscribe to events.
    if (this.autoCaptureOnViewers && this.listeners.size > 0) {
      try {
        const buf = await tab.page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 });
        this.shotBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        this.shotAt = Date.now();
        this.shotVersion++;
        this.emit('shot', { v: this.shotVersion, at: this.shotAt });
      } catch {}
    }
    this.emit('state', { state: this.state() });
    return s;
  }

  state() {
    const activeTab = this.activeTab();
    const connected = typeof this.browser?.isConnected === 'function' ? this.browser.isConnected() : Boolean(this.browser);
    const ready = Boolean(this.ctx && connected);
    const ver = connected && typeof this.browser?.version === 'function' ? this.browser.version() : '';
    return {
      id: this.id,
      ready,
      engine: ready ? `Chromium ${ver}` : 'not launched',
      activeId: this.activeId,
      tabs: this.tabList(),
      url: activeTab?.page?.url?.() || '',
      title: activeTab?.title || this.snapshot?.meta?.title || '',
      shotVersion: this.shotVersion,
      shotAt: this.shotAt,
      snapshot: toWireSnapshot(this.snapshot, { full: true }),
      log: this.log.slice(-120),
      pending: [...this.pending.values()].map((p) => ({
        id: p.id,
        reason: p.reason,
        detail: p.detail,
        rule: p.rule,
        at: p.at,
        expiresAt: p.expiresAt,
      })),
      downloads: this.downloads.slice(-20),
      devtools: this.devtoolsOverview(),
      stats: { ...this.stats },
      policy: this.policy.toJSON(),
      agentStatus: this.agentStatus,
      paused: this.paused,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
    };
  }

  devtoolsOverview() {
    const dt = this.activeTab()?.devtools || null;
    return {
      console: dt ? {
        total: dt.console.length,
        errors: dt.console.filter((c) => c.level === 'error' || c.level === 'pageerror').length,
        warnings: dt.console.filter((c) => c.level === 'warning').length,
      } : { total: 0, errors: 0, warnings: 0 },
      network: dt ? {
        total: dt.requests.length,
        failed: dt.requests.filter((r) => r.failed).length,
        websockets: dt.websockets.length,
        wsFrames: dt.wsFrames.length,
        mocks: this.netControls.mocks.length,
        blockTrackers: this.netControls.blockTrackers,
        blockedPatterns: this.netControls.blockedPatterns.length,
        profile: this.netControls.networkProfile,
      } : { total: 0, failed: 0, websockets: 0, wsFrames: 0, mocks: 0, blockTrackers: false, blockedPatterns: 0 },
      dialogs: dt ? {
        total: dt.dialogs.length,
        mode: dt.dialogRule.mode,
        pending: dt.pendingDialog ? dt.pendingDialog.record : null,
      } : { total: 0, mode: 'dismiss', pending: null },
      emulation: { ...this.netControls.emulation },
      trace: this.netControls.traceStatus(),
      allowEval: this.allowEval,
    };
  }

  summary() {
    const activeTab = this.activeTab();
    return {
      id: this.id,
      ready: Boolean(this.ctx && this.browser),
      tabs: this.tabs.length,
      url: activeTab?.page?.url?.() || '',
      title: activeTab?.title || '',
      agentStatus: this.agentStatus,
      paused: this.paused,
      busy: Boolean(this.busy),
      pendingApprovals: this.pending.size,
      actions: this.stats.actions,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
    };
  }

  // ---------- approvals (with timeout so actionQueue never deadlocks) ----------
  requestApproval({ reason, detail, rule, timeoutMs }) {
    const id = 'a' + this.nextApproval++;
    this.stats.approvals++;
    const ttl = Number.isFinite(timeoutMs) ? timeoutMs : this.policy.approvalTimeoutMs;
    const at = Date.now();
    const expiresAt = ttl > 0 ? at + ttl : null;

    return new Promise((resolve) => {
      let timer = null;
      if (ttl > 0) {
        timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          this.addLog('approval', `TIMEOUT (${Math.round(ttl / 1000)}s) · auto-denied · ${detail}`, { approvalId: id });
          this.emit('state', { state: this.state() });
          resolve({ allow: false, reason: 'approval timed out' });
        }, ttl);
        timer.unref?.();
      }
      this.pending.set(id, { id, reason, detail, rule, resolve, timer, at, expiresAt });
      this.addLog('approval', `approval requested · ${reason} · ${detail}`, { approvalId: id });
      this.emit('approval', { id, reason, detail, rule, at, expiresAt });
      this.emit('state', { state: this.state() });
    });
  }

  decideApproval(id, allow) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    this.addLog('approval', `${allow ? 'APPROVED' : 'DENIED'} by human · ${p.detail}`, { approvalId: id });
    p.resolve({ allow: Boolean(allow), reason: allow ? '' : 'denied by human' });
    this.emit('state', { state: this.state() });
    return true;
  }

  _cancelAllPending(reason = 'session reset') {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      try { p.resolve({ allow: false, reason }); } catch {}
    }
    this.pending.clear();
  }

  // ---------- storage state (cookies + localStorage) ----------
  async getStorageState() {
    return this.enqueue(async () => {
      await this.init();
      return this.ctx.storageState();
    });
  }

  async setStorageState(storageState) {
    if (!storageState || typeof storageState !== 'object') {
      throw new Error('storageState object required');
    }
    const cookies = Array.isArray(storageState.cookies) ? storageState.cookies : [];
    const origins = Array.isArray(storageState.origins) ? storageState.origins : [];

    // Validate all cookies and origins against host policy before importing.
    for (const c of cookies) {
      const domain = String(c?.domain || '').replace(/^\./, '');
      const url = c?.url || (domain ? `https://${domain}/` : '');
      const check = this.policy.hostAllowed(url);
      if (!check.ok) throw new Error(`cookie rejected (${domain || url}): ${check.reason}`);
    }
    for (const o of origins) {
      const check = this.policy.hostAllowed(String(o?.origin || ''));
      if (!check.ok) throw new Error(`origin rejected (${o?.origin}): ${check.reason}`);
    }

    return this.enqueue(async () => {
      await this.init();
      if (cookies.length) await this.ctx.addCookies(cookies);
      if (origins.length) {
        const safeOrigins = origins.map((o) => ({
          origin: String(o.origin),
          localStorage: Array.isArray(o.localStorage)
            ? o.localStorage.map((kv) => ({ name: String(kv.name), value: String(kv.value ?? '') }))
            : [],
        }));
        await this.ctx.addInitScript((entries) => {
          try {
            const match = entries.find((e) => e.origin === location.origin);
            if (!match) return;
            for (const item of match.localStorage) localStorage.setItem(item.name, item.value);
          } catch {}
        }, safeOrigins);
      }
      this.addLog('sys', `storage imported · ${cookies.length} cookies · ${origins.length} origins`);
      return { cookies: cookies.length, origins: origins.length };
    });
  }

  // ---------- element lookup & upload jail ----------
  _findBox(ref) {
    const r = String(ref || '').trim();
    if (!REF_RE.test(r)) return null;
    return this.snapshot?.boxes?.find((b) => b.ref === r) || null;
  }

  _locatorFor(page, box) {
    if (box.frame && FRAME_RE.test(box.frame) && typeof page.frameLocator === 'function') {
      return page.frameLocator(`[data-agent-frame="${box.frame}"]`).locator(`[data-agent-ref="${box.ref}"]`).first();
    }
    return page.locator(`[data-agent-ref="${box.ref}"]`).first();
  }

  async _resolveUploadPaths(rawPaths) {
    if (!this.uploadDir) {
      throw new Error('file upload disabled (set AGENT_BROWSER_UPLOAD_DIR to allow jailed uploads)');
    }
    const list = Array.isArray(rawPaths) ? rawPaths : [rawPaths];
    if (!list.length || list.length > 10) throw new Error('provide between 1 and 10 upload file paths');
    const rootReal = await fs.realpath(this.uploadDir);
    const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
    const resolved = [];
    for (const item of list) {
      if (typeof item !== 'string' || !item.trim()) throw new Error('invalid upload file path');
      const candidate = path.resolve(rootReal, item);
      if (!candidate.startsWith(rootPrefix)) {
        throw new Error('upload path escapes AGENT_BROWSER_UPLOAD_DIR');
      }
      const real = await fs.realpath(candidate);
      if (!real.startsWith(rootPrefix)) {
        throw new Error('upload path escapes AGENT_BROWSER_UPLOAD_DIR');
      }
      const stat = await fs.stat(real);
      if (!stat.isFile()) throw new Error('upload target must be a regular file');
      resolved.push(real);
    }
    return resolved;
  }

  // ---------- action execution ----------
  async waitPause(gen) {
    while (this.paused && this._generation === gen && !this._closed) {
      await sleep(200);
    }
    if (this._generation !== gen || this._closed) throw new Error('action cancelled by session reset');
  }

  async throttle() {
    if (this.minActionIntervalMs > 0) {
      const dt = Date.now() - this.lastActionAt;
      if (dt < this.minActionIntervalMs) await sleep(this.minActionIntervalMs - dt);
    }
    this.lastActionAt = Date.now();
    if (this.sessionActions >= this.maxActions) {
      const err = new Error('session action budget exhausted — reset session to continue');
      err.code = 'BUDGET_EXHAUSTED';
      throw err;
    }
  }

  async act(a) {
    if (!a || typeof a !== 'object' || typeof a.op !== 'string') {
      throw new Error('action object with string "op" required');
    }
    const gen = this._generation;
    return this.enqueue(() => this.actNow(a, gen));
  }

  async actNow(a, gen = this._generation) {
    await this.init();
    await this.waitPause(gen);
    await this.throttle();
    const tab = this.activeTab();
    const page = tab?.page || null;
    if (!page) throw new Error('no active tab');
    this.stats.actions++;
    this.sessionActions++;
    const READONLY_OPS = new Set([
      'snapshot', 'extract', 'read', 'screenshot', 'network', 'console',
      'inspect', 'a11y', 'diff', 'perf', 'audit', 'security', 'trace',
    ]);
    if (!READONLY_OPS.has(a.op)) {
      this.lastMutatingActionSeq = this.stats.actions;
    }

    const wireOpts = { full: a.compact ? false : a.full !== false, includeBody: Boolean(a.includeBody) };

    switch (a.op) {
      case 'open': {
        let url = String(a.url || '').trim();
        if (!url) return { error: 'url required' };
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
        const check = await this.policy.resolveAllowed(url);
        if (!check.ok) {
          this.addLog('policy', `navigation refused · ${check.reason} · ${url}`);
          return { blocked: true, reason: check.reason };
        }
        this.addLog('nav', `open ${url}`);
        this.setAgentStatus('navigating');
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForLoadState?.('load', { timeout: 8000 }).catch(() => {});
          await sleep(180);
        } catch (e) {
          const error = `load problem: ${String(e.message || e).split('\n')[0].slice(0, 140)}`;
          this.addLog('err', error);
          return { error };
        }
        this._clearFormTaint();
        this.setAgentStatus('reading');
        const snap = await this.snap();
        return { ok: true, snapshot: toWireSnapshot(snap, wireOpts) };
      }

      case 'snapshot': {
        const snap = await this.snap();
        return { ok: true, snapshot: toWireSnapshot(snap, wireOpts) };
      }

      case 'click': {
        const box = this._findBox(a.ref);
        if (!box) return { blocked: true, reason: `unknown ref ${a.ref} — take a snapshot first` };
        if (box.disabled) return { blocked: true, reason: `element ${a.ref} is disabled` };
        const loc = this._locatorFor(page, box);
        const href = box.href || (await loc.getAttribute?.('href').catch(() => '')) || '';
        const verdict = this.policy.inspect({
          op: 'click',
          role: box.role,
          inputType: box.inputType,
          name: box.name,
          href,
          dirtyRisk: this.dirtyRisk,
          hasPassword: this.hasPassword,
        });
        if (verdict.requireApproval) {
          const decision = await this.requestApproval({
            reason: verdict.reason,
            detail: `click ${box.ref} "${box.name}"`,
            rule: verdict.rule,
          });
          if (!decision.allow) {
            this.addLog('policy', `action denied · click ${box.ref} (${decision.reason})`);
            return { blocked: true, reason: decision.reason };
          }
        }
        const button = ['left', 'right', 'middle'].includes(a.button) ? a.button : 'left';
        this.addLog('act', `${a.doubleClick ? 'dblclick' : 'click'} ${box.ref} ${box.role} "${box.name}"`);
        const tabsBefore = this.tabs.length;
        try {
          await loc.scrollIntoViewIfNeeded?.({ timeout: 3000 }).catch(() => {});
          if (a.doubleClick && typeof loc.dblclick === 'function') {
            await loc.dblclick({ button, timeout: 6000 });
          } else {
            await loc.click({ button, timeout: 6000 });
          }
          if (verdict.rule === 'credentials' || this.policy.isSubmitControl(box)) {
            this._clearFormTaint();
          }
          const targetPage = this.active() || page;
          await targetPage.waitForLoadState?.('domcontentloaded', { timeout: 6000 }).catch(() => {});
          await sleep(this.tabs.length > tabsBefore ? 350 : 220);
          const snap = await this.snap();
          return { ok: true, snapshot: toWireSnapshot(snap, wireOpts) };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 160) };
        }
      }

      case 'type': {
        const box = this._findBox(a.ref);
        if (!box) return { blocked: true, reason: `unknown ref ${a.ref} — take a snapshot first` };
        if (box.disabled) return { blocked: true, reason: `element ${a.ref} is disabled` };
        const text = String(a.text ?? '');
        const submit = Boolean(a.submit);
        const clear = a.clear !== false;
        const isSecret = box.role === 'password' || box.inputType === 'password' || Boolean(a.secret);

        const verdict = this.policy.inspect({
          op: 'type',
          role: box.role,
          inputType: box.inputType,
          name: box.name,
          text: isSecret ? '' : text,
          submit,
          hasPassword: isSecret || this.hasPassword,
        });
        if (verdict.requireApproval && submit) {
          const detail = isSecret
            ? `type secret + submit in ${box.ref} "${box.name}"`
            : `type + submit in ${box.ref} "${box.name}"`;
          const decision = await this.requestApproval({
            reason: verdict.reason,
            detail,
            rule: verdict.rule,
          });
          if (!decision.allow) return { blocked: true, reason: decision.reason };
        }

        const displayValue = isSecret ? '"••••••"' : JSON.stringify(text.slice(0, 80));
        this.addLog('act', `type ${box.ref} ← ${displayValue}${submit ? ' + Enter' : ''}`);

        try {
          const loc = this._locatorFor(page, box);
          await loc.click?.({ timeout: 5000 }).catch(() => {});
          if (clear && typeof loc.fill === 'function') {
            await loc.fill(text, { timeout: 5000 }).catch(async () => {
              await loc.type(text, { delay: 16 });
            });
          } else {
            await loc.type(text, { delay: 16 });
          }

          if (submit) {
            await page.keyboard.press('Enter');
            this._clearFormTaint();
            const targetPage = this.active() || page;
            await targetPage.waitForLoadState?.('domcontentloaded', { timeout: 9000 }).catch(() => {});
            await sleep(300);
          } else if (isSecret) {
            this.hasPassword = true;
          } else if (!this.policy.isSearchField(box)) {
            const hit = this.policy.matchRedZone(`${box.name} ${text}`);
            if (hit) this.dirtyRisk = hit;
          }

          const snap = await this.snap();
          return { ok: true, snapshot: toWireSnapshot(snap, wireOpts) };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 160) };
        }
      }

      case 'select': {
        const box = this._findBox(a.ref);
        if (!box) return { blocked: true, reason: `unknown ref ${a.ref} — take a snapshot first` };
        if (box.disabled) return { blocked: true, reason: `element ${a.ref} is disabled` };
        const values = Array.isArray(a.value) ? a.value.map(String) : [String(a.value ?? '')];
        if (!values.length || !values[0]) return { error: 'value required' };

        this.addLog('act', `select ${box.ref} "${box.name}" ← ${JSON.stringify(values).slice(0, 80)}`);
        try {
          const loc = this._locatorFor(page, box);
          const criteria = values.map((v) => {
            if (Array.isArray(box.options)) {
              const byVal = box.options.find((o) => o.value === v);
              if (byVal) return { value: byVal.value };
              const byLbl = box.options.find((o) => o.label.toLowerCase() === v.toLowerCase());
              if (byLbl) return { label: byLbl.label };
            }
            return { value: v };
          });
          await loc.selectOption(criteria, { timeout: 5000 }).catch(async () => {
            await loc.selectOption(values.map((label) => ({ label })), { timeout: 5000 });
          });
          await sleep(180);
          const snap = await this.snap();
          return { ok: true, snapshot: toWireSnapshot(snap, wireOpts) };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 160) };
        }
      }

      case 'press': {
        const key = String(a.key || '').trim();
        if (!SAFE_KEY_RE.test(key)) return { error: 'invalid key name' };
        let box = null;
        if (a.ref) {
          box = this._findBox(a.ref);
          if (!box) return { blocked: true, reason: `unknown ref ${a.ref} — take a snapshot first` };
        }
        if (/^(Enter|NumpadEnter)$/i.test(key) && (this.dirtyRisk || this.hasPassword)) {
          const verdict = this.policy.inspect({
            op: 'press',
            role: box?.role || '',
            name: box?.name || '',
            dirtyRisk: this.dirtyRisk,
            hasPassword: this.hasPassword,
          });
          if (verdict.requireApproval) {
            const decision = await this.requestApproval({
              reason: verdict.reason,
              detail: `press ${key}${box ? ` on ${box.ref} "${box.name}"` : ''}`,
              rule: verdict.rule,
            });
            if (!decision.allow) return { blocked: true, reason: decision.reason };
          }
          this._clearFormTaint();
        }
        this.addLog('act', `press ${key}${box ? ` on ${box.ref}` : ''}`);
        try {
          if (box) {
            const loc = this._locatorFor(page, box);
            await loc.focus?.({ timeout: 3000 }).catch(() => {});
          }
          await page.keyboard.press(key);
          if (/^(Enter|NumpadEnter)$/i.test(key)) {
            await page.waitForLoadState?.('domcontentloaded', { timeout: 6000 }).catch(() => {});
          }
          await sleep(180);
          const snap = await this.snap();
          return { ok: true, snapshot: toWireSnapshot(snap, wireOpts) };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 160) };
        }
      }

      case 'hover': {
        const box = this._findBox(a.ref);
        if (!box) return { blocked: true, reason: `unknown ref ${a.ref} — take a snapshot first` };
        this.addLog('act', `hover ${box.ref} ${box.role} "${box.name}"`);
        try {
          const loc = this._locatorFor(page, box);
          await loc.scrollIntoViewIfNeeded?.({ timeout: 3000 }).catch(() => {});
          await loc.hover({ timeout: 5000 });
          await sleep(220);
          const snap = await this.snap();
          return { ok: true, snapshot: toWireSnapshot(snap, wireOpts) };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 160) };
        }
      }

      case 'scroll': {
        if (a.ref) {
          const box = this._findBox(a.ref);
          if (!box) return { blocked: true, reason: `unknown ref ${a.ref} — take a snapshot first` };
          this.addLog('act', `scroll to ${box.ref} "${box.name}"`);
          try {
            await this._locatorFor(page, box).scrollIntoViewIfNeeded({ timeout: 4000 });
          } catch (e) {
            return { error: String(e.message || e).split('\n')[0].slice(0, 160) };
          }
        } else {
          const dy = Number.isFinite(Number(a.dy)) ? Number(a.dy) : 700;
          const dx = Number.isFinite(Number(a.dx)) ? Number(a.dx) : 0;
          this.addLog('act', `scroll ${dy >= 0 ? 'down' : 'up'} ${Math.abs(dy)}px${dx ? ` (dx=${dx})` : ''}`);
          await page.mouse.wheel(dx, dy).catch(() => {});
        }
        await sleep(220);
        const snap = await this.snap();
        return { ok: true, snapshot: toWireSnapshot(snap, wireOpts) };
      }

      case 'wait': {
        const timeout = Math.min(30000, Math.max(100, Math.trunc(Number(a.timeoutMs) || 8000)));
        try {
          if (typeof a.text === 'string' && a.text.trim()) {
            const needle = a.text.trim();
            this.addLog('act', `wait for text ${JSON.stringify(needle.slice(0, 60))}`);
            await page.getByText(needle).first().waitFor({ state: 'visible', timeout });
          } else if (typeof a.selector === 'string' && a.selector.trim()) {
            const sel = a.selector.trim();
            this.addLog('act', `wait for selector ${JSON.stringify(sel.slice(0, 60))}`);
            await page.locator(sel).first().waitFor({ state: 'visible', timeout });
          } else if (typeof a.url === 'string' && a.url.trim()) {
            const pattern = a.url.trim();
            this.addLog('act', `wait for url ${JSON.stringify(pattern.slice(0, 60))}`);
            await page.waitForURL(pattern, { timeout });
          } else {
            const loadState = ['load', 'domcontentloaded', 'networkidle'].includes(a.state)
              ? a.state
              : 'networkidle';
            this.addLog('act', `wait for load state "${loadState}"`);
            await page.waitForLoadState(loadState, { timeout });
          }
          const snap = await this.snap();
          return { ok: true, snapshot: toWireSnapshot(snap, wireOpts) };
        } catch (e) {
          return { error: `wait timed out: ${String(e.message || e).split('\n')[0].slice(0, 140)}` };
        }
      }

      case 'extract': {
        const format = a.format ?? 'text';
        const maxChars = a.maxChars ?? 20000;
        this.addLog('act', `extract ${format} (max ${maxChars} chars)`);
        try {
          const data = await extractPage(page, format, maxChars);
          return { ok: true, data };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 160) };
        }
      }

      case 'read': {
        const maxChars = Math.min(100000, Math.max(500, Math.trunc(Number(a.maxChars) || 20000)));
        this.addLog('act', `read article text (max ${maxChars} chars)`);
        try {
          const article = await this.pageText({ maxChars });
          return { ok: true, article };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 160) };
        }
      }

      case 'screenshot': {
        const imgType = a.type === 'jpeg' ? 'jpeg' : 'png';
        const annotate = Boolean(a.annotate);
        this.addLog('act', `screenshot (${imgType}${annotate ? ', annotated' : ''}${a.fullPage ? ', fullPage' : ''})`);
        try {
          if (imgType === 'jpeg') {
            const buf = await this.capture({ fullPage: Boolean(a.fullPage), quality: a.quality, annotate });
            const base64 = buf.toString('base64');
            return {
              ok: true,
              data: {
                mimeType: 'image/jpeg',
                base64,
                bytes: buf.length,
                annotated: annotate,
                shotVersion: this.shotVersion,
                shotAt: this.shotAt,
                url: tab?.page?.url?.() || '',
                title: tab?.title || '',
              },
            };
          }
          if (annotate && !this.snapshot) await this.snap();
          const takePng = async () => {
            const raw = await page.screenshot({ type: 'png', fullPage: Boolean(a.fullPage), timeout: 10000 });
            return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          };
          const buf = annotate
            ? await withAnnotatedOverlay(page, this.snapshot?.boxes || [], takePng)
            : await takePng();
          return {
            ok: true,
            data: {
              mimeType: 'image/png',
              base64: buf.toString('base64'),
              bytes: buf.length,
              annotated: annotate,
              url: tab?.page?.url?.() || '',
              title: tab?.title || '',
            },
          };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 160) };
        }
      }

      // ---------------- F12 Agent DevTools actions ----------------
      case 'network': {
        const dt = tab.devtools;
        const sub = String(a.sub || a.mode || 'list').toLowerCase();
        try {
          if (sub === 'list') {
            const sinceActionSeq = a.sinceLastAction ? this.lastMutatingActionSeq : null;
            return {
              ok: true,
              data: dt.listNetwork({
                resourceType: a.resourceType,
                status: a.status,
                url: a.url,
                sinceActionSeq,
                limit: a.limit,
              }),
            };
          }
          if (sub === 'get') {
            if (!a.id) return { error: 'request id required (e.g. r1)' };
            const entry = dt.getNetworkEntry(a.id, { maxChars: a.maxChars });
            if (!entry) return { error: `unknown request id: ${a.id}` };
            return { ok: true, data: entry };
          }
          if (sub === 'websockets') {
            return { ok: true, data: dt.listWebSockets({ wsId: a.wsId, limit: a.limit }) };
          }
          if (sub === 'har') {
            return { ok: true, data: dt.exportHar({ includeBodies: Boolean(a.includeBodies) }) };
          }
          if (sub === 'clear') {
            dt.clearNetwork();
            this.addLog('devtools', 'network log cleared');
            return { ok: true, data: { cleared: true } };
          }
          if (sub === 'throttle') {
            const presetName = a.preset ? String(a.preset).toLowerCase() : '';
            const profileInput = presetName
              ? presetName
              : {
                  offline: Boolean(a.offline),
                  latencyMs: a.latencyMs ?? 0,
                  downloadKbps: a.downloadKbps ?? -1,
                  uploadKbps: a.uploadKbps ?? -1,
                };
            if (presetName && !NETWORK_PRESETS[presetName]) {
              return { error: `unknown throttle preset: ${presetName}` };
            }
            const applied = await dt.applyNetworkThrottle(this.ctx, profileInput);
            this.netControls.networkProfile = { ...applied, preset: presetName || 'custom' };
            this.netControls.emulation.offline = applied.offline;
            this.addLog('devtools', `network throttle → ${presetName || JSON.stringify(applied)}`);
            return { ok: true, data: this.netControls.networkProfile };
          }
          if (sub === 'block') {
            const updated = this.netControls.setBlocked({ patterns: a.patterns, blockTrackers: a.blockTrackers });
            this.addLog('devtools', `network block updated · trackers=${updated.blockTrackers} · patterns=${updated.blockedPatterns.length}`);
            return { ok: true, data: updated };
          }
          if (sub === 'mock') {
            const added = this.netControls.addMock({
              urlPattern: a.urlPattern,
              method: a.method,
              status: a.status,
              contentType: a.contentType,
              body: a.body,
              headers: a.headers,
            });
            this.addLog('devtools', `network mock added · ${added.method} ${added.urlPattern} → ${added.status}`);
            return { ok: true, data: added };
          }
          if (sub === 'unmock') {
            const cleared = this.netControls.clearMocks(a.id);
            this.addLog('devtools', `network mocks cleared · removed=${cleared.removed}`);
            return { ok: true, data: cleared };
          }
          return { error: `unknown network operation: ${sub}` };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
        }
      }

      case 'console': {
        const dt = tab.devtools;
        const sub = String(a.sub || a.mode || 'list').toLowerCase();
        if (sub === 'clear') {
          dt.clearConsole();
          this.addLog('devtools', 'console log cleared');
          return { ok: true, data: { cleared: true } };
        }
        if (sub !== 'list') return { error: `unknown console operation: ${sub}` };
        const sinceActionSeq = a.sinceLastAction ? this.lastMutatingActionSeq : null;
        return {
          ok: true,
          data: dt.listConsole({
            level: a.level,
            search: a.search,
            sinceActionSeq,
            limit: a.limit,
          }),
        };
      }

      case 'evaluate': {
        if (!this.allowEval) {
          return {
            blocked: true,
            reason: 'browser_evaluate is disabled by default (set AGENT_BROWSER_ALLOW_EVAL=1 for trusted debugging)',
          };
        }
        const expression = String(a.expression || '').trim();
        if (!expression) return { error: 'expression required' };
        if (this.policy.approvalsEnabled) {
          const decision = await this.requestApproval({
            reason: 'page JavaScript execution',
            detail: `evaluate JS: ${expression.slice(0, 90)}`,
            rule: 'evaluate',
          });
          if (!decision.allow) return { blocked: true, reason: decision.reason };
        }
        this.addLog('devtools', `evaluate JS (${expression.length} chars)`);
        try {
          const data = await evaluateExpression(page, expression, { timeoutMs: a.timeoutMs });
          return { ok: true, data };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 200) };
        }
      }

      case 'inspect': {
        let ref = a.ref ? String(a.ref).trim() : '';
        const selector = a.selector ? String(a.selector).trim() : '';
        if (!ref && !selector) return { error: 'provide ref (e.g. e3) or CSS selector' };
        if (selector.length > 1000) return { error: 'selector too long' };
        let frame = '';
        if (ref) {
          const box = this._findBox(ref);
          if (!box) return { blocked: true, reason: `unknown ref ${ref} — take a snapshot first` };
          frame = box.frame || '';
        }
        this.addLog('devtools', `inspect ${ref || selector.slice(0, 60)}`);
        try {
          const data = await inspectElement(page, { ref, selector, frame });
          return { ok: true, data };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
        }
      }

      case 'a11y': {
        const ref = a.ref ? String(a.ref).trim() : '';
        const selector = a.selector ? String(a.selector).trim() : '';
        let locator = null;
        if (ref) {
          const box = this._findBox(ref);
          if (!box) return { blocked: true, reason: `unknown ref ${ref} — take a snapshot first` };
          locator = this._locatorFor(page, box);
        }
        this.addLog('devtools', `a11y tree ${ref || selector || 'document'}`);
        try {
          const data = await captureA11yTree(page, { locator, ref, selector, maxChars: a.maxChars });
          return { ok: true, data };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
        }
      }

      case 'diff': {
        const sub = String(a.sub || a.mode || 'diff').toLowerCase();
        if (sub === 'mark') {
          const snap = this.snapshot || (await this.snap());
          this.markedSnapshot = snap;
          await readToasts(page, { clear: true });
          this.addLog('devtools', 'diff checkpoint marked');
          return { ok: true, data: { marked: true, url: snap?.meta?.url || '', controls: snap?.boxes?.length || 0 } };
        }
        const before = a.sinceMark && this.markedSnapshot ? this.markedSnapshot : this.prevSnapshot;
        const fresh = a.refresh ? await this.snap() : (this.snapshot || (await this.snap()));
        const baseline = a.refresh && !a.sinceMark ? this.prevSnapshot : before;
        const rawToasts = await readToasts(page, { clear: Boolean(a.clearToasts) });
        const toasts = Array.isArray(rawToasts) ? rawToasts : [];
        return { ok: true, data: diffSnapshots(baseline, fresh, toasts) };
      }

      case 'perf': {
        this.addLog('devtools', 'collect performance metrics');
        try {
          const cdp = await tab.devtools.ensureCdp(this.ctx);
          const data = await collectPerformance(page, { cdp });
          return { ok: true, data };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
        }
      }

      case 'audit': {
        this.addLog('devtools', 'run page audit');
        try {
          const cdp = await tab.devtools.ensureCdp(this.ctx);
          const data = await runPageAudit(page, { tabDevtools: tab.devtools, cdp });
          return { ok: true, data };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
        }
      }

      case 'storage': {
        const sub = String(a.sub || a.mode || 'inspect').toLowerCase();
        try {
          if (sub === 'clear') {
            if (this.policy.approvalsEnabled) {
              const decision = await this.requestApproval({
                reason: 'clear browser storage/cookies',
                detail: `clear storage [${(a.targets || ['cookies', 'localStorage', 'sessionStorage']).join(', ')}]`,
                rule: 'destructive',
              });
              if (!decision.allow) return { blocked: true, reason: decision.reason };
            }
            const res = await clearStorage(page, this.ctx, a.targets);
            this.addLog('devtools', `storage cleared · [${res.cleared.join(', ')}]`);
            return { ok: true, data: res };
          }
          if (sub !== 'inspect') return { error: `unknown storage operation: ${sub}` };
          const includeValues = Boolean(a.includeValues && this.allowSensitiveStorage);
          const data = await inspectStorage(page, this.ctx, { includeValues });
          return { ok: true, data };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
        }
      }

      case 'security': {
        this.addLog('devtools', 'inspect page security & third-party requests');
        try {
          const data = await inspectSecurity(page, this.ctx, tab.devtools);
          return { ok: true, data };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
        }
      }

      case 'emulate': {
        try {
          const emu = this.netControls.emulation;
          let targetViewport = null;
          let targetUa = a.userAgent !== undefined ? String(a.userAgent) : null;
          let deviceScaleFactor = 1;
          let mobile = false;

          if (a.device) {
            const preset = DEVICE_PRESETS[String(a.device).toLowerCase()];
            if (!preset) return { error: `unknown device preset: ${a.device} (use ${Object.keys(DEVICE_PRESETS).join(', ')})` };
            emu.device = preset.name;
            targetViewport = { ...preset.viewport };
            deviceScaleFactor = preset.deviceScaleFactor;
            mobile = preset.mobile;
            if (targetUa === null && preset.userAgent) targetUa = preset.userAgent;
          }

          if (a.viewport && typeof a.viewport === 'object') {
            targetViewport = parseViewport(a.viewport);
            if (!a.device) emu.device = 'custom';
          } else if (Number.isFinite(a.width) && Number.isFinite(a.height)) {
            targetViewport = parseViewport({ width: a.width, height: a.height });
            if (!a.device) emu.device = 'custom';
          }

          if (targetViewport) {
            await page.setViewportSize?.(targetViewport);
            this.viewport = targetViewport;
            emu.viewport = targetViewport;
          }

          const cdp = await tab.devtools.ensureCdp(this.ctx);
          if (cdp && (a.device || targetUa !== null || a.timezoneId)) {
            if (a.device && targetViewport) {
              await cdp.send('Emulation.setDeviceMetricsOverride', {
                width: targetViewport.width,
                height: targetViewport.height,
                deviceScaleFactor,
                mobile,
              }).catch(() => {});
              await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile }).catch(() => {});
            }
            if (targetUa !== null && targetUa !== '') {
              await cdp.send('Emulation.setUserAgentOverride', { userAgent: targetUa }).catch(() => {});
            }
            if (a.timezoneId) {
              const tz = String(a.timezoneId).trim();
              if (!/^[A-Za-z0-9_/+.-]{2,64}$/.test(tz)) return { error: 'invalid timezoneId' };
              await cdp.send('Emulation.setTimezoneOverride', { timezoneId: tz });
              emu.timezoneId = tz;
            }
          }

          const mediaPatch = {};
          if (a.colorScheme) {
            if (!['light', 'dark', 'no-preference'].includes(a.colorScheme)) return { error: 'invalid colorScheme' };
            mediaPatch.colorScheme = a.colorScheme;
            emu.colorScheme = a.colorScheme;
          }
          if (a.reducedMotion) {
            if (!['reduce', 'no-preference'].includes(a.reducedMotion)) return { error: 'invalid reducedMotion' };
            mediaPatch.reducedMotion = a.reducedMotion;
            emu.reducedMotion = a.reducedMotion;
          }
          if (a.media) {
            if (!['screen', 'print'].includes(a.media)) return { error: 'invalid media type' };
            mediaPatch.media = a.media;
            emu.media = a.media;
          }
          if (Object.keys(mediaPatch).length) {
            await page.emulateMedia?.(mediaPatch);
          }

          if (typeof a.offline === 'boolean') {
            await this.ctx.setOffline?.(a.offline);
            emu.offline = a.offline;
            this.netControls.networkProfile.offline = a.offline;
          }

          if (a.geolocation && typeof a.geolocation === 'object') {
            const lat = Number(a.geolocation.latitude);
            const lng = Number(a.geolocation.longitude);
            const acc = a.geolocation.accuracy !== undefined ? Math.max(0, Number(a.geolocation.accuracy)) : 50;
            if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
              return { error: 'invalid geolocation coordinates' };
            }
            await this.ctx.grantPermissions?.(['geolocation']).catch(() => {});
            await this.ctx.setGeolocation?.({ latitude: lat, longitude: lng, accuracy: acc });
            emu.geolocation = { latitude: lat, longitude: lng, accuracy: acc };
          }

          this.addLog('devtools', `emulate updated · device=${emu.device || 'default'} · ${this.viewport.width}×${this.viewport.height} · ${emu.colorScheme}`);
          const snap = await this.snap();
          return { ok: true, data: { emulation: { ...emu, viewport: this.viewport }, snapshot: toWireSnapshot(snap, wireOpts) } };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
        }
      }

      case 'dialog': {
        const dt = tab.devtools;
        const sub = String(a.sub || a.mode || 'list').toLowerCase();
        if (sub === 'list') {
          return {
            ok: true,
            data: {
              rule: { ...dt.dialogRule },
              pending: dt.pendingDialog ? dt.pendingDialog.record : null,
              dialogs: [...dt.dialogs],
            },
          };
        }
        if (sub === 'set') {
          const action = String(a.action || 'dismiss').toLowerCase();
          if (!['accept', 'dismiss', 'manual'].includes(action)) {
            return { error: 'dialog action must be accept, dismiss, or manual' };
          }
          dt.dialogRule = {
            mode: action,
            promptText: a.promptText !== undefined ? String(a.promptText) : '',
            once: Boolean(a.once),
          };
          this.addLog('devtools', `dialog rule → ${action}${dt.dialogRule.once ? ' (once)' : ''}`);
          return { ok: true, data: { rule: { ...dt.dialogRule } } };
        }
        if (sub === 'accept' || sub === 'dismiss') {
          if (!dt.pendingDialog) return { error: 'no pending dialog' };
          const id = dt.pendingDialog.id;
          await dt.pendingDialog.decide(sub === 'accept', a.promptText);
          return { ok: true, data: { id, action: sub === 'accept' ? 'accepted' : 'dismissed' } };
        }
        if (sub === 'clear') {
          dt.dialogs = [];
          return { ok: true, data: { cleared: true } };
        }
        return { error: `unknown dialog operation: ${sub}` };
      }

      case 'trace': {
        const sub = String(a.sub || a.mode || 'status').toLowerCase();
        try {
          if (sub === 'status') return { ok: true, data: this.netControls.traceStatus() };
          if (sub === 'start') {
            const started = await this.netControls.startTrace(this.ctx, {
              screenshots: a.screenshots !== false,
              snapshots: a.snapshots !== false,
              sources: Boolean(a.sources),
            });
            this.addLog('devtools', 'Playwright trace recording started');
            return { ok: true, data: started };
          }
          if (sub === 'stop') {
            const stopped = await this.netControls.stopTrace(this.ctx, this.id);
            this.addLog('devtools', `Playwright trace saved → ${stopped.path} (${stopped.bytes} bytes)`);
            return { ok: true, data: stopped };
          }
          return { error: `unknown trace operation: ${sub}` };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
        }
      }

      case 'upload': {
        const box = this._findBox(a.ref);
        if (!box) return { blocked: true, reason: `unknown ref ${a.ref} — take a snapshot first` };
        let resolved;
        try {
          resolved = await this._resolveUploadPaths(a.paths);
        } catch (e) {
          return { blocked: true, reason: e.message };
        }
        const names = resolved.map((p) => path.basename(p)).join(', ');
        if (this.policy.approvalsEnabled) {
          const decision = await this.requestApproval({
            reason: `file upload — ${names}`,
            detail: `upload [${names}] to ${box.ref} "${box.name}"`,
            rule: 'upload',
          });
          if (!decision.allow) return { blocked: true, reason: decision.reason };
        }
        this.addLog('act', `upload ${box.ref} ← [${names}]`);
        try {
          const loc = this._locatorFor(page, box);
          await loc.setInputFiles(resolved, { timeout: 6000 });
          await sleep(180);
          const snap = await this.snap();
          return { ok: true, snapshot: toWireSnapshot(snap, wireOpts) };
        } catch (e) {
          return { error: String(e.message || e).split('\n')[0].slice(0, 160) };
        }
      }

      case 'back':
      case 'forward': {
        this.addLog('act', a.op);
        this._clearFormTaint();
        await (a.op === 'back' ? page.goBack({ timeout: 15000 }) : page.goForward({ timeout: 15000 })).catch(() => {});
        await sleep(220);
        const snap = await this.snap();
        return { ok: true, snapshot: toWireSnapshot(snap, wireOpts) };
      }

      case 'reload': {
        this.addLog('act', 'reload');
        this._clearFormTaint();
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await sleep(200);
        const snap = await this.snap();
        return { ok: true, snapshot: toWireSnapshot(snap, wireOpts) };
      }

      default:
        throw new Error(`unknown action: ${a.op}`);
    }
  }

  // ---------- reader-mode prose extraction ----------
  async pageText({ maxChars = 20000 } = {}) {
    const page = this.active();
    if (!page) return { title: '', url: '', text: '', length: 0, truncated: false };
    const cap = Math.min(100000, Math.max(500, Math.trunc(Number(maxChars) || 20000)));
    return page.evaluate((limit) => {
      if (!document.body) {
        return { title: document.title || '', url: location.href, text: '', length: 0, truncated: false };
      }
      // Boundary-safe chrome selectors (avoids naive `[class*=nav]` hitting words like "coronavirus" or "unavailable").
      const JUNK = [
        'nav', 'header', 'footer', 'aside',
        '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]',
        '#catlinks', '.navbox', '.printfooter', '.mw-editsection', '.vector-toc', '.sidebar', '#toc',
        '.cookie', '.cookie-banner', '#cookie-banner', '[class*="cookie-"]', '[id*="cookie-"]',
        '.advertisement', '.ad-banner', '[class^="ad-"]', '[class*=" ad-"]',
        '.newsletter', '.related-posts', '.site-header', '.site-footer',
        '.menu', '.nav', '.navbar', '.navigation', '.site-nav', '.main-nav', '.subnav',
        '[class^="nav-"]', '[class*=" nav-"]', '[class$="-nav"]',
        '.breadcrumb', '.breadcrumbs', '[aria-label*="navigation" i]',
        '#centralNotice', '.centralNotice', '.frb', '#frb-inline', '.fundraiser-box',
        '.mwe-popups', '.vector-sticky-header', '[aria-hidden="true"]',
        'script', 'style', 'noscript', 'svg', 'iframe', 'template', 'link', 'meta',
      ].join(', ');

      const src = document.querySelector('#bodyContent, main, article, [role="main"]') || document.body;
      const clone = src.cloneNode(true);
      try { clone.querySelectorAll(JUNK).forEach((e) => e.remove()); } catch {}
      clone.style.cssText = 'position:fixed;left:-99999px;top:0;width:900px;pointer-events:none';
      document.body.appendChild(clone);
      let raw = '';
      try { raw = clone.innerText || clone.textContent || ''; }
      finally { clone.remove(); }

      const cleaned = raw.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
      const truncated = cleaned.length > limit;
      return {
        title: document.title || '',
        url: location.href,
        text: truncated ? cleaned.slice(0, limit) : cleaned,
        length: cleaned.length,
        truncated,
      };
    }, cap);
  }

  // ---------- multi-engine SERP extractor (SearXNG, DuckDuckGo, Bing, Brave, Google) ----------
  async results() {
    const page = this.active();
    if (!page) return [];
    return page.evaluate(() => {
      const clean = (s) => String(s || '')
        .replace(/Translate this result/gi, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const unwrapUrl = (href) => {
        try {
          const u = new URL(href, location.href);
          // DuckDuckGo redirect wrapper: /l/?uddg=<encoded>
          const uddg = u.searchParams.get('uddg');
          if (uddg && /^https?:\/\//i.test(uddg)) return uddg;
          // Bing redirect wrapper: ?u=a1<base64url>
          const raw = u.searchParams.get('u');
          if (raw && raw.startsWith('a1') && /bing\.com$/i.test(u.hostname)) {
            let b = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
            while (b.length % 4) b += '=';
            const decoded = atob(b);
            if (/^https?:\/\//i.test(decoded)) return decoded;
          }
          return u.href;
        } catch {
          return href;
        }
      };

      const isSelfSearchUrl = (href) => {
        try {
          const h = new URL(href).hostname.toLowerCase();
          return /(^|\.)(bing\.com|duckduckgo\.com|search\.brave\.com|google\.[a-z.]+)$/.test(h);
        } catch {
          return true;
        }
      };

      const out = [];
      const seenUrls = new Set();
      const add = (title, rawHref, snippet) => {
        if (out.length >= 8) return;
        const url = unwrapUrl(rawHref);
        if (!url || !/^https?:\/\//i.test(url) || isSelfSearchUrl(url) || seenUrls.has(url)) return;
        const t = clean(title).slice(0, 150);
        if (!t) return;
        seenUrls.add(url);
        out.push({ title: t, url, snippet: clean(snippet).slice(0, 360) });
      };

      // 1) SearXNG
      for (const art of document.querySelectorAll('article.result')) {
        const a = art.querySelector('h3 a, h4 a, a.url_header, a[href^="http"]');
        const sn = art.querySelector('p.content, .content, p');
        if (a) add(a.innerText || a.textContent, a.href, sn ? (sn.innerText || sn.textContent) : '');
      }

      // 2) DuckDuckGo (HTML & JS editions)
      if (!out.length) {
        for (const res of document.querySelectorAll('.result, .results_links, article[data-testid="result"]')) {
          const a = res.querySelector('a.result__a, a[data-testid="result-title-a"], h2 a');
          const sn = res.querySelector('.result__snippet, [data-result="snippet"], .OgdwYG6KE2qthn9XQWFC, p');
          if (a) add(a.innerText || a.textContent, a.href, sn ? (sn.innerText || sn.textContent) : '');
        }
      }

      // 3) Bing
      if (!out.length) {
        for (const li of document.querySelectorAll('li.b_algo, div.b_algo, #b_results > li')) {
          const a = li.querySelector('h2 a, a[href^="http"]');
          const sn = li.querySelector('.b_caption p, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4, .b_algoSlug, p');
          if (a) add(a.innerText || a.textContent, a.href, sn ? (sn.innerText || sn.textContent) : li.innerText);
        }
      }

      // 4) Brave Search
      if (!out.length) {
        for (const snp of document.querySelectorAll('#results .snippet, div[data-type="web"]')) {
          const a = snp.querySelector('a[href^="http"]');
          const titleEl = snp.querySelector('.title, .snippet-title, h2, h3') || a;
          const descEl = snp.querySelector('.snippet-description, .snippet-content, p');
          if (a && titleEl) add(titleEl.innerText || titleEl.textContent, a.href, descEl ? (descEl.innerText || descEl.textContent) : '');
        }
      }

      // 5) Google
      if (!out.length) {
        for (const g of document.querySelectorAll('div.g, div.MjjYud')) {
          const a = g.querySelector('a[href^="http"]');
          const h = g.querySelector('h3, h2');
          if (a && h) add(h.innerText || h.textContent, a.href, g.innerText || g.textContent);
        }
      }

      // 6) Generic fallback
      if (!out.length) {
        for (const a of document.querySelectorAll('a[href^="http"]')) {
          const t = clean(a.innerText || a.textContent);
          if (t.length < 25) continue;
          if (/^(home|about|login|sign in|privacy|terms|help|settings|feedback)/i.test(t)) continue;
          add(t.slice(0, 110), a.href, '');
        }
      }

      return out;
    }).catch(() => []);
  }

  // ---------- reset & shutdown ----------
  async reset() {
    this._generation++;
    this.paused = false;
    try { this.taskAbort?.abort(new Error('session reset')); } catch {}
    this._cancelAllPending('session reset');

    return this.enqueue(async () => {
      await this._teardown();
      this.nextRef = 0;
      this.sessionActions = 0;
      this.lastMutatingActionSeq = 0;
      this.netControls = new ContextNetworkControls({ traceDir: this.traceDir });
      this.stats = { actions: 0, snapshots: 0, tokens: 0, htmlBytes: 0, approvals: 0, taskRuns: 0 };
      this.downloads = [];
      this.agentStatus = 'idle';
      this._clearFormTaint();
      this.addLog('sys', 'session reset · context recreated');
      await this.init();
      await this.snap();
      this.emit('state', { state: this.state() });
      return true;
    });
  }

  async _teardown() {
    const ctx = this.ctx;
    const browser = this.browser;
    const oldTabs = this.tabs;
    this.ctx = null;
    this.tabs = [];
    this.activeId = null;
    this.snapshot = null;
    this.prevSnapshot = null;
    this.markedSnapshot = null;
    this.shotBuf = null;
    this.shotAt = 0;
    for (const t of oldTabs) {
      try { await t.devtools?.detach?.(); } catch {}
    }
    this.netControls.traceActive = false;
    try { await ctx?.close(); } catch {}
    if (this._ownsBrowser && browser) {
      this.browser = null;
      try { await browser.close(); } catch {}
    } else if (!this._ownsBrowser) {
      this.browser = null;
    }
  }

  async shutdown() {
    this._closed = true;
    this._generation++;
    this.paused = false;
    try { this.taskAbort?.abort(new Error('session shutdown')); } catch {}
    this._cancelAllPending('session shutdown');
    await this._teardown();
  }
}
