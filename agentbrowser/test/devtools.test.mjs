import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
  TabDevTools,
  ContextNetworkControls,
  redactHeaders,
  redactPostData,
} from '../lib/devtools.mjs';
import {
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
} from '../lib/inspector.mjs';
import { extractPage } from '../lib/extract.mjs';
import { takeSnapshot } from '../lib/snapshot.mjs';
import { SessionManager } from '../lib/manager.mjs';
import { createControlServer } from '../server.mjs';
import { AgentBrowser } from '../sdk.mjs';
import { parseCliArgs } from '../cli.mjs';

function createJsdomPage(html, url = 'https://app.example.com/dashboard') {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'innerText')) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() { return this.textContent; },
    });
  }
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const w = Number(this.getAttribute('data-w') ?? 120);
    const h = Number(this.getAttribute('data-h') ?? 32);
    const x = Number(this.getAttribute('data-x') ?? 20);
    const y = Number(this.getAttribute('data-y') ?? 30);
    return { x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
  };

  const emitter = new EventEmitter();
  const page = {
    dom,
    window,
    on: (ev, fn) => emitter.on(ev, fn),
    emit: (ev, ...args) => emitter.emit(ev, ...args),
    mainFrame: () => page,
    url: () => window.location.href,
    title: async () => window.document.title,
    async evaluate(fn, arg) {
      window.__abArg = arg;
      const out = await window.eval(`(${fn.toString()})(window.__abArg)`);
      return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
    },
  };
  return page;
}

test('Network, WebSocket, HAR, Console, Dialogs, Redaction, Throttle, Blockers, Mocks & Trace', async (t) => {
  // Header & body secret redaction
  const cleanHdr = redactHeaders({
    Authorization: 'Bearer super-secret-jwt',
    Cookie: 'sid=secret-cookie',
    'Set-Cookie': 'sid=abc; HttpOnly',
    'X-Api-Key': 'key-123',
    'Content-Type': 'application/json',
  });
  assert.equal(cleanHdr.authorization, '[REDACTED]');
  assert.equal(cleanHdr.cookie, '[REDACTED]');
  assert.equal(cleanHdr['set-cookie'], '[REDACTED]');
  assert.equal(cleanHdr['x-api-key'], '[REDACTED]');
  assert.equal(cleanHdr['content-type'], 'application/json');
  assert.match(redactPostData('{"email":"a@b.com","password":"my-password","apiToken":"xyz"}'), /"password":"\[REDACTED\]"/);
  assert.doesNotMatch(redactPostData('user=pranab&password=secret123'), /secret123/);

  const page = createJsdomPage('<html lang="en"><head><title>App</title></head><body><h1>Dashboard</h1></body></html>');
  let seq = 1;
  const dt = new TabDevTools(page, { getActionSeq: () => seq });

  // 1) Main document HTTPS response with TLS certificate details
  const docReq = {
    url: () => 'https://app.example.com/dashboard',
    method: () => 'GET',
    resourceType: () => 'document',
    isNavigationRequest: () => true,
    frame: () => page,
    headers: () => ({ cookie: 'sid=secret' }),
    postData: () => null,
  };
  page.emit('request', docReq);
  await dt._onResponse({
    request: () => docReq,
    status: () => 200,
    statusText: () => 'OK',
    headers: () => ({
      'content-type': 'text/html; charset=utf-8',
      'strict-transport-security': 'max-age=31536000',
      'x-content-type-options': 'nosniff',
      'set-cookie': 'sid=secret; Secure; HttpOnly',
    }),
    securityDetails: async () => ({
      protocol: 'TLS 1.3',
      issuer: "Let's Encrypt",
      subjectName: 'app.example.com',
      validFrom: 1760000000,
      validTo: 1800000000,
    }),
    text: async () => '<html><body>Dashboard</body></html>',
  });

  // 2) Failed 422 API POST with JSON error body & secret token in query/headers
  seq = 2;
  const apiReq = {
    url: () => 'https://app.example.com/api/save?page=1&access_token=topsecret',
    method: () => 'POST',
    resourceType: () => 'fetch',
    isNavigationRequest: () => false,
    frame: () => page,
    headers: () => ({ authorization: 'Bearer hidden', 'content-type': 'application/json' }),
    postData: () => JSON.stringify({ email: 'bad', password: 'raw-password' }),
  };
  page.emit('request', apiReq);
  await dt._onResponse({
    request: () => apiReq,
    status: () => 422,
    statusText: () => 'Unprocessable Entity',
    headers: () => ({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ error: 'invalid email address' }),
  });

  // 3) Third-party tracker & mixed HTTP subresource
  const thirdReq = {
    url: () => 'http://cdn.tracker.net/pixel.js',
    method: () => 'GET',
    resourceType: () => 'script',
    isNavigationRequest: () => false,
    frame: () => page,
    headers: () => ({}),
    postData: () => null,
    failure: () => ({ errorText: 'net::ERR_BLOCKED_BY_CLIENT' }),
  };
  page.emit('request', thirdReq);
  page.emit('requestfailed', thirdReq);

  const apiOnly = dt.listNetwork({ resourceType: 'api', status: '4xx', sinceActionSeq: 2 });
  assert.equal(apiOnly.requests.length, 1);
  assert.equal(apiOnly.requests[0].id, 'r2');

  const detail = dt.getNetworkEntry('r2');
  assert.equal(detail.status, 422);
  assert.deepEqual(detail.json, { error: 'invalid email address' });
  assert.equal(detail.requestHeaders.authorization, '[REDACTED]');
  assert.equal(detail.query.access_token, '[REDACTED]');
  assert.equal(detail.query.page, '1');
  assert.doesNotMatch(detail.postData, /raw-password/);

  const har = dt.exportHar();
  assert.equal(har.log.version, '1.2');
  assert.equal(har.log.entries.length, 3);
  assert.doesNotMatch(JSON.stringify(har), /super-secret|topsecret|raw-password|sid=secret/);

  // WebSocket inspector
  const ws = new EventEmitter();
  ws.url = () => 'wss://app.example.com/realtime';
  page.emit('websocket', ws);
  ws.emit('framesent', { payload: '{"op":"subscribe","channel":"prices"}' });
  ws.emit('framereceived', { payload: '{"price":42150}' });
  ws.emit('close');
  const wsReport = dt.listWebSockets();
  assert.equal(wsReport.connections.length, 1);
  assert.equal(wsReport.connections[0].sentFrames, 1);
  assert.equal(wsReport.connections[0].receivedFrames, 1);
  assert.equal(wsReport.frames.length, 2);

  // Console & uncaught exception capture + auto snapshot badge
  page.emit('console', { type: () => 'warn', text: () => 'Deprecated API usage', location: () => ({ url: 'https://app.example.com/app.js', lineNumber: 12, columnNumber: 4 }) });
  page.emit('console', { type: () => 'error', text: () => 'Failed to save record', location: () => ({ url: 'https://app.example.com/app.js', lineNumber: 88, columnNumber: 2 }) });
  const boom = new Error('Cannot read properties of null');
  page.emit('pageerror', boom);

  const errLogs = dt.listConsole({ level: 'error' });
  assert.equal(errLogs.entries.length, 2); // console.error + pageerror
  assert.equal(errLogs.warnings, 1);

  const badge = dt.badgeSummary({ toastCount: 1 });
  assert.match(badge, /console: 2 errors, 1 warn/);
  assert.match(badge, /network: 2 failed/);
  assert.match(badge, /toasts: 1/);

  // Snapshot includes `[devtools]` line when anomalies exist, omits when clean!
  const snapWithBadge = await takeSnapshot(page, { devtoolsBadge: badge });
  assert.match(snapWithBadge.text, /\[devtools\] console: 2 errors, 1 warn/);
  const cleanSnap = await takeSnapshot(page, { devtoolsBadge: '' });
  assert.doesNotMatch(cleanSnap.text, /\[devtools\]/);

  // Security & third-party report
  const mockCtx = {
    cookies: async () => [
      { name: 'session_id', value: 'ultra-secret-cookie', domain: 'app.example.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax', expires: -1 },
    ],
    clearCookies: async () => {},
    setOffline: async () => {},
    newCDPSession: async () => ({
      send: async (method) => (method === 'Performance.getMetrics'
        ? { metrics: [{ name: 'Nodes', value: 42 }, { name: 'JSHeapUsedSize', value: 4_194_304 }, { name: 'LayoutCount', value: 3 }] }
        : {}),
      detach: async () => {},
    }),
    tracing: {
      start: async () => {},
      stop: async ({ path: outPath }) => { await fs.writeFile(outPath, 'PK-fake-trace'); },
    },
  };

  const sec = await inspectSecurity(page, mockCtx, dt);
  assert.equal(sec.isHttps, true);
  assert.equal(sec.tls.protocol, 'TLS 1.3');
  assert.ok(sec.securityHeaders.present['strict-transport-security']);
  assert.ok(sec.securityHeaders.missing.some((m) => m.header === 'Content-Security-Policy'));
  assert.equal(sec.mixedContent.length, 1);
  assert.equal(sec.thirdParty.domains[0].domain, 'cdn.tracker.net');
  assert.equal(sec.cookies.flagged.length, 1); // session_id missing HttpOnly

  // Throttle, tracker blocker, route mock, and trace recording
  const applied = await dt.applyNetworkThrottle(mockCtx, 'slow-3g');
  assert.equal(applied.latencyMs, 400);

  const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-trace-'));
  t.after(() => fs.rm(traceDir, { recursive: true, force: true }));
  const ctrl = new ContextNetworkControls({ traceDir });
  ctrl.setBlocked({ blockTrackers: true, patterns: ['*.ads.example.com'] });
  assert.ok(ctrl.shouldBlock('https://www.google-analytics.com/g/collect'));
  assert.ok(ctrl.shouldBlock('https://banner.ads.example.com/ad.js'));
  assert.equal(ctrl.shouldBlock('https://app.example.com/main.js'), null);

  const m = ctrl.addMock({ urlPattern: '*/api/save*', method: 'POST', status: 200, body: '{"ok":true}' });
  assert.equal(ctrl.findMock('https://app.example.com/api/save?x=1', 'POST').status, 200);
  assert.equal(ctrl.clearMocks(m.id).removed, 1);

  await ctrl.startTrace(mockCtx, { screenshots: true, snapshots: true });
  assert.equal(ctrl.traceStatus().active, true);
  const traceOut = await ctrl.stopTrace(mockCtx, 'dev-1');
  assert.ok(traceOut.path.startsWith(traceDir));
  assert.ok(traceOut.bytes > 0);

  // Dialog controller: accept prompt once, then revert to auto-dismiss
  dt.dialogRule = { mode: 'accept', promptText: 'MyFolder', once: true };
  let acceptedWith = null;
  await dt._onDialog({
    type: () => 'prompt',
    message: () => 'Folder name?',
    defaultValue: () => 'Untitled',
    accept: async (v) => { acceptedWith = v; },
    dismiss: async () => {},
  });
  assert.equal(acceptedWith, 'MyFolder');
  assert.equal(dt.dialogRule.mode, 'dismiss'); // reverted after `once`
  assert.equal(dt.dialogs[0].action, 'accepted');
});

test('Inspector, Occlusion Doctor, ARIA Tree, Diff, Perf, Audit, Storage, Overlay & Structured Extract', async () => {
  const html = `<!doctype html><html><head>
    <title>Shop</title>
    <meta property="og:title" content="AgentBrowser Store" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="alternate" type="application/rss+xml" title="Blog RSS" href="/feed.xml" />
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget"}</script>
  </head><body>
    <main>
      <img src="/broken.png" />
      <input id="dup" type="text" />
      <input id="dup" type="password" value="my-secret-pw" aria-label="Secret Password" />
      <button></button>
      <button id="pay-btn" class="btn primary" data-agent-ref="e5" data-x="40" data-y="60" data-w="140" data-h="40" style="padding:8px 16px; color:rgb(255, 255, 255);">Pay Now</button>
      <div id="cookie-modal" role="dialog" style="position:fixed; z-index:9999;">Accept cookies first</div>
      <table>
        <caption>Quarterly Revenue</caption>
        <thead><tr><th>Quarter</th><th>Revenue</th></tr></thead>
        <tbody><tr><td>Q1</td><td>$12M</td></tr><tr><td>Q2</td><td>$15M</td></tr></tbody>
      </table>
    </main>
  </body></html>`;

  const page = createJsdomPage(html, 'http://shop.example.com/checkout');
  // Simulate cookie modal covering the center point of #pay-btn
  page.window.document.elementFromPoint = () => page.window.document.getElementById('cookie-modal');
  page.window.localStorage.setItem('theme', 'dark');
  page.window.localStorage.setItem('auth_token', 'jwt-should-be-redacted');
  page.window.sessionStorage.setItem('cart_count', '3');

  // 1) Element inspect + occlusion diagnosis + password value redaction
  const info = await inspectElement(page, { ref: 'e5' });
  assert.equal(info.tag, 'button');
  assert.equal(info.id, 'pay-btn');
  assert.equal(info.boxModel.width, 140);
  assert.equal(info.boxModel.padding.left, 16);
  assert.equal(info.clickability.clickable, false);
  assert.equal(info.clickability.occludedBy.id, 'cookie-modal');
  assert.match(info.clickability.reasons[0], /occluded/);

  const pwdInfo = await inspectElement(page, { selector: 'input[type="password"]' });
  assert.equal(pwdInfo.value, '[REDACTED]');
  assert.equal(pwdInfo.attributes.value, '[REDACTED]');
  assert.doesNotMatch(pwdInfo.htmlSnippet, /my-secret-pw/);

  // 2) Full ARIA accessibility tree
  const a11y = await captureA11yTree(page);
  assert.match(a11y.tree, /- main/);
  assert.match(a11y.tree, /- button "Pay Now" \[ref=e5\]/);
  assert.match(a11y.tree, /- dialog/);

  // 3) Snapshot/DOM diff + ephemeral toast summary
  const diff = diffSnapshots(
    {
      meta: { url: 'https://a.example/', title: 'Step 1' },
      boxes: [
        { ref: 'e1', role: 'checkbox', name: 'Terms', checked: false },
        { ref: 'e2', role: 'button', name: 'Accept cookies' },
      ],
      textBits: ['Old paragraph'],
    },
    {
      meta: { url: 'https://a.example/', title: 'Step 2' },
      boxes: [
        { ref: 'e3', role: 'checkbox', name: 'Terms', checked: true },
        { ref: 'e4', role: 'button', name: 'Continue' },
      ],
      textBits: ['New confirmation paragraph'],
    },
    [{ role: 'alert', text: 'Saved successfully!', at: Date.now() }],
  );
  assert.equal(diff.changed, true);
  assert.equal(diff.modified.length, 1);
  assert.equal(diff.added[0].name, 'Continue');
  assert.equal(diff.removed[0].name, 'Accept cookies');
  assert.match(diff.summary, /toast\[alert\] "Saved successfully!"/);
  assert.match(diff.summary, /unchecked → checked/);

  // 4) Performance + CDP metrics
  const perf = await collectPerformance(page, {
    cdp: {
      send: async (m) => (m === 'Performance.getMetrics'
        ? { metrics: [{ name: 'Nodes', value: 88 }, { name: 'JSHeapUsedSize', value: 8_000_000 }] }
        : {}),
    },
  });
  assert.ok(perf.dom.elements > 5);
  assert.equal(perf.cdpMetrics.nodes, 88);
  assert.equal(perf.memory.jsHeapUsedBytes, 8_000_000);

  // 5) Mini-Lighthouse audit catches a11y, SEO, and HTTP-password security issues
  const audit = await runPageAudit(page);
  const codes = new Set(audit.issues.map((i) => i.code));
  assert.ok(codes.has('missing-html-lang'));
  assert.ok(codes.has('img-missing-alt'));
  assert.ok(codes.has('input-missing-label'));
  assert.ok(codes.has('empty-control'));
  assert.ok(codes.has('duplicate-id'));
  assert.ok(codes.has('missing-meta-description'));
  assert.ok(codes.has('missing-h1'));
  assert.ok(codes.has('password-over-http'));
  assert.ok(audit.scores.overall < 80);

  // 6) Application storage inspector (redacts secrets) + selective clear
  const fakeCtx = {
    cookies: async () => [{ name: 'sid', value: 'raw-cookie', domain: 'shop.example.com', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }],
    clearCookies: async () => {},
  };
  const storage = await inspectStorage(page, fakeCtx);
  assert.equal(storage.cookies.entries[0].value, '[REDACTED]');
  const authEntry = storage.localStorage.entries.find((e) => e.key === 'auth_token');
  const themeEntry = storage.localStorage.entries.find((e) => e.key === 'theme');
  assert.equal(authEntry.valuePreview, '[REDACTED]');
  assert.equal(themeEntry.valuePreview, 'dark');
  assert.equal(storage.sessionStorage.count, 1);

  const cleared = await clearStorage(page, fakeCtx, ['localStorage']);
  assert.deepEqual(cleared.cleared, ['localStorage']);
  assert.equal(page.window.localStorage.length, 0);
  assert.equal(page.window.sessionStorage.length, 1); // untouched!

  // 7) Safe expression evaluator
  const ev = await evaluateExpression(page, '1 + 41');
  assert.equal(ev.value, 42);

  // 8) Set-of-Mark overlay injects during capture and removes itself cleanly afterwards
  let overlayDuringShot = false;
  await withAnnotatedOverlay(page, [{ ref: 'e5', role: 'button', x: 40, y: 60, w: 140, h: 40, v: true }], async () => {
    overlayDuringShot = Boolean(page.window.document.getElementById('__agentbrowser_som__'));
  });
  assert.equal(overlayDuringShot, true);
  assert.equal(page.window.document.getElementById('__agentbrowser_som__'), null);

  // 9) Structured extraction: HTML tables -> JSON & metadata (OG, Twitter, JSON-LD, feeds)
  const tables = await extractPage(page, 'tables');
  assert.equal(tables.tables.length, 1);
  assert.equal(tables.tables[0].caption, 'Quarterly Revenue');
  assert.deepEqual(tables.tables[0].rows, [
    { Quarter: 'Q1', Revenue: '$12M' },
    { Quarter: 'Q2', Revenue: '$15M' },
  ]);

  const meta = await extractPage(page, 'metadata');
  assert.equal(meta.metadata.openGraph['og:title'], 'AgentBrowser Store');
  assert.equal(meta.metadata.twitter['twitter:card'], 'summary_large_image');
  assert.equal(meta.metadata.jsonLd[0].name, 'Widget');
  assert.equal(meta.metadata.feeds[0].url, 'http://shop.example.com/feed.xml');

  // 10) CLI argument parsing for new DevTools dumps & `inspect` subcommand
  assert.equal(parseCliArgs(['fetch', 'https://example.com', '--dump', 'audit', '--device', 'iphone-15']).dump, 'audit');
  assert.equal(parseCliArgs(['inspect', 'https://example.com', '--selector', '#pay-btn', '--allow-private']).selector, '#pay-btn');
});

test('HTTP, SDK & MCP wire all DevTools tools and keep browser_evaluate disabled by default', async (t) => {
  const domPage = createJsdomPage(
    '<html lang="en"><head><title>Live DevTools</title><meta name="description" content="Demo description"><meta name="viewport" content="width=device-width"></head><body><main><h1>Welcome</h1><button id="go">Launch</button></main></body></html>',
    'https://live.example.com/',
  );
  let viewport = { width: 1280, height: 800 };
  let mediaState = {};
  let geoState = null;

  const browserLauncher = async () => ({
    version: () => '136.0.7103.48',
    isConnected: () => true,
    on: () => {},
    close: async () => {},
    newContext: async () => ({
      on: () => {},
      route: async () => {},
      addInitScript: async () => {},
      cookies: async () => [],
      clearCookies: async () => {},
      setOffline: async () => {},
      grantPermissions: async () => {},
      setGeolocation: async (g) => { geoState = g; },
      close: async () => {},
      newPage: async () => ({
        ...domPage,
        goto: async () => {
          domPage.emit('console', { type: () => 'error', text: () => 'API connection refused', location: () => ({ url: 'https://live.example.com/app.js', lineNumber: 7 }) });
        },
        waitForLoadState: async () => {},
        setViewportSize: async (v) => { viewport = v; },
        emulateMedia: async (m) => { mediaState = { ...mediaState, ...m }; },
        screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        close: async () => {},
      }),
    }),
  });

  const manager = new SessionManager({
    browserLauncher,
    sweepIntervalMs: 0,
    sessionDefaults: { minActionIntervalMs: 0, allowEval: false },
  });
  const ctrl = createControlServer({ host: '127.0.0.1', token: 'dt-tok', manager });
  await new Promise((r) => ctrl.server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${ctrl.server.address().port}`;
  const sdk = new AgentBrowser(baseUrl, { token: 'dt-tok' });
  t.after(async () => { await ctrl.close(); await manager.shutdown(); });

  const opened = await sdk.open('https://live.example.com/');
  // Snapshot auto-includes `[devtools]` badge because console.error fired!
  assert.match(opened.text, /\[devtools\] console: 1 error/);

  // Console, DevTools overview, Inspect, A11y, Audit, Emulate, Annotated screenshot, & Gated Eval
  const logs = await sdk.console({ level: 'error' });
  assert.equal(logs.entries.length, 1);
  assert.match(logs.entries[0].text, /API connection refused/);

  const overview = await sdk.devtools();
  assert.equal(overview.console.errors, 1);
  assert.equal(overview.allowEval, false);

  const btnRef = opened.boxes.find((b) => b.name === 'Launch').ref;
  const inspected = await sdk.inspect(btnRef);
  assert.equal(inspected.id, 'go');

  const emu = await sdk.emulate({
    device: 'iphone-15',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    geolocation: { latitude: 22.5726, longitude: 88.3639 },
  });
  assert.equal(emu.emulation.device, 'iphone-15');
  assert.deepEqual(viewport, { width: 393, height: 852 });
  assert.equal(mediaState.colorScheme, 'dark');
  assert.equal(geoState.latitude, 22.5726);

  const annotated = await sdk.screenshot({ annotate: true });
  assert.equal(annotated.annotated, true);

  // browser_evaluate is blocked by default!
  await assert.rejects(sdk.evaluate('document.title'), /AGENT_BROWSER_ALLOW_EVAL=1/);

  // MCP Streamable HTTP exposes & validates nested schemas on DevTools tools
  const mcpRes = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { authorization: 'Bearer dt-tok', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_audit', arguments: {} } }),
  }).then((r) => r.json());
  const mcpAudit = JSON.parse(mcpRes.result.content[0].text);
  assert.ok(typeof mcpAudit.scores.overall === 'number');

  // REST read-only DevTools endpoints + annotated /api/shot.jpg?annotate=1
  const authHdr = { authorization: 'Bearer dt-tok' };
  const restNet = await fetch(`${baseUrl}/api/network?limit=10`, { headers: authHdr }).then((r) => r.json());
  assert.equal(restNet.ok, true);
  const restCons = await fetch(`${baseUrl}/api/console?level=error`, { headers: authHdr }).then((r) => r.json());
  assert.equal(restCons.entries.length, 1);
  const restPerf = await fetch(`${baseUrl}/api/perf`, { headers: authHdr }).then((r) => r.json());
  assert.equal(restPerf.ok, true);
  const restSec = await fetch(`${baseUrl}/api/security`, { headers: authHdr }).then((r) => r.json());
  assert.equal(restSec.ok, true);
  const shotResp = await fetch(`${baseUrl}/api/shot.jpg?annotate=1`, { headers: authHdr });
  assert.equal(shotResp.status, 200);

  // When explicitly enabled (allowEval: true), browser_evaluate requires human approval first
  const evalManager = new SessionManager({
    browserLauncher,
    sweepIntervalMs: 0,
    sessionDefaults: { minActionIntervalMs: 0, allowEval: true, policy: { approvalTimeoutMs: 5000 } },
  });
  const evalCtrl = createControlServer({ host: '127.0.0.1', token: 'ev-tok', manager: evalManager });
  await new Promise((r) => evalCtrl.server.listen(0, '127.0.0.1', r));
  const evalSdk = new AgentBrowser(`http://127.0.0.1:${evalCtrl.server.address().port}`, { token: 'ev-tok' });
  t.after(async () => { await evalCtrl.close(); await evalManager.shutdown(); });

  await evalSdk.open('https://live.example.com/');
  const evalPromise = evalSdk.evaluate('document.title');
  // Poll until approval appears, then approve it
  let approvalId = null;
  for (let i = 0; i < 40; i++) {
    const st = await evalSdk.state();
    if (st.pending.length) { approvalId = st.pending[0].id; break; }
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.ok(approvalId, 'browser_evaluate must pause for human approval');
  await evalSdk.approve(approvalId, true);
  const evalOut = await evalPromise;
  assert.equal(evalOut.value, 'Live DevTools');
});
