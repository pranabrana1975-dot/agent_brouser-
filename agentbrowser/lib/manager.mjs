// manager.mjs — Multi-session manager: shares a single Chromium process across
// isolated BrowserContext-backed Sessions, with concurrency caps, idle-TTL
// eviction, and automatic crash recovery.

import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { Session, defaultLaunchOptions } from './session.mjs';

export const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const DEFAULT_MAX_SESSIONS = Number(process.env.AGENT_BROWSER_MAX_SESSIONS ?? 8);
export const DEFAULT_SESSION_TTL_MS = Number(process.env.AGENT_BROWSER_SESSION_TTL_MS ?? 30 * 60 * 1000);

export function validateSessionId(id) {
  const s = String(id ?? '').trim();
  if (!SESSION_ID_RE.test(s)) {
    const err = new Error('invalid session id (use 1-64 alphanumeric, ".", "_", or "-" characters)');
    err.status = 400;
    throw err;
  }
  return s;
}

export class SessionManager {
  constructor(opts = {}) {
    this._browserLauncher = opts.browserLauncher || ((launchOpts) => chromium.launch(launchOpts));
    this._launchOpts = defaultLaunchOptions(opts);
    this._sessionDefaults = opts.sessionDefaults || {};
    this.maxSessions = Number.isFinite(opts.maxSessions) && opts.maxSessions > 0
      ? Math.trunc(opts.maxSessions)
      : DEFAULT_MAX_SESSIONS;
    this.idleTtlMs = Number.isFinite(opts.idleTtlMs) && opts.idleTtlMs >= 0
      ? opts.idleTtlMs
      : DEFAULT_SESSION_TTL_MS;

    this.browser = null;
    this._browserPromise = null;
    this.sessions = new Map();
    this._closed = false;

    const sweepMs = Number.isFinite(opts.sweepIntervalMs)
      ? opts.sweepIntervalMs
      : (this.idleTtlMs > 0 ? Math.min(60_000, Math.max(5_000, Math.floor(this.idleTtlMs / 4))) : 0);
    this._sweepTimer = null;
    if (sweepMs > 0 && this.idleTtlMs > 0) {
      this._sweepTimer = setInterval(() => { void this.reapIdle(); }, sweepMs);
      this._sweepTimer.unref?.();
    }
  }

  isBrowserReady() {
    if (!this.browser) return false;
    return typeof this.browser.isConnected === 'function' ? this.browser.isConnected() : true;
  }

  engineLabel() {
    if (!this.isBrowserReady()) return 'not launched';
    const v = typeof this.browser.version === 'function' ? this.browser.version() : 'unknown';
    return `Chromium ${v}`;
  }

  async ensureBrowser() {
    if (this._closed) throw new Error('session manager is shut down');
    if (this.isBrowserReady()) return this.browser;
    if (this._browserPromise) return this._browserPromise;

    this._browserPromise = (async () => {
      const { headless, args } = this._launchOpts;
      const b = await this._browserLauncher({ headless, args });
      b.on?.('disconnected', () => {
        if (this.browser === b) this.browser = null;
        for (const s of this.sessions.values()) {
          s.browser = null;
          s.ctx = null;
          s.tabs = [];
          s.activeId = null;
          s.addLog('err', 'shared Chromium disconnected — will recover on next action');
          s.emit('state', { state: s.state() });
        }
      });
      this.browser = b;
      return b;
    })().finally(() => {
      this._browserPromise = null;
    });

    return this._browserPromise;
  }

  _buildSession(id, overrides = {}) {
    const mergedPolicy = overrides.policy ?? this._sessionDefaults.policy;
    return new Session({
      ...this._sessionDefaults,
      ...overrides,
      id,
      policy: mergedPolicy,
      getBrowser: () => this.ensureBrowser(),
    });
  }

  get(id = 'default', { create = false } = {}) {
    const sid = validateSessionId(id);
    const existing = this.sessions.get(sid);
    if (existing) {
      existing.touch();
      return existing;
    }
    if (!create) return null;
    return this.create({ id: sid });
  }

  getOrCreate(id = 'default') {
    return this.get(id, { create: true });
  }

  create(opts = {}) {
    if (this._closed) throw new Error('session manager is shut down');
    const id = opts.id !== undefined && opts.id !== null && String(opts.id).trim() !== ''
      ? validateSessionId(opts.id)
      : 's-' + crypto.randomUUID().slice(0, 12);

    if (this.sessions.has(id)) {
      const err = new Error(`session "${id}" already exists`);
      err.status = 409;
      throw err;
    }

    if (this.sessions.size >= this.maxSessions) {
      const err = new Error(`maximum concurrent sessions (${this.maxSessions}) reached`);
      err.status = 429;
      throw err;
    }

    const session = this._buildSession(id, {
      policy: opts.policy,
      viewport: opts.viewport,
      locale: opts.locale,
      timezoneId: opts.timezoneId,
      colorScheme: opts.colorScheme,
      userAgent: opts.userAgent,
    });
    this.sessions.set(id, session);
    return session;
  }

  list() {
    return [...this.sessions.values()].map((s) => s.summary());
  }

  async close(id) {
    const sid = validateSessionId(id);
    const s = this.sessions.get(sid);
    if (!s) return false;
    this.sessions.delete(sid);
    await s.shutdown();
    return true;
  }

  async reapIdle(now = Date.now()) {
    if (this.idleTtlMs <= 0) return [];
    const reaped = [];
    for (const [id, s] of this.sessions) {
      if (id === 'default') continue;
      if (s.busy || s.pending.size > 0 || s.listeners.size > 0) continue;
      if (now - s.lastActiveAt >= this.idleTtlMs) {
        this.sessions.delete(id);
        reaped.push(id);
        await s.shutdown().catch(() => {});
      }
    }
    return reaped;
  }

  async shutdown() {
    this._closed = true;
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    const closing = [...this.sessions.values()].map((s) => s.shutdown().catch(() => {}));
    this.sessions.clear();
    await Promise.all(closing);
    const b = this.browser;
    this.browser = null;
    try { await b?.close(); } catch {}
  }
}
