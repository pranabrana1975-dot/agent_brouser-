// devtools.mjs — Per-tab "F12 DevTools" telemetry & controllers for agents:
//   - Network recorder (r1..rN), API body capture, WebSocket frames (ws1..wsN),
//     HAR 1.2 export, network throttling, tracker/pattern blocking, & API mocking
//   - Console & uncaught exception (pageerror) recorder (c1..cN)
//   - Dialog history & programmable accept/dismiss/prompt controller (d1..dN)
//   - Compact 1-line `[devtools]` status badge for Agent Document snapshots
//   - Automatic redaction of Authorization, Cookie, Set-Cookie, and secret fields

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_NETWORK_ENTRIES = 300;
const MAX_BODY_CACHE_ENTRIES = 80;
const MAX_BODY_CHARS = 65_536;
const MAX_POST_DATA_CHARS = 8_192;
const MAX_WS_CONNECTIONS = 40;
const MAX_WS_FRAMES = 200;
const MAX_CONSOLE_ENTRIES = 300;
const MAX_DIALOG_ENTRIES = 60;
const MAX_MOCKS = 25;
const MAX_BLOCKED_PATTERNS = 100;

const SENSITIVE_HEADER_RE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|x-session-id|x-amz-security-token)$/i;
const SENSITIVE_KEY_RE = /(passw(or)?d|secret|token|api[-_]?key|auth|credential|private[-_]?key|client[-_]?secret|session[-_]?id|jwt|bearer)/i;
const TEXTUAL_MIME_RE = /(json|text\/|xml|javascript|ecmascript|graphql|x-www-form-urlencoded|svg\+xml|problem\+|ld\+)/i;

export const TRACKER_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'connect.facebook.net',
  'analytics.tiktok.com',
  'bat.bing.com',
  'clarity.ms',
  'hotjar.com',
  'mixpanel.com',
  'segment.io',
  'amplitude.com',
  'fullstory.com',
  'adservice.google.com',
];

export const NETWORK_PRESETS = {
  online: { offline: false, latencyMs: 0, downloadKbps: -1, uploadKbps: -1 },
  offline: { offline: true, latencyMs: 0, downloadKbps: 0, uploadKbps: 0 },
  'slow-3g': { offline: false, latencyMs: 400, downloadKbps: 400, uploadKbps: 400 },
  'fast-3g': { offline: false, latencyMs: 150, downloadKbps: 1500, uploadKbps: 750 },
  '4g': { offline: false, latencyMs: 50, downloadKbps: 9000, uploadKbps: 4500 },
};

export function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).toLowerCase();
    out[key] = SENSITIVE_HEADER_RE.test(key) ? '[REDACTED]' : String(v ?? '').slice(0, 1024);
  }
  return out;
}

export function redactUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const u = new URL(rawUrl);
    if (u.username) u.username = 'REDACTED';
    if (u.password) u.password = 'REDACTED';
    let changed = false;
    const next = new URLSearchParams();
    for (const [k, v] of u.searchParams.entries()) {
      if (SENSITIVE_KEY_RE.test(k)) {
        next.append(k, '[REDACTED]');
        changed = true;
      } else {
        next.append(k, v);
      }
    }
    if (changed) {
      // Preserve readable [REDACTED] instead of %5BREDACTED%5D in query strings
      u.search = next.toString().replace(/%5BREDACTED%5D/g, '[REDACTED]');
    }
    return u.toString().slice(0, 2048);
  } catch {
    return rawUrl.slice(0, 2048);
  }
}

export function redactQueryParams(url) {
  const out = {};
  try {
    const u = new URL(url);
    for (const [k, v] of u.searchParams.entries()) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '[REDACTED]' : v.slice(0, 512);
    }
  } catch {}
  return out;
}

function redactObjectDeep(val, depth = 0) {
  if (depth > 5 || val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.slice(0, 100).map((item) => redactObjectDeep(item, depth + 1));
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '[REDACTED]' : redactObjectDeep(v, depth + 1);
    }
    return out;
  }
  return val;
}

export function redactPostData(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const sliced = raw.slice(0, MAX_POST_DATA_CHARS);
  const trimmed = sliced.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.stringify(redactObjectDeep(JSON.parse(trimmed)));
    } catch {}
  }
  if (trimmed.includes('=') && !trimmed.includes('\n') && !trimmed.startsWith('<')) {
    try {
      const params = new URLSearchParams(trimmed);
      let changed = false;
      for (const k of [...params.keys()]) {
        if (SENSITIVE_KEY_RE.test(k)) {
          params.set(k, '[REDACTED]');
          changed = true;
        }
      }
      if (changed) return params.toString();
    } catch {}
  }
  return sliced;
}

function registrableTail(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  // Common 2-part ccTLDs (co.uk, co.in, com.au, org.uk, ac.in)
  const last2 = parts.slice(-2).join('.');
  if (/^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(last2) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return last2;
}

export function isThirdPartyHost(reqHost, pageHost) {
  if (!reqHost || !pageHost) return false;
  const a = reqHost.toLowerCase().replace(/\.$/, '');
  const b = pageHost.toLowerCase().replace(/\.$/, '');
  if (a === b) return false;
  return registrableTail(a) !== registrableTail(b);
}

export function wildcardToRegex(pattern) {
  const escaped = String(pattern || '').trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$', 'i');
}

export function matchesUrlRule(url, pattern) {
  const pat = String(pattern || '').trim();
  if (!pat) return false;
  // Host-only rules (no '/' or ':'): match exact domain, subdomain, or domain wildcard like "*.ads.example.com".
  if (!pat.includes('/') && !pat.includes(':')) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (pat.includes('*')) {
        if (pat.startsWith('*.') && !pat.slice(2).includes('*')) {
          const base = pat.slice(2).toLowerCase();
          return host === base || host.endsWith('.' + base);
        }
        return wildcardToRegex(pat).test(host);
      }
      const d = pat.toLowerCase().replace(/^\./, '');
      return host === d || host.endsWith('.' + d);
    } catch {
      return false;
    }
  }
  if (pat.includes('*')) return wildcardToRegex(pat).test(url);
  return url.toLowerCase().includes(pat.toLowerCase());
}

export class TabDevTools {
  constructor(page, { getActionSeq = () => 0, onDialogEvent = null } = {}) {
    this.page = page;
    this._getActionSeq = getActionSeq;
    this._onDialogEvent = onDialogEvent;

    this.requests = [];
    this._reqByObj = new WeakMap();
    this._reqById = new Map();
    this._bodyQueue = [];
    this._nextReq = 1;

    this.websockets = [];
    this.wsFrames = [];
    this._nextWs = 1;

    this.console = [];
    this._nextConsole = 1;

    this.dialogs = [];
    this._nextDialog = 1;
    this.dialogRule = { mode: 'dismiss', promptText: '', once: false };
    this.pendingDialog = null;

    this.mainDocument = null; // latest top-level document response metadata (headers + TLS)
    this.pageOriginHost = '';
    this.cdpSession = null;

    this._attach(page);
  }

  _attach(page) {
    if (!page?.on) return;

    page.on('request', (req) => {
      try { this._onRequest(req); } catch {}
    });

    page.on('response', (res) => {
      try { void this._onResponse(res); } catch {}
    });

    page.on('requestfailed', (req) => {
      try { this._onRequestFailed(req); } catch {}
    });

    page.on('requestfinished', (req) => {
      try { this._onRequestFinished(req); } catch {}
    });

    page.on('console', (msg) => {
      try { this._onConsole(msg); } catch {}
    });

    page.on('pageerror', (err) => {
      try { this._onPageError(err); } catch {}
    });

    page.on('websocket', (ws) => {
      try { this._onWebSocket(ws); } catch {}
    });

    page.on('dialog', (dialog) => {
      void this._onDialog(dialog);
    });
  }

  _onRequest(req) {
    const url = typeof req.url === 'function' ? req.url() : '';
    if (!url || url.startsWith('data:')) return;
    const id = 'r' + this._nextReq++;
    const resourceType = (typeof req.resourceType === 'function' ? req.resourceType() : 'other') || 'other';
    const method = (typeof req.method === 'function' ? req.method() : 'GET').toUpperCase();
    const isMainDoc = resourceType === 'document' && (
      typeof req.isNavigationRequest === 'function' ? req.isNavigationRequest() : true
    ) && (typeof req.frame === 'function' && typeof this.page.mainFrame === 'function'
      ? req.frame() === this.page.mainFrame()
      : true);

    let host = '';
    let pathname = '';
    let protocol = '';
    try {
      const parsed = new URL(url);
      host = parsed.hostname.toLowerCase();
      pathname = parsed.pathname;
      protocol = parsed.protocol;
    } catch {}

    if (isMainDoc && host) {
      this.pageOriginHost = host;
    }
    const baseHost = this.pageOriginHost || (() => {
      try { return new URL(this.page.url?.() || '').hostname.toLowerCase(); } catch { return ''; }
    })();

    const rawHeaders = typeof req.headers === 'function' ? req.headers() : {};
    const rawPost = typeof req.postData === 'function' ? req.postData() : null;

    const entry = {
      id,
      method,
      url: redactUrl(url),
      protocol,
      host,
      path: pathname.slice(0, 512),
      query: redactQueryParams(url),
      resourceType,
      isMainDoc,
      isThirdParty: isThirdPartyHost(host, baseHost),
      status: null,
      statusText: '',
      ok: null,
      failed: false,
      failureText: '',
      mimeType: '',
      size: 0,
      startedAt: Date.now(),
      durationMs: null,
      actionSeq: this._getActionSeq(),
      requestHeaders: redactHeaders(rawHeaders),
      responseHeaders: {},
      rawSecurityHeaders: {},
      postData: redactPostData(rawPost),
      body: null,
      bodyTruncated: false,
      securityDetails: null,
    };

    this._reqByObj.set(req, entry);
    this._reqById.set(id, entry);
    this.requests.push(entry);
    if (this.requests.length > MAX_NETWORK_ENTRIES) {
      const evicted = this.requests.shift();
      if (evicted) this._reqById.delete(evicted.id);
    }
  }

  async _onResponse(res) {
    const req = typeof res.request === 'function' ? res.request() : null;
    let entry = req ? this._reqByObj.get(req) : null;
    if (!entry) {
      if (req) this._onRequest(req);
      entry = req ? this._reqByObj.get(req) : null;
      if (!entry) return;
    }

    const status = typeof res.status === 'function' ? res.status() : 0;
    const statusText = typeof res.statusText === 'function' ? res.statusText() : '';
    const rawHeaders = typeof res.headers === 'function' ? res.headers() : {};
    const redacted = redactHeaders(rawHeaders);
    const ct = String(redacted['content-type'] || '').toLowerCase();
    const mimeType = ct.split(';')[0].trim();
    const cl = Number(redacted['content-length'] || 0);

    entry.status = status;
    entry.statusText = statusText;
    entry.ok = status >= 200 && status < 400;
    entry.failed = status >= 400;
    entry.mimeType = mimeType;
    entry.responseHeaders = redacted;
    if (Number.isFinite(cl) && cl > 0) entry.size = cl;
    entry.durationMs = Math.max(0, Date.now() - entry.startedAt);

    // Capture TLS/SSL certificate details when available.
    if (typeof res.securityDetails === 'function') {
      try {
        const sec = await res.securityDetails();
        if (sec) {
          entry.securityDetails = {
            protocol: sec.protocol || '',
            issuer: sec.issuer || '',
            subjectName: sec.subjectName || '',
            validFrom: sec.validFrom ? new Date(sec.validFrom * 1000).toISOString() : null,
            validTo: sec.validTo ? new Date(sec.validTo * 1000).toISOString() : null,
          };
        }
      } catch {}
    }

    if (entry.isMainDoc) {
      this.mainDocument = {
        id: entry.id,
        url: entry.url,
        protocol: entry.protocol,
        host: entry.host,
        status: entry.status,
        headers: redacted,
        securityDetails: entry.securityDetails,
        at: Date.now(),
      };
    }

    // Bounded text/JSON body capture for fetch, xhr, and document responses.
    const wantBody = ['fetch', 'xhr', 'document', 'other'].includes(entry.resourceType)
      && status !== 204 && status !== 304
      && (!mimeType || TEXTUAL_MIME_RE.test(mimeType))
      && (!cl || cl <= MAX_BODY_CHARS * 4);

    if (wantBody && typeof res.text === 'function') {
      try {
        const txt = await res.text();
        if (typeof txt === 'string') {
          if (!entry.size) entry.size = Buffer.byteLength(txt, 'utf8');
          entry.bodyTruncated = txt.length > MAX_BODY_CHARS;
          entry.body = entry.bodyTruncated ? txt.slice(0, MAX_BODY_CHARS) : txt;
          this._bodyQueue.push(entry);
          while (this._bodyQueue.length > MAX_BODY_CACHE_ENTRIES) {
            const old = this._bodyQueue.shift();
            if (old && old !== entry) {
              old.body = null;
              old.bodyTruncated = false;
            }
          }
        }
      } catch {}
    }
  }

  _onRequestFinished(req) {
    const entry = this._reqByObj.get(req);
    if (!entry) return;
    if (entry.durationMs === null) {
      entry.durationMs = Math.max(0, Date.now() - entry.startedAt);
    }
  }

  _onRequestFailed(req) {
    let entry = this._reqByObj.get(req);
    if (!entry) {
      this._onRequest(req);
      entry = this._reqByObj.get(req);
      if (!entry) return;
    }
    const failure = typeof req.failure === 'function' ? req.failure() : null;
    const reason = String(failure?.errorText || 'request failed');
    entry.failed = true;
    entry.ok = false;
    entry.failureText = reason.slice(0, 200);
    entry.durationMs = Math.max(0, Date.now() - entry.startedAt);
  }

  _onWebSocket(ws) {
    const id = 'ws' + this._nextWs++;
    const url = redactUrl(String(typeof ws.url === 'function' ? ws.url() : '')).slice(0, 1024);
    const conn = {
      id,
      url,
      openedAt: Date.now(),
      closedAt: null,
      sentFrames: 0,
      receivedFrames: 0,
      error: null,
    };
    this.websockets.push(conn);
    if (this.websockets.length > MAX_WS_CONNECTIONS) this.websockets.shift();

    const recordFrame = (direction, frame) => {
      const payload = frame?.payload ?? frame;
      let text = '';
      let bytes = 0;
      let binary = false;
      if (Buffer.isBuffer(payload)) {
        binary = true;
        bytes = payload.length;
        text = `[binary ${bytes} bytes]`;
      } else {
        const s = String(payload ?? '');
        bytes = Buffer.byteLength(s, 'utf8');
        text = s.length > 1024 ? s.slice(0, 1024) + '…' : s;
      }
      if (direction === 'sent') conn.sentFrames++;
      else conn.receivedFrames++;
      this.wsFrames.push({
        wsId: id,
        url,
        direction,
        text,
        bytes,
        binary,
        at: Date.now(),
        actionSeq: this._getActionSeq(),
      });
      if (this.wsFrames.length > MAX_WS_FRAMES) this.wsFrames.shift();
    };

    ws.on?.('framesent', (f) => { try { recordFrame('sent', f); } catch {} });
    ws.on?.('framereceived', (f) => { try { recordFrame('received', f); } catch {} });
    ws.on?.('socketerror', (err) => { conn.error = String(err || '').slice(0, 200); });
    ws.on?.('close', () => { conn.closedAt = Date.now(); });
  }

  _onConsole(msg) {
    const rawType = String(typeof msg.type === 'function' ? msg.type() : 'log').toLowerCase();
    const level = rawType === 'warn' ? 'warning' : rawType;
    const text = String(typeof msg.text === 'function' ? msg.text() : '').slice(0, 1200);
    const loc = typeof msg.location === 'function' ? msg.location() : null;
    const entry = {
      id: 'c' + this._nextConsole++,
      level,
      text,
      url: loc?.url ? String(loc.url).slice(0, 512) : '',
      line: Number.isInteger(loc?.lineNumber) ? loc.lineNumber : null,
      column: Number.isInteger(loc?.columnNumber) ? loc.columnNumber : null,
      at: Date.now(),
      actionSeq: this._getActionSeq(),
    };
    this.console.push(entry);
    if (this.console.length > MAX_CONSOLE_ENTRIES) this.console.shift();
  }

  _onPageError(err) {
    const message = String(err?.message || err || 'Uncaught error').slice(0, 800);
    const stack = typeof err?.stack === 'string' ? err.stack.slice(0, 1800) : '';
    const entry = {
      id: 'c' + this._nextConsole++,
      level: 'pageerror',
      text: message,
      stack,
      url: '',
      line: null,
      column: null,
      at: Date.now(),
      actionSeq: this._getActionSeq(),
    };
    this.console.push(entry);
    if (this.console.length > MAX_CONSOLE_ENTRIES) this.console.shift();
  }

  async _onDialog(dialog) {
    const id = 'd' + this._nextDialog++;
    const type = typeof dialog.type === 'function' ? dialog.type() : 'alert';
    const message = String(typeof dialog.message === 'function' ? dialog.message() : '').slice(0, 500);
    const defaultValue = String(typeof dialog.defaultValue === 'function' ? dialog.defaultValue() : '').slice(0, 200);
    const record = {
      id,
      type,
      message,
      defaultValue,
      action: 'pending',
      promptText: null,
      at: Date.now(),
      actionSeq: this._getActionSeq(),
    };
    this.dialogs.push(record);
    if (this.dialogs.length > MAX_DIALOG_ENTRIES) this.dialogs.shift();

    const rule = { ...this.dialogRule };
    if (rule.once) {
      this.dialogRule = { mode: 'dismiss', promptText: '', once: false };
    }

    if (rule.mode === 'manual') {
      // Hold briefly so an explicit `browser_dialog({ op: 'accept' | 'dismiss' })` can answer it,
      // with a safety timer so headless browsing never hangs permanently.
      await new Promise((resolve) => {
        const timer = setTimeout(async () => {
          if (this.pendingDialog?.id !== id) return;
          this.pendingDialog = null;
          record.action = 'auto-dismissed';
          try { await dialog.dismiss(); } catch {}
          resolve();
        }, 15_000);
        timer.unref?.();
        this.pendingDialog = {
          id,
          record,
          decide: async (accept, promptText) => {
            clearTimeout(timer);
            this.pendingDialog = null;
            record.action = accept ? 'accepted' : 'dismissed';
            if (accept && type === 'prompt' && promptText !== undefined) {
              record.promptText = String(promptText);
              await dialog.accept(String(promptText));
            } else if (accept) {
              await dialog.accept();
            } else {
              await dialog.dismiss();
            }
            resolve();
          },
        };
        this._onDialogEvent?.(record);
      });
      return;
    }

    if (rule.mode === 'accept') {
      record.action = 'accepted';
      try {
        if (type === 'prompt' && rule.promptText !== undefined && rule.promptText !== '') {
          record.promptText = String(rule.promptText);
          await dialog.accept(String(rule.promptText));
        } else {
          await dialog.accept();
        }
      } catch {}
    } else {
      record.action = 'dismissed';
      try { await dialog.dismiss(); } catch {}
    }
    this._onDialogEvent?.(record);
  }

  // ---------- query methods ----------
  listNetwork({ resourceType, status, url, sinceActionSeq = null, limit = 50 } = {}) {
    const cap = Math.min(200, Math.max(1, Math.trunc(Number(limit) || 50)));
    const typeFilter = resourceType ? String(resourceType).toLowerCase() : '';
    const urlFilter = url ? String(url).toLowerCase() : '';

    let items = this.requests;
    if (sinceActionSeq !== null) {
      items = items.filter((r) => r.actionSeq >= sinceActionSeq);
    }
    if (typeFilter && typeFilter !== 'all') {
      if (typeFilter === 'api') {
        items = items.filter((r) => r.resourceType === 'fetch' || r.resourceType === 'xhr');
      } else {
        items = items.filter((r) => r.resourceType === typeFilter);
      }
    }
    if (status !== undefined && status !== null && status !== '' && status !== 'all') {
      const s = String(status).toLowerCase();
      if (s === 'failed' || s === 'error') items = items.filter((r) => r.failed);
      else if (s === '2xx') items = items.filter((r) => r.status >= 200 && r.status < 300);
      else if (s === '3xx') items = items.filter((r) => r.status >= 300 && r.status < 400);
      else if (s === '4xx') items = items.filter((r) => r.status >= 400 && r.status < 500);
      else if (s === '5xx') items = items.filter((r) => r.status >= 500 && r.status < 600);
      else if (/^\d{3}$/.test(s)) items = items.filter((r) => r.status === Number(s));
    }
    if (urlFilter) {
      items = items.filter((r) => r.url.toLowerCase().includes(urlFilter));
    }

    const total = items.length;
    const sliced = items.slice(-cap).map((r) => ({
      id: r.id,
      method: r.method,
      url: r.url,
      status: r.status,
      resourceType: r.resourceType,
      mimeType: r.mimeType,
      durationMs: r.durationMs,
      size: r.size,
      failed: r.failed,
      ...(r.failureText ? { failureText: r.failureText } : {}),
      hasBody: r.body !== null,
      isThirdParty: r.isThirdParty,
    }));

    return {
      total,
      returned: sliced.length,
      failedCount: this.requests.filter((r) => r.failed).length,
      requests: sliced,
    };
  }

  getNetworkEntry(id, { maxChars = 16000 } = {}) {
    const entry = this._reqById.get(String(id || '').trim());
    if (!entry) return null;
    const cap = Math.min(MAX_BODY_CHARS, Math.max(100, Math.trunc(Number(maxChars) || 16000)));
    let body = null;
    let json = null;
    let bodyTruncated = entry.bodyTruncated;
    if (typeof entry.body === 'string') {
      if (entry.body.length > cap) {
        body = entry.body.slice(0, cap);
        bodyTruncated = true;
      } else {
        body = entry.body;
      }
      if (!entry.bodyTruncated && /json/i.test(entry.mimeType)) {
        try { json = JSON.parse(entry.body); } catch {}
      }
    }
    return {
      id: entry.id,
      method: entry.method,
      url: entry.url,
      query: entry.query,
      resourceType: entry.resourceType,
      status: entry.status,
      statusText: entry.statusText,
      ok: entry.ok,
      failed: entry.failed,
      failureText: entry.failureText || null,
      mimeType: entry.mimeType,
      size: entry.size,
      durationMs: entry.durationMs,
      startedAt: new Date(entry.startedAt).toISOString(),
      isThirdParty: entry.isThirdParty,
      requestHeaders: entry.requestHeaders,
      responseHeaders: entry.responseHeaders,
      postData: entry.postData,
      body,
      bodyTruncated,
      ...(json !== null ? { json } : {}),
      ...(entry.securityDetails ? { securityDetails: entry.securityDetails } : {}),
    };
  }

  listWebSockets({ wsId, limit = 50 } = {}) {
    const cap = Math.min(MAX_WS_FRAMES, Math.max(1, Math.trunc(Number(limit) || 50)));
    const frames = wsId
      ? this.wsFrames.filter((f) => f.wsId === wsId).slice(-cap)
      : this.wsFrames.slice(-cap);
    return {
      connections: [...this.websockets],
      frames,
    };
  }

  exportHar({ includeBodies = false } = {}) {
    const pageUrl = redactUrl(this.page?.url?.() || '');
    const entries = this.requests.map((r) => ({
      _id: r.id,
      _resourceType: r.resourceType,
      startedDateTime: new Date(r.startedAt).toISOString(),
      time: r.durationMs ?? 0,
      request: {
        method: r.method,
        url: r.url,
        headers: Object.entries(r.requestHeaders).map(([name, value]) => ({ name, value })),
        queryString: Object.entries(r.query).map(([name, value]) => ({ name, value })),
        ...(r.postData ? { postData: { mimeType: r.requestHeaders['content-type'] || '', text: r.postData } } : {}),
      },
      response: {
        status: r.status ?? 0,
        statusText: r.statusText || r.failureText || '',
        headers: Object.entries(r.responseHeaders).map(([name, value]) => ({ name, value })),
        content: {
          size: r.size || 0,
          mimeType: r.mimeType || '',
          ...(includeBodies && r.body !== null ? { text: r.body.slice(0, 8192) } : {}),
        },
      },
      timings: { wait: r.durationMs ?? 0, receive: 0 },
    }));

    return {
      log: {
        version: '1.2',
        creator: { name: 'agentbrowser', version: '1.2.0' },
        pages: [{ id: 'page_1', title: pageUrl, startedDateTime: new Date().toISOString() }],
        entries,
      },
    };
  }

  clearNetwork() {
    this.requests = [];
    this._reqById.clear();
    this._bodyQueue = [];
    this.websockets = [];
    this.wsFrames = [];
  }

  listConsole({ level = 'all', search = '', sinceActionSeq = null, limit = 60 } = {}) {
    const cap = Math.min(MAX_CONSOLE_ENTRIES, Math.max(1, Math.trunc(Number(limit) || 60)));
    const lvl = String(level || 'all').toLowerCase();
    const q = String(search || '').trim().toLowerCase();

    let items = this.console;
    if (sinceActionSeq !== null) {
      items = items.filter((c) => c.actionSeq >= sinceActionSeq);
    }
    if (lvl && lvl !== 'all') {
      if (lvl === 'error' || lvl === 'errors') {
        items = items.filter((c) => c.level === 'error' || c.level === 'pageerror' || c.level === 'assert');
      } else if (lvl === 'warn' || lvl === 'warning') {
        items = items.filter((c) => c.level === 'warning');
      } else {
        items = items.filter((c) => c.level === lvl);
      }
    }
    if (q) {
      items = items.filter((c) => c.text.toLowerCase().includes(q) || (c.stack || '').toLowerCase().includes(q));
    }

    const errors = this.console.filter((c) => c.level === 'error' || c.level === 'pageerror').length;
    const warnings = this.console.filter((c) => c.level === 'warning').length;

    return {
      total: items.length,
      errors,
      warnings,
      entries: items.slice(-cap),
    };
  }

  clearConsole() {
    this.console = [];
  }

  // Compact 1-line status badge injected into snapshots ONLY when anomalies exist (0 extra tokens when clean).
  badgeSummary({ toastCount = 0 } = {}) {
    const errorCount = this.console.filter((c) => c.level === 'error' || c.level === 'pageerror').length;
    const warnCount = this.console.filter((c) => c.level === 'warning').length;
    const failedReqs = this.requests.filter((r) => r.failed && !/ERR_ABORTED/i.test(r.failureText || ''));
    const parts = [];

    if (errorCount || warnCount) {
      const cBits = [];
      if (errorCount) cBits.push(`${errorCount} error${errorCount > 1 ? 's' : ''}`);
      if (warnCount) cBits.push(`${warnCount} warn${warnCount > 1 ? 's' : ''}`);
      parts.push(`console: ${cBits.join(', ')}`);
    }

    if (failedReqs.length) {
      const last = failedReqs[failedReqs.length - 1];
      const tag = last.status ? String(last.status) : 'ERR';
      const shortPath = (last.path || last.host || '').slice(0, 36);
      parts.push(`network: ${failedReqs.length} failed (${tag} ${shortPath})`.trim());
    }

    if (toastCount > 0) {
      parts.push(`toasts: ${toastCount}`);
    }

    if (this.pendingDialog) {
      parts.push(`dialog: pending ${this.pendingDialog.record.type}`);
    }

    return parts.length ? parts.join(' · ') : '';
  }

  thirdPartySummary() {
    const map = new Map();
    for (const r of this.requests) {
      if (!r.isThirdParty || !r.host) continue;
      let rec = map.get(r.host);
      if (!rec) {
        rec = { domain: r.host, requests: 0, failed: 0, bytes: 0, types: new Set() };
        map.set(r.host, rec);
      }
      rec.requests++;
      if (r.failed) rec.failed++;
      rec.bytes += r.size || 0;
      rec.types.add(r.resourceType);
    }
    return [...map.values()]
      .map((x) => ({ domain: x.domain, requests: x.requests, failed: x.failed, bytes: x.bytes, types: [...x.types] }))
      .sort((a, b) => b.requests - a.requests);
  }

  mixedContentRequests() {
    const pageUrl = this.page?.url?.() || '';
    if (!pageUrl.startsWith('https://')) return [];
    return this.requests
      .filter((r) => r.protocol === 'http:')
      .slice(0, 50)
      .map((r) => ({ id: r.id, url: r.url, resourceType: r.resourceType, blocked: r.failed }));
  }

  async ensureCdp(ctx) {
    if (this.cdpSession) return this.cdpSession;
    if (typeof ctx?.newCDPSession !== 'function') return null;
    try {
      this.cdpSession = await ctx.newCDPSession(this.page);
      return this.cdpSession;
    } catch {
      return null;
    }
  }

  async applyNetworkThrottle(ctx, profile) {
    const preset = typeof profile === 'string' ? NETWORK_PRESETS[profile] : profile;
    if (!preset) throw new Error(`unknown network preset: ${profile}`);
    const offline = Boolean(preset.offline);
    const latencyMs = Math.max(0, Number(preset.latencyMs ?? 0));
    const downloadKbps = Number(preset.downloadKbps ?? -1);
    const uploadKbps = Number(preset.uploadKbps ?? -1);

    if (typeof ctx?.setOffline === 'function') {
      await ctx.setOffline(offline);
    }
    const cdp = await this.ensureCdp(ctx);
    if (cdp) {
      try {
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {
          offline,
          latency: latencyMs,
          downloadThroughput: downloadKbps < 0 ? -1 : Math.round((downloadKbps * 1024) / 8),
          uploadThroughput: uploadKbps < 0 ? -1 : Math.round((uploadKbps * 1024) / 8),
        });
      } catch {}
    }
    return { offline, latencyMs, downloadKbps, uploadKbps };
  }

  async detach() {
    const cdp = this.cdpSession;
    this.cdpSession = null;
    if (this.pendingDialog) {
      try { await this.pendingDialog.decide(false); } catch {}
    }
    try { await cdp?.detach?.(); } catch {}
  }
}

// Context-level network controls (blocked patterns, tracker blocker, QA mocks, and Playwright tracing).
export class ContextNetworkControls {
  constructor({ traceDir = '' } = {}) {
    this.blockedPatterns = [];
    this.blockTrackers = false;
    this.mocks = [];
    this.networkProfile = { ...NETWORK_PRESETS.online, preset: 'online' };
    this.emulation = {
      device: null,
      viewport: null,
      colorScheme: 'light',
      reducedMotion: 'no-preference',
      media: 'screen',
      offline: false,
      geolocation: null,
      timezoneId: null,
    };
    this.traceDir = traceDir || path.join(os.tmpdir(), 'agentbrowser-traces');
    this.traceActive = false;
    this.traceStartedAt = 0;
    this.lastTracePath = null;
  }

  setBlocked({ patterns, blockTrackers } = {}) {
    if (typeof blockTrackers === 'boolean') this.blockTrackers = blockTrackers;
    if (patterns !== undefined) {
      const list = Array.isArray(patterns)
        ? patterns
        : (typeof patterns === 'string' ? patterns.split(/[\n,]/) : null);
      if (!list) throw new Error('patterns must be a string or array of strings');
      this.blockedPatterns = list
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .slice(0, MAX_BLOCKED_PATTERNS);
    }
    return {
      blockTrackers: this.blockTrackers,
      blockedPatterns: [...this.blockedPatterns],
    };
  }

  addMock({ urlPattern, method = '*', status = 200, contentType = 'application/json', body = '', headers = {} } = {}) {
    const pat = String(urlPattern || '').trim();
    if (!pat || pat.length > 512) throw new Error('urlPattern required');
    const code = Math.trunc(Number(status) || 200);
    if (code < 100 || code > 599) throw new Error('mock status must be between 100 and 599');
    if (this.mocks.length >= MAX_MOCKS) throw new Error(`maximum mock rules (${MAX_MOCKS}) reached`);

    const cleanHeaders = {};
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
      for (const [k, v] of Object.entries(headers)) {
        cleanHeaders[String(k).toLowerCase().slice(0, 80)] = String(v ?? '').slice(0, 512);
      }
    }
    const serializedBody = typeof body === 'string' ? body : JSON.stringify(body ?? '');
    if (serializedBody.length > 262_144) throw new Error('mock body exceeds 256KB limit');

    const mock = {
      id: 'm' + (this.mocks.length + 1) + '-' + Date.now().toString(36).slice(-4),
      urlPattern: pat,
      method: String(method || '*').toUpperCase(),
      status: code,
      contentType: String(contentType || 'application/json'),
      body: serializedBody,
      headers: cleanHeaders,
      hits: 0,
    };
    this.mocks.push(mock);
    return { id: mock.id, urlPattern: mock.urlPattern, method: mock.method, status: mock.status, totalMocks: this.mocks.length };
  }

  clearMocks(id) {
    if (id) {
      const before = this.mocks.length;
      this.mocks = this.mocks.filter((m) => m.id !== id && m.urlPattern !== id);
      return { removed: before - this.mocks.length, remaining: this.mocks.length };
    }
    const removed = this.mocks.length;
    this.mocks = [];
    return { removed, remaining: 0 };
  }

  shouldBlock(url) {
    if (this.blockTrackers && TRACKER_DOMAINS.some((d) => matchesUrlRule(url, d))) {
      return `tracker blocked: ${new URL(url).hostname}`;
    }
    for (const pat of this.blockedPatterns) {
      if (matchesUrlRule(url, pat)) return `blocked by network rule: ${pat}`;
    }
    return null;
  }

  findMock(url, method = 'GET') {
    const m = String(method || 'GET').toUpperCase();
    for (let i = this.mocks.length - 1; i >= 0; i--) {
      const rule = this.mocks[i];
      if (rule.method !== '*' && rule.method !== m) continue;
      if (matchesUrlRule(url, rule.urlPattern)) {
        rule.hits++;
        return rule;
      }
    }
    return null;
  }

  async startTrace(ctx, { screenshots = true, snapshots = true, sources = false } = {}) {
    if (!ctx?.tracing?.start) throw new Error('tracing is not supported by the active browser context');
    if (this.traceActive) throw new Error('trace recording is already running');
    await ctx.tracing.start({
      screenshots: Boolean(screenshots),
      snapshots: Boolean(snapshots),
      sources: Boolean(sources),
    });
    this.traceActive = true;
    this.traceStartedAt = Date.now();
    return { active: true, startedAt: new Date(this.traceStartedAt).toISOString() };
  }

  async stopTrace(ctx, sessionId = 'default') {
    if (!ctx?.tracing?.stop) throw new Error('tracing is not supported by the active browser context');
    if (!this.traceActive) throw new Error('no active trace recording');
    await fs.mkdir(this.traceDir, { recursive: true });
    const safeSession = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
    const outPath = path.join(this.traceDir, `trace-${safeSession}-${Date.now()}.zip`);
    const durationMs = Math.max(0, Date.now() - this.traceStartedAt);
    try {
      await ctx.tracing.stop({ path: outPath });
    } finally {
      this.traceActive = false;
      this.traceStartedAt = 0;
    }
    let bytes = 0;
    try { bytes = (await fs.stat(outPath)).size; } catch {}
    this.lastTracePath = outPath;
    return { active: false, path: outPath, bytes, durationMs };
  }

  traceStatus() {
    return {
      active: this.traceActive,
      startedAt: this.traceActive ? new Date(this.traceStartedAt).toISOString() : null,
      durationMs: this.traceActive ? Math.max(0, Date.now() - this.traceStartedAt) : 0,
      lastTracePath: this.lastTracePath,
    };
  }
}
