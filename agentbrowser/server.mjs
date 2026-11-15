// server.mjs — AgentBrowser control plane.
// Headless, agent-facing HTTP control plane.

import http from 'node:http';
import { tools } from './tools.mjs';
import { Session } from './lib/session.mjs';
import { runTask } from './lib/agent.mjs';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.AGENT_BROWSER_TOKEN || '';
if (!TOKEN && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  throw new Error('AGENT_BROWSER_TOKEN is required when binding to a non-loopback host');
}

const session = new Session();

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

async function readBody(req) {
  let b = '';
  for await (const chunk of req) { b += chunk; if (b.length > 1e6) break; }
  if (!b) return {};
  try { return JSON.parse(b); } catch { throw new Error('invalid JSON'); }
}

const sseClients = new Set();
session.subscribe((evt) => {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const c of sseClients) { try { c.write(line); } catch {} }
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'unauthorized' });
    if (req.method === 'POST' && !(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res, 415, { error: 'application/json required' });
    if (p === '/api/health' && req.method === 'GET') return json(res, 200, { ready: !!session.browser, engine: session.state().engine });
    if (p === '/api/tools' && req.method === 'GET') return json(res, 200, { tools });
    // ---------------- stream ----------------
    if (p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      res.write(`data: ${JSON.stringify({ type: 'state', state: session.state() })}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    // ---------------- read models ----------------
    if (p === '/api/state') return json(res, 200, session.state());

    if (p === '/api/shot.jpg') {
      if (!session.shotBuf) { res.writeHead(404); return res.end('no shot yet'); }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'content-length': session.shotBuf.length });
      return res.end(session.shotBuf);
    }

    // ---------------- actions ----------------
    if (p === '/api/act' && req.method === 'POST') {
      const a = await readBody(req);
      const out = await session.act(a);
      return json(res, 200, { ok: !out?.blocked && !out?.error, result: out });
    }

    if (p === '/api/task' && req.method === 'POST') {
      const { goal } = await readBody(req);
      if (!goal || !String(goal).trim()) return json(res, 400, { error: 'goal required' });
      if (session.busy) return json(res, 409, { error: 'a task is already running' });
      session.busy = (async () => {
        try { return await runTask(session, String(goal).trim()); }
        finally { session.busy = null; }
      })();
      const answer = await session.busy;
      return json(res, 200, { answer });
    }

    if (p === '/api/approval' && req.method === 'POST') {
      const { id, allow } = await readBody(req);
      const ok = session.decideApproval(id, !!allow);
      return json(res, ok ? 200 : 404, { ok });
    }

    if (p === '/api/pause' && req.method === 'POST') {
      const { paused } = await readBody(req);
      session.paused = !!paused;
      session.addLog('sys', paused ? 'human takeover · agent paused' : 'agent resumed');
      session.emit('state', { state: session.state() });
      return json(res, 200, { paused: session.paused });
    }

    if (p === '/api/policy' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.approvalsEnabled === 'boolean') session.policy.approvalsEnabled = b.approvalsEnabled;
      if (typeof b.blockedHosts === 'string') session.policy.blockedHosts = b.blockedHosts.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      if (typeof b.allowedHosts === 'string') session.policy.allowedHosts = b.allowedHosts.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      session.addLog('policy', 'policy updated');
      session.emit('state', { state: session.state() });
      return json(res, 200, session.state().policy);
    }

    if (p === '/api/tab' && req.method === 'POST') {
      const { op, id } = await readBody(req);
      if (!['new', 'close', 'select'].includes(op)) return json(res, 400, { error: 'invalid tab operation' });
      if (op === 'new') { await session.newTab('about:blank'); await session.snap(); }
      if (op === 'close') await session.closeTab(id);
      if (op === 'select') await session.selectTab(id);
      return json(res, 200, { tabs: session.state().tabs });
    }

    if (p === '/api/reset' && req.method === 'POST') {
      for (const [, pend] of session.pending) { try { pend.resolve(false); } catch {} }
      session.pending.clear();
      await session.shutdown();
      session.browser = null; session.ctx = null; session.tabs = []; session.snapshot = null; session.shotBuf = null;
      session.addLog('sys', 'session reset · browser process killed');
      await session.init();
      session.emit('state', { state: session.state() });
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`AgentBrowser control plane → http://${HOST}:${PORT}`);
  try {
    await session.init();
    session.addLog('sys', 'ready · agent-only surface enabled · human browsing disabled');
    await session.act({ op: 'open', url: 'about:blank' });
  } catch (e) {
    console.error('engine start failed:', e.message);
  }
});

const bye = async () => { await session.shutdown(); process.exit(0); };
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
