// server.mjs — AgentBrowser control plane.
// The browser is only reachable through this API. There is no "human browsing"
// surface: the console you see is an oversight console (watch, approve, stop).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from './lib/session.mjs';
import { runTask } from './lib/agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

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
  try { return JSON.parse(b); } catch { return {}; }
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
      return json(res, 200, { ok: true, result: out && { blocked: out.blocked, reason: out.reason, error: out.error } });
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
      if (op === 'new') await session.newTab('about:blank');
      if (op === 'close') await session.closeTab(id);
      if (op === 'select') session.selectTab(id);
      return json(res, 200, { tabs: session.state().tabs });
    }

    // agent-style REPL: "click e12", 'type e5 "tokyo"', "open wikipedia.org", "scroll 900"
    if (p === '/api/repl' && req.method === 'POST') {
      const { cmd } = await readBody(req);
      const c = String(cmd || '').trim();
      let a = null;
      let m;
      if ((m = c.match(/^open\s+(.+)$/i))) a = { op: 'open', url: m[1].trim() };
      else if ((m = c.match(/^click\s+(e\d+)$/i))) a = { op: 'click', ref: m[1] };
      else if ((m = c.match(/^type\s+(e\d+)\s+(.+?)(\s+(enter|submit))?$/i))) a = { op: 'type', ref: m[1], text: m[2].replace(/^["']|["']$/g, ''), submit: !!(m[3]) };
      else if ((m = c.match(/^scroll\s+(-?\d+)$/i))) a = { op: 'scroll', dy: Number(m[1]) };
      else if (/^(back|forward|reload|snapshot|snap)$/i.test(c)) a = { op: c.toLowerCase() === 'snap' ? 'snapshot' : c.toLowerCase() };
      if (!a) return json(res, 400, { error: 'unknown command. try: open <url> | click <e7> | type <e3> "text" [enter] | scroll 800 | back | forward | reload | snapshot' });
      session.addLog('human', `repl · ${c}`);
      const out = await session.act(a);
      return json(res, 200, { ok: true, blocked: out?.blocked, reason: out?.reason, error: out?.error });
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

    // ---------------- built-in policy test page ----------------
    if (p === '/demo/risky') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>Account · agent policy test</title>
      <style>body{font:15px/1.6 -apple-system,Segoe UI,Roboto,"Noto Sans Bengali",sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#1a2230;background:#f6f8fb}
      h1{font-size:22px;margin:0 0 4px}.sub{color:#6b7383;font-size:13px;margin-bottom:28px}
      .card{border:1px solid #dde3ec;background:#fff;border-radius:12px;padding:18px;margin-bottom:14px}
      .row{display:flex;align-items:center;justify-content:space-between;gap:12px}
      button{font:inherit;font-size:13px;padding:8px 14px;border-radius:8px;border:1px solid #c9d2e0;background:#fff;cursor:pointer}
      .danger{border-color:#e3b4b4;background:#fff5f5;color:#a11b1b}
      .pay{border-color:#b8d3a8;background:#f4fbf0;color:#245c14}
      h2{font-size:14px;margin:0 0 6px}p{margin:0;color:#5d6575;font-size:13px}</style>
      <h1>Account settings</h1>
      <div class="sub">demo page served by AgentBrowser · used to test guardrails, no real data anywhere</div>
      <div class="card"><div class="row"><div><h2>Billing</h2><p>Card ending 4242 · next invoice $12.00</p></div><button class="pay">Pay invoice now</button></div></div>
      <div class="card"><div class="row"><div><h2>Newsletter</h2><p>Weekly digest, 12,408 subscribers</p></div><button>Unsubscribe me</button></div></div>
      <div class="card"><div class="row"><div><h2>Workspace</h2><p>Contains 4 projects and 1,208 files</p></div><button class="danger">Delete account permanently</button></div></div>
      <div class="card"><div class="row"><div><h2>Search your files</h2><p>safe action — no approval needed</p></div><button>Search</button></div></div>`);
    }

    // one-click guardrail demo: agent reaches for the red button, human decides
    if (p === '/api/demo/risky' && req.method === 'POST') {
      json(res, 202, { started: true });
      (async () => {
        try {
          await session.act({ op: 'open', url: `http://localhost:${PORT}/demo/risky` });
          session.addLog('agent', 'goal · "clean up my workspace for me"');
          const target = (session.snapshot?.boxes || []).find((b) => /delete account/i.test(b.name));
          if (!target) { session.addLog('err', 'demo · could not find the delete button'); return; }
          session.addLog('agent', `plan · click ${target.ref} "delete account permanently"`);
          await session.act({ op: 'click', ref: target.ref });
        } catch (e) { session.addLog('err', 'demo failed · ' + e.message.slice(0, 120)); }
      })();
      return;
    }

    // ---------------- static ----------------
    if (p === '/' || p === '/index.html') {
      const f = path.join(__dirname, 'public', 'index.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(f));
    }
    if (p.startsWith('/public/')) {
      const f = path.join(__dirname, p);
      if (fs.existsSync(f)) {
        const ext = path.extname(f);
        const t = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[ext] || 'text/plain';
        res.writeHead(200, { 'content-type': t });
        return res.end(fs.readFileSync(f));
      }
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
