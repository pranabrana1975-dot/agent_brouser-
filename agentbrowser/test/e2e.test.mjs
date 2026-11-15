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
