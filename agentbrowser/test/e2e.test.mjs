import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright';
import { SessionManager } from '../lib/manager.mjs';
import { createControlServer } from '../server.mjs';
import { AgentBrowser } from '../sdk.mjs';

const execPath = (() => {
  try { return chromium.executablePath(); } catch { return ''; }
})();
const hasChromium = Boolean(execPath && fs.existsSync(execPath));
const requireE2e = process.env.AGENT_BROWSER_REQUIRE_E2E === '1';

test('Playwright Chromium E2E: snapshots, forms, shadow DOM, iframes, popups, reader, screenshots & multi-session', {
  skip: !hasChromium && !requireE2e ? 'Playwright Chromium binary not installed (run `npx playwright install chromium`)' : false,
}, async (t) => {
  assert.ok(hasChromium, `Expected Playwright Chromium executable at ${execPath}`);

  // Local fixture web server
  const fixture = http.createServer((req, res) => {
    if (req.url === '/api/profile') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ user: 'pranab', plan: 'pro' }));
      return;
    }
    if (req.url === '/frame') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <button id="fb" onclick="this.textContent='Frame Clicked'">Action Inside Frame</button>
      </body></html>`);
      return;
    }
    if (req.url === '/popup') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Popup Doc</title></head><body><h1>Popup Opened</h1></body></html>`);
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
    });
    res.end(`<!doctype html><html lang="en"><head>
      <title>Fixture App</title>
      <meta property="og:title" content="Fixture OG" />
    </head><body>
      <nav><a href="#top">Home</a></nav>
      <main>
        <h1>AgentBrowser E2E</h1>
        <label for="u">Username</label><input id="u" type="text" required />
        <label for="pw">Password</label><input id="pw" type="password" />
        <label for="lang">Language</label>
        <select id="lang"><option value="en">English</option><option value="bn">বাংলা</option></select>
        <button id="toast-btn" onclick="const d=document.createElement('div');d.setAttribute('role','alert');d.textContent='Profile synced!';document.body.appendChild(d);setTimeout(()=>d.remove(),50);">Trigger Toast</button>
        <a href="/popup" target="_blank">Open Popup</a>
        <div id="shadow-host"></div>
        <iframe src="/frame" width="320" height="80"></iframe>
        <table><thead><tr><th>Tool</th><th>Ready</th></tr></thead><tbody><tr><td>DevTools</td><td>Yes</td></tr></tbody></table>
        <p class="coronavirus-update">This paragraph contains important scientific results that must never be stripped by reader selectors.</p>
      </main>
      <script>
        localStorage.setItem('ui_mode', 'compact');
        localStorage.setItem('api_token', 'must-stay-redacted');
        console.warn('fixture boot warning');
        fetch('/api/profile', { headers: { Authorization: 'Bearer super-secret-header' } });
        const sr = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
        const b = document.createElement('button');
        b.textContent = 'Toggle Shadow';
        b.onclick = () => { b.textContent = 'Shadow Toggled'; };
        sr.appendChild(b);
      </script>
    </body></html>`);
  });

  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;

  const manager = new SessionManager({
    sessionDefaults: { minActionIntervalMs: 0, policy: { allowPrivateNetworks: false } },
  });
  const ctrl = createControlServer({ host: '127.0.0.1', token: 'e2e-token', manager });
  await new Promise((r) => ctrl.server.listen(0, '127.0.0.1', r));
  const sdk = new AgentBrowser(`http://127.0.0.1:${ctrl.server.address().port}`, { token: 'e2e-token' });

  t.after(async () => {
    await ctrl.close();
    await manager.shutdown();
    fixture.closeAllConnections?.();
    await new Promise((r) => fixture.close(r));
  });

  // Default policy blocks private/loopback URLs (SSRF protection)
  await assert.rejects(sdk.open(fixtureUrl), /private or loopback network blocked/);

  // Opt in to private network for local fixture testing
  await sdk.policy({ allowPrivateNetworks: true });
  let page = await sdk.open(fixtureUrl);
  assert.match(page.text, /textbox "Username" \[required\]/);
  assert.match(page.text, /combobox "Language"/);
  assert.match(page.text, /button "Toggle Shadow"/);
  assert.match(page.text, /button "Action Inside Frame" \[frame=f1\]/);

  // Type username + masked password, select Bangla option, click Shadow DOM & iframe buttons
  const refByName = (s, name) => s.boxes.find((b) => b.name === name)?.ref;
  page = await sdk.type(refByName(page, 'Username'), 'pranab');
  page = await sdk.type(refByName(page, 'Password'), 'SuperSecret123!');
  assert.doesNotMatch(JSON.stringify((await sdk.state()).log), /SuperSecret123!/);

  page = await sdk.select(refByName(page, 'Language'), 'বাংলা');
  assert.match(page.text, /value="বাংলা"/);

  page = await sdk.click(refByName(page, 'Toggle Shadow'));
  assert.match(page.text, /Shadow Toggled/);

  page = await sdk.click(refByName(page, 'Action Inside Frame'));
  assert.match(page.text, /Frame Clicked/);

  // Reader keeps `.coronavirus-update` prose intact
  const article = await sdk.read();
  assert.match(article.text, /important scientific results/);

  // Real screenshot (plain, annotated Set-of-Mark, and JPEG buffer forms)
  const shot = await sdk.screenshot({ annotate: true });
  assert.equal(shot.mimeType, 'image/png');
  assert.equal(shot.annotated, true);
  const jpg = await sdk.screenshot({ type: 'jpeg', encoding: 'buffer' });
  assert.equal(jpg[0], 0xff);
  assert.equal(jpg[1], 0xd8);

  // F12 DevTools E2E: Network JSON + redaction, Console, Inspect, A11y, Toast+Diff, Perf+CDP, Audit, Storage, Security, Emulate, Tables/Metadata, Trace
  await sdk.trace('start');
  const netList = await sdk.network({ resourceType: 'api' });
  assert.ok(netList.requests.length >= 1);
  const apiEntry = await sdk.network(netList.requests[0].id);
  assert.deepEqual(apiEntry.json, { user: 'pranab', plan: 'pro' });
  assert.equal(apiEntry.requestHeaders.authorization, '[REDACTED]');

  const cons = await sdk.console({ level: 'warning' });
  assert.ok(cons.entries.some((c) => c.text.includes('fixture boot warning')));

  const elem = await sdk.inspect('#u');
  assert.equal(elem.tag, 'input');
  assert.equal(elem.clickability.clickable, true);
  assert.ok(elem.boxModel.width > 0);

  const a11y = await sdk.a11y();
  assert.match(a11y.tree, /AgentBrowser E2E/);

  page = await sdk.click(refByName(page, 'Trigger Toast'));
  const diff = await sdk.diff({ clearToasts: true });
  assert.ok(diff.toasts.some((item) => item.text === 'Profile synced!'));

  const perf = await sdk.perf();
  assert.ok(perf.dom.elements > 5);
  assert.ok(perf.cdpMetrics && perf.cdpMetrics.nodes > 0);

  const audit = await sdk.audit();
  assert.ok(typeof audit.scores.overall === 'number');

  const storage = await sdk.storage();
  assert.equal(storage.localStorage.entries.find((e) => e.key === 'ui_mode')?.valuePreview, 'compact');
  assert.equal(storage.localStorage.entries.find((e) => e.key === 'api_token')?.valuePreview, '[REDACTED]');

  const sec = await sdk.security();
  assert.equal(sec.securityHeaders.present['x-content-type-options'], 'nosniff');

  const tables = await sdk.extract('tables');
  assert.deepEqual(tables.tables[0].rows, [{ Tool: 'DevTools', Ready: 'Yes' }]);
  const meta = await sdk.extract('metadata');
  assert.equal(meta.metadata.openGraph['og:title'], 'Fixture OG');

  const emu = await sdk.emulate({ device: 'iphone-15', colorScheme: 'dark' });
  assert.equal(emu.emulation.viewport.width, 393);
  const restored = await sdk.emulate({ device: 'desktop', colorScheme: 'light' });
  assert.equal(restored.emulation.viewport.width, 1280);
  page = restored.snapshot;

  const traceRes = await sdk.trace('stop');
  assert.ok(traceRes.bytes > 0);
  try { fs.unlinkSync(traceRes.path); } catch {}

  // Popup capture opens second tab with its own title
  page = await sdk.click(refByName(page, 'Open Popup'));
  const tabs = await sdk.tabs('list');
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].title, 'Fixture App');
  assert.equal(tabs[1].title, 'Popup Doc');
});

test('Playwright Chromium E2E v2.0: cross-origin iframe, drag/dblclick/rightclick, batch, workflow, PDF, visual diff, pagination, takeover & MCP', {
  skip: !hasChromium && !requireE2e ? 'Playwright Chromium binary not installed (run `npx playwright install chromium`)' : false,
}, async (t) => {
  assert.ok(hasChromium, `Expected Playwright Chromium executable at ${execPath}`);
  const os = await import('node:os');
  const path = await import('node:path');
  const fsp = await import('node:fs/promises');

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ab-e2e-v2-'));

  // Secondary origin server (different port => true browser cross-origin iframe!)
  const xOriginServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body style="margin:6px;font-family:sans-serif">
      <label for="otp">Widget Code</label>
      <input id="otp" type="text" />
      <button id="xbtn" type="button" onclick="this.textContent='Verified:'+document.getElementById('otp').value">Verify Code</button>
    </body></html>`);
  });
  await new Promise((r) => xOriginServer.listen(0, '127.0.0.1', r));
  const xPort = xOriginServer.address().port;

  // Primary fixture server: Kanban drag & drop, dblclick, rightclick, cross-origin iframe, CSV download, paginated catalog & modal self-heal
  const appServer = http.createServer((req, res) => {
    if (req.url === '/export.csv') {
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="metrics.csv"',
      });
      res.end('service,latency_ms,status\ncontrol-plane,12,ok\nsnapshot-engine,8,ok\n');
      return;
    }
    if (req.url === '/catalog?page=1' || req.url === '/catalog?page=2') {
      const pageNum = req.url.endsWith('2') ? 2 : 1;
      const items = pageNum === 1
        ? `<article class="item"><h3><a href="/p/1">Alpha Engine</a></h3><span class="price">$49</span><p>Fast headless automation runtime.</p></article>
           <article class="item"><h3><a href="/p/2">Beta Inspector</a></h3><span class="price">$29</span><p>Deep F12 diagnostics for agents.</p></article>`
        : `<article class="item"><h3><a href="/p/3">Gamma Replay</a></h3><span class="price">$39</span><p>Zero-token semantic workflow runner.</p></article>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Catalog ${pageNum}</title></head><body>
        <main><div class="grid">${items}</div>
        ${pageNum === 1 ? '<a rel="next" href="/catalog?page=2">Next</a>' : ''}
        </main></body></html>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><head><title>v2 Playground</title></head>
      <body style="font-family:sans-serif;margin:16px">
        <main>
          <h1 id="hdr">v2 Playground</h1>
          <label for="project">Project</label><input id="project" type="text" />
          <div style="display:flex;gap:24px;margin:12px 0">
            <div id="drag-card" draggable="true" role="button" tabindex="0"
              style="width:110px;height:44px;background:#2563eb;color:#fff;display:flex;align-items:center;justify-content:center">Card A</div>
            <div id="drop-zone" role="button" tabindex="0"
              style="width:150px;height:60px;border:2px dashed #64748b;display:flex;align-items:center;justify-content:center">Done Zone</div>
          </div>
          <button id="dbl" type="button" ondblclick="document.getElementById('out').textContent='Result verified: DBL_OK active'">Double Target</button>
          <button id="ctx" type="button" oncontextmenu="event.preventDefault();document.getElementById('out').textContent='Result verified: CTX_OK active'">Context Target</button>
          <button id="paint" type="button" onclick="document.getElementById('banner').style.background='#ef4444'">Change Color</button>
          <a id="dl-link" href="/export.csv" download="metrics.csv">Download CSV</a>
          <div id="banner" style="width:220px;height:50px;background:#0f172a;margin-top:10px"></div>
          <h2 id="out">READY</h2>
          <iframe src="http://127.0.0.1:${xPort}/widget" width="360" height="90"></iframe>
        </main>
        <script>
          const card = document.getElementById('drag-card');
          const zone = document.getElementById('drop-zone');
          card.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', 'Card A'));
          zone.addEventListener('dragover', e => e.preventDefault());
          zone.addEventListener('drop', e => { e.preventDefault(); zone.textContent = 'Dropped:' + e.dataTransfer.getData('text/plain'); });
        </script>
      </body></html>`);
  });
  await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
  const basePage = `http://127.0.0.1:${appServer.address().port}`;

  const token = 'e2e-v2-token';
  const manager = new SessionManager({
    workflowDir: path.join(tmp, 'workflows'),
    sessionOptions: {
      minActionIntervalMs: 0,
      downloadDir: path.join(tmp, 'downloads'),
      traceDir: path.join(tmp, 'traces'),
      workflowDir: path.join(tmp, 'workflows'),
      policy: { allowPrivateNetworks: true, approvalsEnabled: false },
    },
  });
  const ctl = createControlServer({ host: '127.0.0.1', token, manager });
  await new Promise((r) => ctl.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await ctl.close();
    await manager.shutdown();
    appServer.closeAllConnections?.();
    xOriginServer.closeAllConnections?.();
    await new Promise((r) => appServer.close(r));
    await new Promise((r) => xOriginServer.close(r));
    await fsp.rm(tmp, { recursive: true, force: true });
  });
  const apiBase = `http://127.0.0.1:${ctl.server.address().port}`;
  const sdk = new AgentBrowser(apiBase, { token });

  const refFor = (snap, pattern) => {
    const line = snap.text.split('\n').find((l) => pattern.test(l));
    assert.ok(line, `Could not find ${pattern} in:\n${snap.text}`);
    return line.match(/^(?:[+~]\s+)?\[?(e\d+)\]?\s/)[1];
  };

  // 1) Cross-origin iframe discovery + typing & clicking inside the second-origin iframe
  const snap = await sdk.open(basePage);
  assert.match(snap.text, /frame=f1:xorigin/);
  const afterIframeType = await sdk.type(refFor(snap, /textbox "Widget Code"/), '7788');
  const afterIframe = await sdk.click(refFor(afterIframeType, /button "Verify Code"/));
  assert.match(afterIframe.text, /button "Verified:7788".*frame=f1:xorigin/);

  // 2) Drag & Drop, Double-Click, Right-Click & Multi-Key Shortcuts
  const afterDrag = await sdk.drag(refFor(afterIframe, /"Card A"/), refFor(afterIframe, /"Done Zone"/));
  assert.match(afterDrag.text, /Dropped:Card A/);

  const afterDbl = await sdk.dblclick(refFor(afterDrag, /"Double Target"/));
  assert.match(afterDbl.text, /DBL_OK/);

  const afterCtx = await sdk.rightclick(refFor(afterDbl, /"Context Target"/));
  assert.match(afterCtx.text, /CTX_OK/);

  const afterTyped = await sdk.type(refFor(afterCtx, /textbox "Project"/), 'draft');
  const afterKeys = await sdk.press(['ControlOrMeta+a', 'Backspace'], refFor(afterTyped, /textbox "Project"/));
  assert.doesNotMatch(afterKeys.text, /value="draft"/);

  // 3) Visual Regression Baseline & Pixel Diff on real Chromium PNG screenshots
  await sdk.visualDiff('baseline', { name: 'playground' });
  const same = await sdk.visualDiff('compare', { name: 'playground', maxDiffPercent: 0.5 });
  assert.equal(same.passed, true);
  await sdk.click(refFor(afterKeys, /"Change Color"/));
  const changed = await sdk.visualDiff('compare', { name: 'playground', maxDiffPercent: 0.2 });
  assert.equal(changed.passed, false);
  assert.ok(changed.diffPixels > 500);
  assert.ok(changed.diffBase64.length > 100);

  // 4) Real Chromium PDF generation + real CSV file download & inspection
  const pdf = await sdk.pdf({ format: 'A4', save: true, filename: 'playground-doc' });
  assert.ok(pdf.bytes > 500);
  assert.ok(pdf.pageCount >= 1);
  assert.equal(pdf.sha256.length, 64);

  const cur = await sdk.snapshot();
  await sdk.click(refFor(cur, /"Download CSV"/));
  await sdk.wait({ ms: 250 });
  const dls = await sdk.downloads();
  const csvDl = dls.downloads.find((d) => d.filename === 'metrics.csv');
  assert.ok(csvDl, 'CSV download should be captured');
  const csvInspected = await sdk.inspectDownload(csvDl.id);
  assert.equal(csvInspected.kind, 'csv');
  assert.equal(csvInspected.totalRows, 2);
  assert.equal(csvInspected.rows[0].service, 'control-plane');

  // 5) Workflow Record, Replay with {{vars}}, Batch & Playwright Export + Delta Snapshot
  await sdk.startRecording('e2e-project');
  const sRec = await sdk.open(basePage);
  const bRes = await sdk.batch([
    { op: 'type', ref: refFor(sRec, /textbox "Project"/), text: '{{proj}}' },
    { op: 'dblclick', ref: refFor(sRec, /"Double Target"/) },
  ], { delta: true });
  assert.equal(bRes.ok, true);
  assert.equal(bRes.snapshot.delta, true);
  await sdk.stopRecording({ save: true });

  const rep = await sdk.replayWorkflow('e2e-project', { proj: 'Apollo-v2' });
  assert.equal(rep.ok, true);
  assert.match(rep.snapshot.text, /value="Apollo-v2"/);
  assert.match(rep.snapshot.text, /DBL_OK/);
  const spec = await sdk.exportPlaywright('e2e-project');
  assert.match(spec.code, /@playwright\/test/);

  // 6) Schema & Multi-Page Paginated Scraper on real Chromium
  await sdk.open(`${basePage}/catalog?page=1`);
  const scraped = await sdk.extract('schema', {
    maxPages: 3,
    schema: {
      container: 'article.item',
      fields: { title: 'h3 a', price: '.price', url: { selector: 'h3 a', attr: 'href', type: 'url' } },
    },
  });
  assert.equal(scraped.pagesVisited, 2);
  assert.equal(scraped.count, 3);
  assert.equal(scraped.items[2].title, 'Gamma Replay');

  // 7) Live Dashboard, Human Takeover, MCP Resources/Prompts & Prometheus Metrics
  const dash = await fetch(`${apiBase}/dashboard`);
  assert.equal(dash.status, 200);
  await sdk.pause(true);
  const tk = await sdk.takeover({ op: 'wheel', dy: 120 });
  assert.equal(tk.ok, true);
  await sdk.pause(false);

  const mcpRes = await sdk.request('/mcp', { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'browser://snapshot' } });
  assert.match(mcpRes.result.contents[0].text, /Gamma Replay/);
  const prom = await sdk.metrics('prometheus');
  assert.match(prom, /agentbrowser_workflow_replays_total 1/);
});
