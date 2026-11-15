import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../lib/manager.mjs';
import { createControlServer } from '../server.mjs';
import { AgentBrowser } from '../sdk.mjs';

const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

// Realistic in-memory Playwright Browser/Context/Page harness to exercise the
// full Session, SessionManager, HTTP server, SSE, SDK, and /mcp stack without
// requiring a downloaded browser binary.
function createFakeBrowserHarness() {
  let launchCount = 0;
  const actions = [];
  let activeBrowser = null;

  function makePage(ctx, initialUrl = 'about:blank') {
    const emitter = new EventEmitter();
    let currentUrl = initialUrl;
    let currentTitle = initialUrl === 'about:blank' ? '' : `Title for ${new URL(initialUrl).hostname}`;
    let selectedCountry = 'India';
    let hovered = false;

    const makeLocator = (selector) => ({
      first() { return this; },
      async getAttribute(name) {
        if (name === 'href' && selector.includes('e5')) return 'https://docs.example.com/popup';
        return null;
      },
      async scrollIntoViewIfNeeded() { actions.push({ op: 'scrollIntoView', selector }); },
      async focus() { actions.push({ op: 'focus', selector }); },
      async click(opts) {
        actions.push({ op: 'click', selector, button: opts?.button });
        if (selector.includes('e5')) {
          // Simulate target="_blank" popup opening on click!
          const popup = makePage(ctx, 'https://docs.example.com/popup');
          ctx.emit('page', popup);
        }
      },
      async dblclick() { actions.push({ op: 'dblclick', selector }); },
      async hover() { hovered = true; actions.push({ op: 'hover', selector }); },
      async fill(text) { actions.push({ op: 'fill', selector, text }); },
      async type(text) { actions.push({ op: 'type', selector, text }); },
      async selectOption(criteria) {
        actions.push({ op: 'select', selector, criteria });
        selectedCountry = criteria[0]?.label || criteria[0]?.value || 'Updated';
      },
      async setInputFiles(files) { actions.push({ op: 'upload', selector, files }); },
      async waitFor() { actions.push({ op: 'waitFor', selector }); },
    });

    const page = {
      on: (ev, fn) => emitter.on(ev, fn),
      emit: (ev, ...args) => emitter.emit(ev, ...args),
      mainFrame: () => page,
      url: () => currentUrl,
      title: async () => currentTitle,
      async goto(url) {
        await ctx._runRoute(url, 'document');
        currentUrl = url;
        currentTitle = url === 'about:blank' ? 'Blank' : `Page ${new URL(url).hostname}${new URL(url).pathname}`;
        emitter.emit('framenavigated', page);
        emitter.emit('load');
      },
      async waitForLoadState() {},
      async waitForURL() {},
      async goBack() { actions.push({ op: 'back' }); },
      async goForward() { actions.push({ op: 'forward' }); },
      async reload() { actions.push({ op: 'reload' }); },
      async screenshot() { return FAKE_JPEG; },
      locator: (sel) => makeLocator(sel),
      frameLocator: (frameSel) => ({ locator: (sel) => makeLocator(`${frameSel} >> ${sel}`) }),
      getByText: (txt) => makeLocator(`text=${txt}`),
      keyboard: { async press(key) { actions.push({ op: 'press', key }); } },
      mouse: { async wheel(dx, dy) { actions.push({ op: 'wheel', dx, dy }); } },
      async close() { emitter.emit('close'); },
      async evaluate(fn, arg) {
        // Distinguish pageText(limit) from PAGE_PROBE(opts)
        if (typeof arg === 'number') {
          const text = 'Clean extracted reader prose about coronavirus research and modern browser automation.';
          return {
            title: currentTitle,
            url: currentUrl,
            text: text.slice(0, arg),
            length: text.length,
            truncated: text.length > arg,
          };
        }
        return {
          url: currentUrl,
          title: currentTitle,
          vw: 1280,
          vh: 800,
          scrollY: 0,
          docHeight: 1200,
          htmlBytes: 2048,
          totalActions: 8,
          truncatedActions: 0,
          nodes: [
            { ref: '', role: 'h1', name: currentTitle || 'Ready', kind: 'head', value: '', href: '', inViewport: true, x: 10, y: 10, w: 300, h: 40 },
            { ref: 'e1', role: 'searchbox', name: 'Search docs', value: '', href: '', kind: 'act', inViewport: true, x: 10, y: 60, w: 240, h: 32, inputType: 'search' },
            { ref: 'e2', role: 'password', name: 'Password', value: '', href: '', kind: 'act', inViewport: true, x: 10, y: 100, w: 240, h: 32, inputType: 'password' },
            { ref: 'e3', role: 'combobox', name: 'Country', value: selectedCountry, href: '', kind: 'act', inViewport: true, x: 10, y: 140, w: 200, h: 32, options: [{ value: 'in', label: 'India', selected: selectedCountry === 'India' }, { value: 'jp', label: 'Japan', selected: selectedCountry === 'Japan' }] },
            { ref: 'e4', role: 'button', name: 'Delete project', value: '', href: '', kind: 'act', inViewport: true, x: 10, y: 190, w: 140, h: 34 },
            { ref: 'e5', role: 'link', name: 'Open guide in new tab', value: '', href: 'https://docs.example.com/popup', kind: 'act', inViewport: true, x: 10, y: 240, w: 180, h: 24 },
            { ref: 'e6', role: 'button', name: 'Submit', value: '', href: '', kind: 'act', inViewport: true, x: 10, y: 280, w: 100, h: 34 },
            { ref: 'e7', role: 'textbox', name: 'Message body', value: '', href: '', kind: 'act', inViewport: true, x: 10, y: 320, w: 300, h: 80 },
            { ref: 'e8', role: 'file', name: 'Attachment', value: '', href: '', kind: 'act', inViewport: true, x: 10, y: 410, w: 200, h: 30, inputType: 'file' },
            ...(hovered ? [{ ref: 'e9', role: 'menuitem', name: 'Revealed menu item', value: '', href: '', kind: 'act', inViewport: true, x: 20, y: 260, w: 140, h: 28 }] : []),
          ],
          textBits: ['Welcome to the AgentBrowser integration test page with rich controls.'],
          bodyText: 'Full body text that should stay server-side unless requested.',
        };
      },
    };
    return page;
  }

  function makeContext(opts) {
    const emitter = new EventEmitter();
    const cookies = [];
    const initScripts = [];
    let routeHandler = null;
    const ctx = {
      options: opts,
      on: (ev, fn) => emitter.on(ev, fn),
      emit: (ev, ...args) => emitter.emit(ev, ...args),
      async route(_pat, handler) { routeHandler = handler; },
      async _runRoute(url, resourceType = 'fetch') {
        if (!routeHandler) return;
        let aborted = false;
        await routeHandler({
          request: () => ({ url: () => url, resourceType: () => resourceType }),
          abort: async () => { aborted = true; },
          continue: async () => {},
        });
        if (aborted) throw new Error('net::ERR_BLOCKED_BY_CLIENT');
      },
      async addInitScript(fn, arg) { initScripts.push({ fn, arg }); },
      async newPage() { return makePage(ctx, 'about:blank'); },
      async addCookies(list) { cookies.push(...list); },
      async storageState() { return { cookies: [...cookies], origins: [] }; },
      async close() { emitter.emit('close'); },
    };
    return ctx;
  }

  async function browserLauncher(launchOpts) {
    launchCount++;
    const emitter = new EventEmitter();
    let connected = true;
    const contexts = [];
    const browser = {
      launchOpts,
      contexts,
      version: () => '136.0.7103.48',
      isConnected: () => connected,
      on: (ev, fn) => emitter.on(ev, fn),
      async newContext(opts) {
        const c = makeContext(opts);
        contexts.push(c);
        return c;
      },
      async close() {
        connected = false;
        emitter.emit('disconnected');
      },
      simulateCrash() {
        connected = false;
        emitter.emit('disconnected');
      },
    };
    activeBrowser = browser;
    return browser;
  }

  return {
    browserLauncher,
    actions,
    getLaunchCount: () => launchCount,
    getActiveBrowser: () => activeBrowser,
  };
}

async function startTestServer(extra = {}) {
  const harness = createFakeBrowserHarness();
  const manager = new SessionManager({
    browserLauncher: harness.browserLauncher,
    maxSessions: extra.maxSessions ?? 4,
    idleTtlMs: extra.idleTtlMs ?? 60_000,
    sweepIntervalMs: 0,
    sessionDefaults: {
      minActionIntervalMs: 0,
      maxActions: extra.maxActions ?? 500,
      maxTabs: extra.maxTabs ?? 5,
      uploadDir: extra.uploadDir ?? '',
      policy: { approvalTimeoutMs: extra.approvalTimeoutMs ?? 5000 },
    },
  });
  const ctrl = createControlServer({
    host: '127.0.0.1',
    token: extra.token ?? 'test-secret-token',
    maxBodyBytes: extra.maxBodyBytes ?? 2048,
    manager,
  });
  await new Promise((resolve) => ctrl.server.listen(0, '127.0.0.1', resolve));
  const { port } = ctrl.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const sdk = new AgentBrowser(baseUrl, { token: extra.token ?? 'test-secret-token' });
  return {
    harness,
    manager,
    baseUrl,
    sdk,
    close: async () => {
      await ctrl.close();
      await manager.shutdown();
    },
  };
}

test('HTTP security: auth, method checks, invalid JSON (400), oversized body (413), missing content-type (415)', async (t) => {
  const env = await startTestServer({ maxBodyBytes: 256 });
  t.after(env.close);

  // Unauthorized without or with wrong Bearer token
  const r401 = await fetch(`${env.baseUrl}/api/health`);
  assert.equal(r401.status, 401);
  assert.equal(r401.headers.get('x-content-type-options'), 'nosniff');

  const auth = { authorization: 'Bearer test-secret-token' };
  const r200 = await fetch(`${env.baseUrl}/api/health`, { headers: auth });
  assert.equal(r200.status, 200);

  // Wrong HTTP methods return 405 with Allow header
  const r405 = await fetch(`${env.baseUrl}/api/state`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r405.status, 405);
  assert.equal(r405.headers.get('allow'), 'GET');

  // Missing JSON content-type returns 415
  const r415 = await fetch(`${env.baseUrl}/api/act`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(r415.status, 415);

  // Malformed JSON returns 400 (not 500)
  const r400 = await fetch(`${env.baseUrl}/api/act`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(r400.status, 400);

  // Oversized payload returns 413
  const r413 = await fetch(`${env.baseUrl}/api/act`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'open', url: 'https://example.com/' + 'a'.repeat(400) }),
  });
  assert.equal(r413.status, 413);

  // Policy endpoint accepts both JSON arrays and strings
  const pol1 = await env.sdk.policy({ allowedHosts: ['example.com', 'docs.example.com'] });
  assert.deepEqual(pol1.allowedHosts, ['example.com', 'docs.example.com']);
  const pol2 = await env.sdk.policy({ allowedHosts: 'example.org, sub.example.org' });
  assert.deepEqual(pol2.allowedHosts, ['example.org', 'sub.example.org']);
});

test('Actions, password masking, popup capture, per-tab titles, screenshots, uploads, and dynamic UA', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-upload-'));
  const outsideFile = path.join(os.tmpdir(), `ab-outside-${Date.now()}.txt`);
  const allowedFile = path.join(tmpDir, 'report.txt');
  const escapedLink = path.join(tmpDir, 'sneaky-link.txt');
  await fs.writeFile(allowedFile, 'hello');
  await fs.writeFile(outsideFile, 'secret');
  await fs.symlink(outsideFile, escapedLink);

  const env = await startTestServer({ uploadDir: tmpDir, maxBodyBytes: 64_000 });
  t.after(async () => {
    await env.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(outsideFile, { force: true });
  });

  // Open page & verify UA matches real Chromium version (not stale Chrome/131)
  const snap = await env.sdk.open('https://example.com/start');
  assert.match(snap.text, /Page example\.com\/start/);
  const ua = env.harness.getActiveBrowser().contexts[0].options.userAgent;
  assert.match(ua, /Chrome\/136\.0\.7103\.48/);
  assert.equal(env.harness.getActiveBrowser().launchOpts.args.includes('--no-sandbox'), false);

  // Search box typing with "delete" does NOT block on approval
  await env.sdk.type('e1', 'how to delete old logs', { submit: true });

  // Password typing NEVER leaks plaintext in logs!
  await env.sdk.type('e2', 'MyUltraSecretPass!99', { submit: false });
  const stAfterPwd = await env.sdk.state();
  const serializedLogs = JSON.stringify(stAfterPwd.log);
  assert.doesNotMatch(serializedLogs, /MyUltraSecretPass!99/);
  assert.match(serializedLogs, /••••••/);

  // Select, hover, press, scroll, wait, read
  const afterSelect = await env.sdk.select('e3', 'Japan');
  assert.match(afterSelect.text, /value="Japan"/);

  const afterHover = await env.sdk.hover('e5');
  assert.match(afterHover.text, /Revealed menu item/);

  await env.sdk.press('Escape');
  await env.sdk.scroll(500);
  await env.sdk.wait({ text: 'Welcome', timeoutMs: 2000 });

  const article = await env.sdk.read({ maxChars: 5000 });
  assert.match(article.text, /coronavirus research/);

  // Live screenshot works via SDK (default { mimeType, base64 } + buffer mode) and GET /api/shot.jpg!
  const shotObj = await env.sdk.screenshot();
  assert.equal(shotObj.mimeType, 'image/png');
  assert.ok(shotObj.base64.length > 0);
  const shotBuf = await env.sdk.screenshot({ type: 'jpeg', encoding: 'buffer' });
  assert.equal(shotBuf[0], 0xff);
  assert.equal(shotBuf[1], 0xd8);
  const httpShot = await fetch(`${env.baseUrl}/api/shot.jpg`, {
    headers: { authorization: 'Bearer test-secret-token' },
  });
  assert.equal(httpShot.status, 200);
  assert.equal(httpShot.headers.get('content-type'), 'image/jpeg');

  // Upload jail blocks path traversal AND symlinks escaping uploadDir, allows safe file with approval
  await env.sdk.policy({ approvalsEnabled: false });
  await assert.rejects(env.sdk.upload('e8', '../etc/passwd'), /escapes AGENT_BROWSER_UPLOAD_DIR/);
  await assert.rejects(env.sdk.upload('e8', 'sneaky-link.txt'), /escapes AGENT_BROWSER_UPLOAD_DIR/);
  await env.sdk.upload('e8', 'report.txt');

  // Clicking a target="_blank" link captures the popup as a new tab with distinct per-tab titles!
  await env.sdk.click('e5');
  const tabs = await env.sdk.tabs('list');
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].title, 'Page example.com/start');
  assert.equal(tabs[1].url, 'https://docs.example.com/popup');
  assert.equal(tabs[1].active, true);
});

test('Approvals: live approval grant, split type+submit gate, and timeout auto-deny (no deadlock)', async (t) => {
  const env = await startTestServer({ approvalTimeoutMs: 120 });
  t.after(env.close);

  await env.sdk.open('https://example.com/');

  // 1) Risky button times out cleanly when nobody approves, and queue remains usable!
  await assert.rejects(env.sdk.click('e4'), /approval timed out/);
  const stillWorks = await env.sdk.snapshot();
  assert.ok(stillWorks.text);

  // 2) Supervisor approves risky action in flight
  await env.sdk.policy({ approvalTimeoutMs: 5000 });
  const pendingClick = env.sdk.click('e4');
  let pendingId = null;
  for (let i = 0; i < 30; i++) {
    const s = await env.sdk.state();
    if (s.pending.length) { pendingId = s.pending[0].id; break; }
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.ok(pendingId);
  const dec = await env.sdk.approve(pendingId, true);
  assert.equal(dec.ok, true);
  const clickedSnap = await pendingClick;
  assert.ok(clickedSnap.text);

  // 3) Split `type(submit: false)` with risky text followed by generic `click("Submit")` requires approval!
  await env.sdk.policy({ approvalTimeoutMs: 100 });
  await env.sdk.type('e7', 'Please wire $10000 to account now', { submit: false });
  await assert.rejects(env.sdk.click('e6'), /approval timed out/);
});

test('Multi-session isolation, shared browser, crash recovery, storage validation, reset, and Streamable HTTP /mcp', async (t) => {
  const env = await startTestServer({ maxSessions: 3, idleTtlMs: 50, maxActions: 10, maxBodyBytes: 32_000 });
  t.after(env.close);

  // Concurrent opens across 2 isolated sessions still launch Chromium ONLY ONCE!
  const s1 = env.sdk.withSession('agent-1');
  const s2 = env.sdk.withSession('agent-2');
  await Promise.all([
    s1.open('https://alpha.example.com/'),
    s2.open('https://beta.example.com/'),
  ]);
  assert.equal(env.harness.getLaunchCount(), 1);
  assert.equal((await s1.state()).url, 'https://alpha.example.com/');
  assert.equal((await s2.state()).url, 'https://beta.example.com/');

  const listed = await env.sdk.listSessions();
  assert.equal(listed.length, 2);

  // Policy in s1 does NOT bleed into s2
  await s1.policy({ allowedHosts: ['alpha.example.com'] });
  await assert.rejects(s1.open('https://gamma.example.com/'), /allowlist/);
  await s2.open('https://gamma.example.com/');

  // Storage import validates cookies against host policy (rejects SSRF/blocked hosts, allows valid)
  await assert.rejects(
    s2.setStorage({ cookies: [{ name: 'sid', value: '1', domain: 'accounts.google.com', path: '/' }] }),
    /cookie rejected/,
  );
  await s2.setStorage({ cookies: [{ name: 'sid', value: 'abc', domain: 'gamma.example.com', path: '/' }] });
  const stored = await s2.getStorage();
  assert.equal(stored.cookies.length, 1);

  // Streamable HTTP MCP (/mcp) works with compact text & native image screenshot!
  const mcpHeaders = {
    authorization: 'Bearer test-secret-token',
    'content-type': 'application/json',
    'mcp-session-id': 'agent-2',
  };
  const mcpSnapRes = await fetch(`${env.baseUrl}/mcp`, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } }),
  });
  assert.equal(mcpSnapRes.status, 200);
  const mcpSnap = await mcpSnapRes.json();
  // Compact text directly — NOT wrapped in JSON with raw bodyText/boxes
  assert.ok(mcpSnap.result.content[0].text.startsWith('[url] https://gamma.example.com/'));
  assert.doesNotMatch(mcpSnap.result.content[0].text, /Full body text/);

  const mcpShotRes = await fetch(`${env.baseUrl}/mcp`, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'browser_screenshot', arguments: {} } }),
  });
  const mcpShot = await mcpShotRes.json();
  assert.equal(mcpShot.result.content[0].type, 'image');
  assert.equal(mcpShot.result.content[0].mimeType, 'image/png');

  // Monotonic log indices even past 600 log entries
  const rawS1 = env.manager.get('agent-1');
  for (let i = 0; i < 620; i++) rawS1.addLog('sys', `entry-${i}`);
  assert.equal(rawS1.log.length, 600);
  assert.ok(rawS1.log.at(-1).i > 620);
  assert.equal(rawS1.log.at(-1).i, rawS1.log.at(-2).i + 1);

  // Reset clears paused flag & exhausted action budget
  await s1.pause(true);
  rawS1.sessionActions = 10; // exhaust budget
  await s1.reset();
  const afterReset = await s1.state();
  assert.equal(afterReset.paused, false);
  assert.equal(afterReset.stats.actions, 0);
  await s1.open('https://alpha.example.com/recovered');

  // Crash recovery automatically relaunches Chromium on next action
  env.harness.getActiveBrowser().simulateCrash();
  await s2.open('https://gamma.example.com/after-crash');
  assert.equal(env.harness.getLaunchCount(), 2);

  // Idle reaper cleans up inactive non-default sessions
  await new Promise((r) => setTimeout(r, 70));
  const reaped = await env.manager.reapIdle();
  assert.ok(reaped.includes('agent-1') && reaped.includes('agent-2'));
});

test('SSE live stream masks passwords, MCP stdio invokes live server tools, and maxSessions returns 429', async (t) => {
  const env = await startTestServer({ maxSessions: 2, maxBodyBytes: 32_000 });
  t.after(env.close);

  // Connect live SSE consumer to default session
  const ac = new AbortController();
  const sseRes = await fetch(`${env.baseUrl}/api/events`, {
    headers: { authorization: 'Bearer test-secret-token' },
    signal: ac.signal,
  });
  assert.equal(sseRes.status, 200);
  const sseChunks = [];
  const reader = sseRes.body.getReader();
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseChunks.push(Buffer.from(value).toString('utf8'));
      }
    } catch {}
  })();

  await env.sdk.open('https://example.com/login');
  await env.sdk.type('e2', 'TopSecretSsePassword!', { submit: false });
  await new Promise((r) => setTimeout(r, 40));
  ac.abort();
  await pump;

  const fullStream = sseChunks.join('');
  assert.match(fullStream, /: connected/);
  assert.doesNotMatch(fullStream, /TopSecretSsePassword!/);
  assert.match(fullStream, /••••••/);

  // Max sessions (2) enforced with HTTP 429 (`default` is 1, `mcp-s` is 2, `overflow` is 3 -> 429)
  const created = await env.sdk.createSession({ id: 'mcp-s' });
  assert.equal(created.id, 'mcp-s');
  await assert.rejects(
    env.sdk.createSession({ id: 'overflow' }),
    (err) => err.status === 429 && /maximum concurrent sessions/.test(err.message),
  );

  // Spawn real `mcp.mjs` stdio bridge pointing to our live HTTP server
  const child = spawn(process.execPath, ['mcp.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      AGENT_BROWSER_URL: env.baseUrl,
      AGENT_BROWSER_TOKEN: 'test-secret-token',
      AGENT_BROWSER_SESSION: 'mcp-s',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out = [];
  child.stdout.on('data', (c) => out.push(c));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_open', arguments: { url: 'https://example.org/docs' } } }) + '\n');
  await new Promise((r) => setTimeout(r, 350));
  child.stdin.end(
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_read', arguments: { maxChars: 500 } } }) + '\n'
    + JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_screenshot', arguments: {} } }) + '\n',
  );
  const exitCode = await new Promise((r) => child.on('close', r));
  assert.equal(exitCode, 0);

  const byId = new Map(Buffer.concat(out).toString().trim().split('\n').map(JSON.parse).map((m) => [m.id, m]));
  assert.match(byId.get(1).result.content[0].text, /^\[url\] https:\/\/example\.org\/docs/);
  assert.match(byId.get(2).result.content[0].text, /coronavirus research/);
  assert.equal(byId.get(3).result.content[0].type, 'image');

  // Closing session frees capacity
  const closed = await env.sdk.closeSession('mcp-s');
  assert.equal(closed.ok, true);
});
