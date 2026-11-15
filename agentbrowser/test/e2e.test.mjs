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
    if (req.url === '/frame') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <button id="fb" onclick="this.textContent='Frame Clicked'">Confirm Inside Frame</button>
      </body></html>`);
      return;
    }
    if (req.url === '/popup') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Popup Doc</title></head><body><h1>Popup Opened</h1></body></html>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>Fixture App</title></head><body>
      <nav><a href="#top">Home</a></nav>
      <main>
        <h1>AgentBrowser E2E</h1>
        <label for="u">Username</label><input id="u" type="text" required />
        <label for="pw">Password</label><input id="pw" type="password" />
        <label for="lang">Language</label>
        <select id="lang"><option value="en">English</option><option value="bn">বাংলা</option></select>
        <a href="/popup" target="_blank">Open Popup</a>
        <div id="shadow-host"></div>
        <iframe src="/frame" width="320" height="80"></iframe>
        <p class="coronavirus-update">This paragraph contains important scientific results that must never be stripped by reader selectors.</p>
      </main>
      <script>
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
  assert.match(page.text, /button "Confirm Inside Frame" \[frame=f1\]/);

  // Type username + masked password, select Bangla option, click Shadow DOM & iframe buttons
  const refByName = (s, name) => s.boxes.find((b) => b.name === name)?.ref;
  page = await sdk.type(refByName(page, 'Username'), 'pranab');
  page = await sdk.type(refByName(page, 'Password'), 'SuperSecret123!');
  assert.doesNotMatch(JSON.stringify((await sdk.state()).log), /SuperSecret123!/);

  page = await sdk.select(refByName(page, 'Language'), 'বাংলা');
  assert.match(page.text, /value="বাংলা"/);

  page = await sdk.click(refByName(page, 'Toggle Shadow'));
  assert.match(page.text, /Shadow Toggled/);

  page = await sdk.click(refByName(page, 'Confirm Inside Frame'));
  assert.match(page.text, /Frame Clicked/);

  // Reader keeps `.coronavirus-update` prose intact
  const article = await sdk.read();
  assert.match(article.text, /important scientific results/);

  // Real JPEG screenshot
  const jpg = await sdk.screenshot();
  assert.equal(jpg[0], 0xff);
  assert.equal(jpg[1], 0xd8);

  // Popup capture opens second tab with its own title
  page = await sdk.click(refByName(page, 'Open Popup'));
  const tabs = await sdk.tabs('list');
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].title, 'Fixture App');
  assert.equal(tabs[1].title, 'Popup Doc');
});
