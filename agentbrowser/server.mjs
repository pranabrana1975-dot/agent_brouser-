// server.mjs — AgentBrowser headless HTTP control plane + Streamable HTTP MCP.

import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tools } from './tools.mjs';
import { SessionManager, validateSessionId } from './lib/manager.mjs';
import { isLoopbackHost } from './lib/policy.mjs';
import { runTask } from './lib/agent.mjs';
import { createSessionExecutor, dispatchMcpMessage } from './lib/mcp-handler.mjs';

const DEFAULT_MAX_BODY_BYTES = 1_000_000;

export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function verifyBearerToken(authHeader, expectedToken) {
  if (!expectedToken) return true;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return false;
  const provided = authHeader.slice(7);
  // Compare fixed-length SHA-256 digests so timing leaks neither content nor token length.
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expectedToken, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

export function assertSafeBind(host, token) {
  if (!token && !isLoopbackHost(host)) {
    throw new Error('AGENT_BROWSER_TOKEN is required when binding to a non-loopback host');
  }
}

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function json(res, code, body, extraHeaders = {}) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    ...BASE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
    ...extraHeaders,
  });
  res.end(s);
}

function requireMethod(req, allowed) {
  const list = Array.isArray(allowed) ? allowed : [allowed];
  if (!list.includes(req.method)) {
    throw new HttpError(405, `method ${req.method} not allowed`, { allow: list.join(', ') });
  }
}

function requireJsonContentType(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.startsWith('application/json')) {
    throw new HttpError(415, 'application/json content-type required');
  }
}

async function readJsonBody(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new HttpError(413, `payload too large (max ${maxBytes} bytes)`);
    }
    chunks.push(buf);
  }
  if (total === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function resolveSession(manager, req, url, { create = true } = {}) {
  const headerId = req.headers['x-session-id'] || req.headers['mcp-session-id'];
  const queryId = req.method === 'GET' ? url.searchParams.get('session') : null;
  const raw = headerId || queryId || 'default';
  const id = validateSessionId(raw);
  const session = manager.get(id, { create });
  if (!session) throw new HttpError(404, `unknown session: ${id}`);
  return session;
}

export function createControlServer(opts = {}) {
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
  const token = opts.token ?? process.env.AGENT_BROWSER_TOKEN ?? '';
  const maxBodyBytes = Number.isFinite(opts.maxBodyBytes) && opts.maxBodyBytes > 0
    ? opts.maxBodyBytes
    : DEFAULT_MAX_BODY_BYTES;
  const taskOptions = opts.taskOptions || {};

  assertSafeBind(host, token);

  const manager = opts.manager || new SessionManager(opts.managerOptions);
  const ownsManager = !opts.manager;
  const sseConnections = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    try {
      if (!verifyBearerToken(req.headers.authorization, token)) {
        return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer realm="agentbrowser"' });
      }

      // ---------------- health & discovery ----------------
      if (p === '/api/health') {
        requireMethod(req, 'GET');
        return json(res, 200, {
          ready: manager.isBrowserReady(),
          engine: manager.engineLabel(),
          sessions: manager.sessions.size,
          maxSessions: manager.maxSessions,
        });
      }

      if (p === '/api/tools') {
        requireMethod(req, 'GET');
        return json(res, 200, { tools });
      }

      // ---------------- Streamable HTTP MCP (/mcp) ----------------
      if (p === '/mcp') {
        requireMethod(req, ['POST', 'DELETE']);
        if (req.method === 'DELETE') {
          const rawId = req.headers['mcp-session-id'] || req.headers['x-session-id'];
          if (!rawId) throw new HttpError(400, 'Mcp-Session-Id header required');
          const id = validateSessionId(rawId);
          const closed = await manager.close(id);
          return json(res, closed ? 200 : 404, { ok: closed });
        }
        requireJsonContentType(req);
        let body;
        try {
          body = await readJsonBody(req, maxBodyBytes);
        } catch (e) {
          if (e.status === 400) {
            return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          }
          throw e;
        }
        const rawSid = req.headers['mcp-session-id'] || req.headers['x-session-id'] || 'default';
        const sid = validateSessionId(rawSid);
        const invokeTool = createSessionExecutor(() => manager.getOrCreate(sid));
        const reply = await dispatchMcpMessage(body, invokeTool);
        if (reply === null) {
          res.writeHead(202, { ...BASE_HEADERS, 'mcp-session-id': sid });
          return res.end();
        }
        return json(res, 200, reply, { 'mcp-session-id': sid });
      }

      // ---------------- multi-session management ----------------
      if (p === '/api/sessions') {
        requireMethod(req, ['GET', 'POST']);
        if (req.method === 'GET') {
          return json(res, 200, { sessions: manager.list(), maxSessions: manager.maxSessions });
        }
        requireJsonContentType(req);
        const b = await readJsonBody(req, maxBodyBytes);
        if (!b || typeof b !== 'object' || Array.isArray(b)) {
          throw new HttpError(400, 'JSON object required');
        }
        const s = manager.create(b);
        if (b.eager) await s.init();
        return json(res, 201, { id: s.id, state: s.state() });
      }

      if (p.startsWith('/api/sessions/')) {
        let decoded;
        try { decoded = decodeURIComponent(p.slice('/api/sessions/'.length)); }
        catch { throw new HttpError(400, 'invalid session id encoding'); }
        const id = validateSessionId(decoded);
        requireMethod(req, ['GET', 'DELETE']);
        if (req.method === 'GET') {
          const s = manager.get(id, { create: false });
          if (!s) throw new HttpError(404, `unknown session: ${id}`);
          return json(res, 200, s.state());
        }
        const ok = await manager.close(id);
        return json(res, ok ? 200 : 404, { ok });
      }

      // ---------------- SSE event stream ----------------
      if (p === '/api/events') {
        requireMethod(req, 'GET');
        const session = resolveSession(manager, req, url, { create: true });
        res.writeHead(200, {
          ...BASE_HEADERS,
          'content-type': 'text/event-stream; charset=utf-8',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(': connected\n\n');
        res.write(`data: ${JSON.stringify({ type: 'state', sessionId: session.id, state: session.state() })}\n\n`);

        const unsubscribe = session.subscribe((evt) => {
          try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch {}
        });
        const ping = setInterval(() => {
          try { res.write(': ping\n\n'); } catch {}
        }, 15_000);
        ping.unref?.();

        const conn = { res, cleanup: () => { clearInterval(ping); unsubscribe(); sseConnections.delete(conn); } };
        sseConnections.add(conn);
        req.on('close', conn.cleanup);
        return;
      }

      // ---------------- read models ----------------
      if (p === '/api/state') {
        requireMethod(req, 'GET');
        const session = resolveSession(manager, req, url, { create: true });
        return json(res, 200, session.state());
      }

      if (p === '/api/shot.jpg') {
        requireMethod(req, 'GET');
        const session = resolveSession(manager, req, url, { create: false });
        const wantFresh = url.searchParams.get('fresh') === '1';
        const fullPage = url.searchParams.get('fullPage') === '1';
        if ((wantFresh || !session.shotBuf) && session.active()) {
          try { await session.capture({ fullPage }); } catch {}
        }
        if (!session.shotBuf) {
          res.writeHead(404, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
          return res.end('no shot yet');
        }
        res.writeHead(200, {
          ...BASE_HEADERS,
          'content-type': 'image/jpeg',
          'content-length': session.shotBuf.length,
        });
        return res.end(session.shotBuf);
      }

      if (p === '/api/downloads') {
        requireMethod(req, 'GET');
        const session = resolveSession(manager, req, url, { create: true });
        return json(res, 200, { downloads: session.downloads });
      }

      if (p === '/api/storage') {
        requireMethod(req, ['GET', 'POST']);
        const session = resolveSession(manager, req, url, { create: true });
        if (req.method === 'GET') {
          const storageState = await session.getStorageState();
          return json(res, 200, storageState);
        }
        requireJsonContentType(req);
        const b = await readJsonBody(req, maxBodyBytes);
        try {
          const imported = await session.setStorageState(b);
          return json(res, 200, { ok: true, ...imported });
        } catch (e) {
          throw new HttpError(400, e.message);
        }
      }

      // ---------------- actions & controls ----------------
      if (p === '/api/act') {
        requireMethod(req, 'POST');
        requireJsonContentType(req);
        const a = await readJsonBody(req, maxBodyBytes);
        if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a.op !== 'string') {
          throw new HttpError(400, 'action object with string "op" required');
        }
        const session = resolveSession(manager, req, url, { create: true });
        try {
          const out = await session.act(a);
          return json(res, 200, { ok: !out?.blocked && !out?.error, result: out });
        } catch (e) {
          if (e.code === 'BUDGET_EXHAUSTED') throw new HttpError(429, e.message);
          if (/^unknown action:/i.test(e.message)) throw new HttpError(400, e.message);
          throw e;
        }
      }

      if (p === '/api/task') {
        requireMethod(req, 'POST');
        requireJsonContentType(req);
        const b = await readJsonBody(req, maxBodyBytes);
        const goal = String(b?.goal || '').trim();
        if (!goal) throw new HttpError(400, 'goal required');
        const session = resolveSession(manager, req, url, { create: true });
        if (session.busy) throw new HttpError(409, 'a task is already running');
        const ac = new AbortController();
        session.taskAbort = ac;
        session.busy = (async () => {
          try { return await runTask(session, goal, { ...taskOptions, signal: ac.signal }); }
          finally { session.busy = null; session.taskAbort = null; }
        })();
        const answer = await session.busy;
        return json(res, 200, { answer });
      }

      if (p === '/api/approval') {
        requireMethod(req, 'POST');
        requireJsonContentType(req);
        const b = await readJsonBody(req, maxBodyBytes);
        if (typeof b?.id !== 'string' || !b.id) throw new HttpError(400, 'approval id required');
        const session = resolveSession(manager, req, url, { create: false });
        const ok = session.decideApproval(b.id, Boolean(b.allow));
        return json(res, ok ? 200 : 404, { ok });
      }

      if (p === '/api/pause') {
        requireMethod(req, 'POST');
        requireJsonContentType(req);
        const b = await readJsonBody(req, maxBodyBytes);
        const session = resolveSession(manager, req, url, { create: true });
        session.paused = Boolean(b?.paused);
        session.addLog('sys', session.paused ? 'human takeover · agent paused' : 'agent resumed');
        session.emit('state', { state: session.state() });
        return json(res, 200, { paused: session.paused });
      }

      if (p === '/api/policy') {
        requireMethod(req, 'POST');
        requireJsonContentType(req);
        const b = await readJsonBody(req, maxBodyBytes);
        if (!b || typeof b !== 'object' || Array.isArray(b)) {
          throw new HttpError(400, 'policy object required');
        }
        const session = resolveSession(manager, req, url, { create: true });
        try {
          const updated = session.policy.update(b);
          session.addLog('policy', 'policy updated');
          session.emit('state', { state: session.state() });
          return json(res, 200, updated);
        } catch (e) {
          throw new HttpError(400, e.message);
        }
      }

      if (p === '/api/tab') {
        requireMethod(req, 'POST');
        requireJsonContentType(req);
        const b = await readJsonBody(req, maxBodyBytes);
        const { op, id, url: tabUrl } = b || {};
        if (!['new', 'close', 'select'].includes(op)) {
          throw new HttpError(400, 'invalid tab operation');
        }
        if ((op === 'close' || op === 'select') && (typeof id !== 'string' || !id)) {
          throw new HttpError(400, 'tab id required');
        }
        const session = resolveSession(manager, req, url, { create: true });
        try {
          const tabs = await session.tabOp(op, id, tabUrl);
          return json(res, 200, { tabs });
        } catch (e) {
          if (/^unknown tab:/i.test(e.message)) throw new HttpError(404, e.message);
          if (/blocked|allowlist|only HTTP|invalid url|max/i.test(e.message)) throw new HttpError(400, e.message);
          throw e;
        }
      }

      if (p === '/api/reset') {
        requireMethod(req, 'POST');
        requireJsonContentType(req);
        await readJsonBody(req, maxBodyBytes);
        const session = resolveSession(manager, req, url, { create: true });
        await session.reset();
        return json(res, 200, { ok: true, state: session.state() });
      }

      return json(res, 404, { error: 'not found' });
    } catch (e) {
      const status = Number.isInteger(e.status) ? e.status : 500;
      const headers = e.headers || {};
      if (status === 413) {
        // Close connection after 413 so we don't keep reading an oversized request stream.
        headers.connection = 'close';
      }
      if (!res.headersSent) {
        json(res, status, { error: e.message || 'internal error' }, headers);
      } else {
        try { res.end(); } catch {}
      }
      if (status === 413) {
        res.once('finish', () => { try { req.destroy(); } catch {} });
      }
    }
  });

  async function close() {
    for (const conn of sseConnections) {
      conn.cleanup();
      try { conn.res.end(); } catch {}
    }
    await new Promise((resolve) => server.close(() => resolve()));
    if (ownsManager) await manager.shutdown();
  }

  return { server, manager, close };
}

// Start the HTTP server only when executed directly (`node server.mjs` / `npm start`).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.HOST || '127.0.0.1';
  const { server, manager, close } = createControlServer({ host: HOST });

  server.listen(PORT, HOST, async () => {
    console.log(`AgentBrowser control plane → http://${HOST}:${PORT} (MCP: http://${HOST}:${PORT}/mcp)`);
    try {
      const def = manager.getOrCreate('default');
      await def.init();
      def.addLog('sys', 'ready · agent-only surface enabled · human browsing disabled');
      await def.act({ op: 'open', url: 'about:blank' });
    } catch (e) {
      console.error('engine start failed:', e.message);
    }
  });

  let exiting = false;
  const bye = async () => {
    if (exiting) return;
    exiting = true;
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
