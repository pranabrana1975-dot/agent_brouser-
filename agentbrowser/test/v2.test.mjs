// v2.test.mjs — Comprehensive unit, security & full-stack integration suite for AgentBrowser v2.0:
//  #2 Live Supervisor Dashboard (/dashboard) & Human Takeover (/api/takeover)
//  #3 Batch Actions (browser_batch) + Workflow Recorder, Replay & Playwright Codegen (browser_workflow)
//  #4 Advanced Interaction (drag, dblclick, rightclick, multi-key, clipboard), Cross-Origin Iframe, PDF, Downloads & Visual Diff
//  #5 Autonomous Browser Agent v2 (Observe-Plan-Act-Verify + self-heal) & Schema/Paginated Scraper
//  #6 Full MCP Spec Support (37 tools, Delta snapshots, resources/*, prompts/*)
//  #7 TypeScript types (sdk.d.ts/tools.d.ts), Dockerfile/Compose invariants, Prometheus /metrics & per-session Proxy

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import {
  encodePng,
  decodePng,
  comparePngBuffers,
  generatePagePdf,
  inspectDownloadArtifact,
} from '../lib/visual.mjs';
import {
  WorkflowStore,
  WorkflowRecorder,
  exportPlaywrightSpec,
  interpolateTemplate,
  extractTemplateVariables,
} from '../lib/workflow.mjs';
import { MetricsRegistry, normalizeProxyConfig, redactProxy } from '../lib/metrics.mjs';
import { takeSnapshot, renderDeltaSnapshot, toWireSnapshot } from '../lib/snapshot.mjs';
import { extractPage, paginateExtract, normalizeExtractSchema } from '../lib/extract.mjs';
import { runTask } from '../lib/agent.mjs';
import { SessionManager } from '../lib/manager.mjs';
import { createControlServer } from '../server.mjs';
import { AgentBrowser } from '../sdk.mjs';
import { tools } from '../tools.mjs';
import { parseCliArgs } from '../cli.mjs';
import { renderDashboardHtml, DASHBOARD_CSP } from '../lib/dashboard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AB_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(AB_DIR, '..');

function makeSolidPng(w, h, [r, g, b, a = 255], patch = null) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const inPatch = patch && x >= patch.x && x < patch.x + patch.w && y >= patch.y && y < patch.y + patch.h;
      const c = inPatch ? patch.color : [r, g, b, a];
      rgba[idx] = c[0];
      rgba[idx + 1] = c[1];
      rgba[idx + 2] = c[2];
      rgba[idx + 3] = c[3] ?? 255;
    }
  }
  return encodePng(w, h, rgba);
}

// Helper: build a PNG using any PNG filter type (0=None, 1=Sub, 2=Up, 3=Average, 4=Paeth) to exercise decoder filters.
function encodeFilteredPng(width, height, rgba, filterType) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
  };
  for (let y = 0; y < height; y++) {
    const rowOut = y * (stride + 1);
    raw[rowOut] = filterType;
    for (let x = 0; x < stride; x++) {
      const cur = rgba[y * stride + x];
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0;
      const up = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const upLeft = (x >= 4 && y > 0) ? rgba[(y - 1) * stride + x - 4] : 0;
      let val = cur;
      if (filterType === 1) val = (cur - left) & 0xff;
      else if (filterType === 2) val = (cur - up) & 0xff;
      else if (filterType === 3) val = (cur - ((left + up) >> 1)) & 0xff;
      else if (filterType === 4) val = (cur - paeth(left, up, upLeft)) & 0xff;
      raw[rowOut + 1 + x] = val;
    }
  }
  // Reuse encodePng's valid PNG wrapper by replacing IDAT payload cleanly.
  const base = encodePng(width, height, rgba);
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  const iend = base.subarray(base.length - 12);
  const compressed = zlib.deflateSync(raw);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(compressed.length, 0);
  const type = Buffer.from('IDAT', 'ascii');
  // Compute CRC32 matching PNG spec
  let crc = 0xffffffff;
  for (const part of [type, compressed]) {
    for (let i = 0; i < part.length; i++) {
      let c = (crc ^ part[i]) & 0xff;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crc = (crc >>> 8) ^ c;
    }
  }
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([base.subarray(0, ihdrEnd), len, type, compressed, crcBuf, iend]);
}

function createRichMockBrowser(routes = {}) {
  const createdContexts = [];

  function mountDom(state, url) {
    const html = routes[url] || `<!doctype html><html lang="en"><head><title>App</title></head><body>
      <main>
        <h1>Workspace</h1>
        <label for="name">Full Name</label><input id="name" name="name" type="text" data-x="20" data-y="40" data-w="180" data-h="30" />
        <label for="secret">API Secret</label><input id="secret" name="secret" type="password" data-x="20" data-y="80" data-w="180" data-h="30" />
        <label for="role">Role</label><select id="role" name="role" data-x="20" data-y="120" data-w="140" data-h="30">
          <option value="dev">Developer</option><option value="qa">QA Lead</option>
        </select>
        <div id="card" role="button" tabindex="0" data-x="40" data-y="180" data-w="80" data-h="40">Task Card</div>
        <div id="done-col" role="button" tabindex="0" data-x="260" data-y="180" data-w="120" data-h="80">Done Column</div>
        <button id="save-btn" type="button" data-x="20" data-y="280" data-w="120" data-h="34">Apply Filter</button>
        <p id="status">Idle</p>
      </main>
    </body></html>`;
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
      const h = Number(this.getAttribute('data-h') ?? 30);
      const x = Number(this.getAttribute('data-x') ?? 20);
      const y = Number(this.getAttribute('data-y') ?? 20);
      return { x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
    };
    window.navigator.clipboard = {
      writeText: async (t) => { state.clipboard = String(t); },
      readText: async () => state.clipboard,
    };
    state.dom = dom;
    state.window = window;
    state.url = url;
  }

  function makeLocator(getDoc, selector, events) {
    const find = () => getDoc().querySelector(selector);
    const loc = {
      first: () => loc,
      scrollIntoViewIfNeeded: async () => {},
      boundingBox: async () => {
        const el = find();
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      },
      click: async (opts = {}) => {
        const el = find();
        if (!el) throw new Error(`Element not found: ${selector}`);
        if (el.getAttribute('data-occluded') === '1') {
          throw new Error('locator.click: <div class="cookie-backdrop"> intercepts pointer events');
        }
        events.push({ kind: 'click', selector, id: el.id, button: opts.button || 'left', modifiers: opts.modifiers || [] });
        if (el.getAttribute('data-dismiss-occlusion') === '1') {
          for (const occ of getDoc().querySelectorAll('[data-occluded="1"]')) occ.removeAttribute('data-occluded');
          el.remove();
          return;
        }
        if (el.getAttribute('data-goto')) {
          events.onGoto?.(el.getAttribute('data-goto'));
          return;
        }
        const status = getDoc().querySelector('#status');
        if (status) status.textContent = `Action confirmed: clicked ${el.id || el.textContent.trim()} (${opts.button || 'left'}) and applied live state`;
        if (el.id === 'xframe-btn') el.textContent = 'XFrame Activated';
      },
      dblclick: async (opts = {}) => {
        const el = find();
        if (!el) throw new Error(`Element not found: ${selector}`);
        events.push({ kind: 'dblclick', selector, id: el.id, button: opts.button || 'left', modifiers: opts.modifiers || [] });
        const status = getDoc().querySelector('#status');
        if (status) status.textContent = `DoubleClicked ${el.id}`;
      },
      dragTo: async (targetLoc, opts = {}) => {
        const src = find();
        events.push({ kind: 'dragTo', selector, srcId: src?.id, steps: opts.steps });
        const status = getDoc().querySelector('#status');
        if (status) status.textContent = `Dragged ${src?.id} to target`;
      },
      fill: async (val) => {
        const el = find();
        if (!el) throw new Error(`Element not found: ${selector}`);
        el.value = String(val);
        events.push({ kind: 'fill', selector, id: el.id, value: String(val) });
      },
      type: async (val) => {
        const el = find();
        if (!el) throw new Error(`Element not found: ${selector}`);
        el.value = (el.value || '') + String(val);
        events.push({ kind: 'type', selector, id: el.id, value: String(val) });
      },
      press: async (key) => {
        events.push({ kind: 'press', selector, key });
      },
      selectOption: async (value) => {
        const el = find();
        if (!el) throw new Error(`Element not found: ${selector}`);
        const v = typeof value === 'string' ? value : value?.label;
        for (const o of el.options || []) {
          o.selected = (o.value === v || o.textContent.trim() === v);
        }
        el.value = v;
        events.push({ kind: 'select', selector, id: el.id, value: v });
      },
      hover: async () => { events.push({ kind: 'hover', selector }); },
      screenshot: async () => makeSolidPng(32, 24, [30, 80, 160, 255], events.visualPatch),
      waitFor: async () => { if (!find()) throw new Error(`timeout waiting for ${selector}`); },
      evaluate: async (fn, arg) => {
        const el = find();
        if (!el) throw new Error(`Element not found: ${selector}`);
        return fn(el, arg);
      },
    };
    return loc;
  }

  function makePage() {
    const em = new EventEmitter();
    const state = {
      url: 'about:blank',
      history: ['about:blank'],
      histIdx: 0,
      clipboard: '',
      events: [],
      childFrames: [],
      visualPatch: null,
      viewport: { width: 1280, height: 800 },
    };
    state.events.onGoto = (nextUrl) => {
      const resolved = new URL(nextUrl, state.url).href;
      state.history.push(resolved);
      state.histIdx = state.history.length - 1;
      mountDom(state, resolved);
    };
    mountDom(state, 'https://app.example.com/start');
    state.url = 'about:blank';

    // Optional cross-origin child frame attached whenever page has <iframe data-xorigin>
    const buildFrames = () => {
      const frames = [page];
      const iframes = state.window?.document?.querySelectorAll?.('iframe[data-xorigin]') || [];
      iframes.forEach((ifr, idx) => {
        Object.defineProperty(ifr, 'contentDocument', { configurable: true, get() { throw new Error('SecurityError: cross-origin'); } });
        const furl = ifr.getAttribute('src') || `https://embed-${idx}.other.example/widget`;
        if (!state.childFrames[idx] || state.childFrames[idx]._url !== furl) {
          const fdom = new JSDOM(
            `<!doctype html><html><body>
              <label for="xframe-in">Card Code</label>
              <input id="xframe-in" type="text" data-x="10" data-y="10" data-w="120" data-h="24" />
              <button id="xframe-btn" type="button" data-x="10" data-y="44" data-w="110" data-h="28">Verify Widget</button>
            </body></html>`,
            { url: furl, pretendToBeVisual: true, runScripts: 'outside-only' },
          );
          fdom.window.HTMLElement.prototype.getBoundingClientRect = function () {
            const w = Number(this.getAttribute('data-w') ?? 100);
            const h = Number(this.getAttribute('data-h') ?? 24);
            const x = Number(this.getAttribute('data-x') ?? 10);
            const y = Number(this.getAttribute('data-y') ?? 10);
            return { x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
          };
          const cf = {
            _url: furl,
            _dom: fdom,
            url: () => furl,
            isDetached: () => false,
            frameElement: async () => ({
              getAttribute: async (k) => ifr.getAttribute(k),
              dispose: async () => {},
              boundingBox: async () => {
                const r = ifr.getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height };
              },
            }),
            evaluate: async (fn, arg) => {
              fdom.window.__abArg = arg;
              const out = await fdom.window.eval(`(${fn.toString()})(window.__abArg)`);
              return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
            },
            locator: (sel) => makeLocator(() => fdom.window.document, sel, state.events),
          };
          state.childFrames[idx] = cf;
        }
        frames.push(state.childFrames[idx]);
      });
      return frames;
    };

    const page = {
      _state: state,
      on: (ev, fn) => em.on(ev, fn),
      emit: (ev, ...a) => em.emit(ev, ...a),
      isClosed: () => false,
      close: async () => em.emit('close'),
      mainFrame: () => page,
      frames: buildFrames,
      url: () => state.url,
      title: async () => state.window.document.title || '',
      bringToFront: async () => {},
      setViewportSize: async (vp) => { state.viewport = { ...vp }; },
      emulateMedia: async () => {},
      addInitScript: async () => {},
      waitForLoadState: async () => {},
      waitForURL: async () => {},
      waitForFunction: async () => {},
      goto: async (url) => {
        state.history = state.history.slice(0, state.histIdx + 1);
        state.history.push(url);
        state.histIdx = state.history.length - 1;
        state.childFrames = [];
        mountDom(state, url);
        const req = {
          url: () => url,
          method: () => 'GET',
          resourceType: () => 'document',
          isNavigationRequest: () => true,
          frame: () => page,
          headers: () => ({ accept: 'text/html' }),
          postData: () => null,
        };
        em.emit('request', req);
        em.emit('response', {
          request: () => req,
          status: () => 200,
          statusText: () => 'OK',
          headers: () => ({ 'content-type': 'text/html; charset=utf-8' }),
          securityDetails: async () => null,
          text: async () => '<html>ok</html>',
        });
        em.emit('requestfinished', req);
        em.emit('framenavigated', page);
      },
      goBack: async () => {
        if (state.histIdx > 0) {
          state.histIdx--;
          mountDom(state, state.history[state.histIdx]);
        }
      },
      goForward: async () => {
        if (state.histIdx < state.history.length - 1) {
          state.histIdx++;
          mountDom(state, state.history[state.histIdx]);
        }
      },
      reload: async () => { mountDom(state, state.url); },
      evaluate: async (fn, arg) => {
        if (typeof fn === 'function') {
          state.window.__abArg = arg;
          const out = await state.window.eval(`(${fn.toString()})(window.__abArg)`);
          return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
        }
        return state.window.eval(fn);
      },
      locator: (sel) => makeLocator(() => state.window.document, sel, state.events),
      frameLocator: (frameSel) => ({
        locator: (innerSel) => {
          const ifr = state.window.document.querySelector(frameSel);
          const all = Array.from(state.window.document.querySelectorAll('iframe[data-xorigin]'));
          const idx = all.indexOf(ifr);
          buildFrames();
          const cf = state.childFrames[idx >= 0 ? idx : 0];
          return cf ? cf.locator(innerSel) : makeLocator(() => state.window.document, innerSel, state.events);
        },
      }),
      keyboard: {
        press: async (k) => { state.events.push({ kind: 'key', key: k }); },
        type: async (t) => { state.events.push({ kind: 'kbType', text: t }); },
      },
      mouse: {
        click: async (x, y, opts = {}) => { state.events.push({ kind: 'mouseClick', x, y, button: opts.button || 'left' }); },
        dblclick: async (x, y, opts = {}) => { state.events.push({ kind: 'mouseDblclick', x, y, button: opts.button || 'left' }); },
        move: async (x, y) => { state.events.push({ kind: 'mouseMove', x, y }); },
        down: async () => { state.events.push({ kind: 'mouseDown' }); },
        up: async () => { state.events.push({ kind: 'mouseUp' }); },
        wheel: async (dx, dy) => { state.events.push({ kind: 'wheel', dx, dy }); },
      },
      screenshot: async ({ type = 'png' } = {}) => {
        const png = makeSolidPng(64, 48, [24, 32, 48, 255], state.visualPatch);
        return type === 'png' ? png : png;
      },
      pdf: async ({ format = 'A4', landscape = false } = {}) => {
        const content = `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 2 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /Format (${format}) /Landscape ${landscape} >> endobj\n4 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF\n`;
        return Buffer.from(content, 'utf8');
      },
    };
    return page;
  }

  const browser = {
    createdContexts,
    isConnected: () => true,
    close: async () => {},
    newContext: async (ctxOpts = {}) => {
      const ctxEm = new EventEmitter();
      const pages = [];
      const ctx = {
        opts: ctxOpts,
        pages,
        on: (ev, fn) => ctxEm.on(ev, fn),
        newPage: async () => {
          const pg = makePage();
          pages.push(pg);
          return pg;
        },
        close: async () => {},
        addInitScript: async () => {},
        grantPermissions: async () => {},
        setOffline: async () => {},
        setGeolocation: async () => {},
        setExtraHTTPHeaders: async () => {},
        route: async () => {},
        unroute: async () => {},
        cookies: async () => [],
        clearCookies: async () => {},
        addCookies: async () => {},
        storageState: async () => ({ cookies: [], origins: [] }),
        newCDPSession: async () => { throw new Error('no cdp in mock'); },
        tracing: {
          start: async () => {},
          stop: async ({ path: outPath } = {}) => {
            if (outPath) await fs.writeFile(outPath, Buffer.from('PK\x03\x04mock-trace-zip'));
          },
        },
      };
      createdContexts.push(ctx);
      return ctx;
    },
  };
  return browser;
}

// ============================================================================
// 1. Visual Diff PNG Engine, PDF Export & Jailed Download Artifact Inspector
// ============================================================================
test('Pillar #4: PNG codec (all filters 0-4), perceptual visual diff, PDF export & jailed download inspector', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-v2-visual-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  // Test PNG round-trip across ALL 5 PNG filter modes (0=None, 1=Sub, 2=Up, 3=Average, 4=Paeth)
  const w = 16, h = 12;
  const orig = Buffer.alloc(w * h * 4);
  for (let i = 0; i < orig.length; i += 4) {
    orig[i] = (i * 17) & 0xff;
    orig[i + 1] = (i * 31 + 40) & 0xff;
    orig[i + 2] = (i * 53 + 90) & 0xff;
    orig[i + 3] = 255;
  }
  for (const filterType of [0, 1, 2, 3, 4]) {
    const png = encodeFilteredPng(w, h, orig, filterType);
    const decoded = decodePng(png);
    assert.equal(decoded.width, w);
    assert.equal(decoded.height, h);
    assert.deepEqual(Buffer.from(decoded.data), orig, `PNG filter ${filterType} must decode losslessly`);
  }

  // Identical screenshots => 0% diff
  const basePng = makeSolidPng(80, 60, [240, 244, 248, 255]);
  const sameDiff = comparePngBuffers(basePng, basePng, { includeDiffImage: false });
  assert.equal(sameDiff.matched, true);
  assert.equal(sameDiff.diffPixels, 0);
  assert.equal(sameDiff.diffPercent, 0);
  assert.equal(sameDiff.boundingBox, null);

  // Modified screenshot with a 20x15 red banner at (10, 12) => exact 300 / 4800 = 6.25% diff
  const changedPng = makeSolidPng(80, 60, [240, 244, 248, 255], { x: 10, y: 12, w: 20, h: 15, color: [220, 30, 30, 255] });
  const diff = comparePngBuffers(basePng, changedPng, { includeDiffImage: true });
  assert.equal(diff.matched, false);
  assert.equal(diff.sizeChanged, false);
  assert.equal(diff.diffPixels, 300);
  assert.equal(diff.diffPercent, 6.25);
  assert.deepEqual(diff.boundingBox, { x: 10, y: 12, width: 20, height: 15 });
  assert.ok(diff.hotspots.length >= 1);
  const diffDecoded = decodePng(diff.diffPngBuffer || Buffer.from(diff.diffBase64, 'base64'));
  assert.equal(diffDecoded.width, 80);
  assert.equal(diffDecoded.height, 60);

  // Different-size screenshots are handled gracefully without throwing
  const tallerPng = makeSolidPng(80, 80, [240, 244, 248, 255]);
  const sizeDiff = comparePngBuffers(basePng, tallerPng, { includeDiffImage: false });
  assert.equal(sizeDiff.sizeChanged, true);
  assert.equal(sizeDiff.diffPixels, 80 * 20);

  // Download inspector: CSV, JSON, Text (with secret redaction), PDF, PNG, and path traversal block
  const csvPath = path.join(tmp, 'report.csv');
  await fs.writeFile(csvPath, 'name,plan,amount\n"Alice, Inc.",Pro,99\nBob,Team,199\n');
  const csvInfo = await inspectDownloadArtifact({ id: 'dl1', filename: 'report.csv', savedPath: csvPath, url: 'https://x.test/report.csv' }, { downloadDir: tmp });
  assert.equal(csvInfo.inspected, true);
  assert.equal(csvInfo.kind, 'csv');
  assert.deepEqual(csvInfo.headers, ['name', 'plan', 'amount']);
  assert.equal(csvInfo.totalRows, 2);
  assert.equal(csvInfo.rows[0].name, 'Alice, Inc.');
  assert.equal(csvInfo.sha256.length, 64);

  const jsonPath = path.join(tmp, 'users.json');
  await fs.writeFile(jsonPath, JSON.stringify([{ user: 'alice', apiKey: 'sk-super-secret-value' }, { user: 'bob', role: 'admin' }]));
  const jsonInfo = await inspectDownloadArtifact({ id: 'dl2', filename: 'users.json', path: jsonPath }, { downloadDir: tmp });
  assert.equal(jsonInfo.kind, 'json');
  assert.equal(jsonInfo.jsonType, 'array');
  assert.equal(jsonInfo.itemCount, 2);
  assert.doesNotMatch(JSON.stringify(jsonInfo.sample), /sk-super-secret-value/);

  const pngPath = path.join(tmp, 'chart.png');
  await fs.writeFile(pngPath, basePng);
  const pngInfo = await inspectDownloadArtifact({ id: 'dl3', filename: 'chart.png', savedPath: pngPath }, { downloadDir: tmp });
  assert.equal(pngInfo.kind, 'png');
  assert.deepEqual(pngInfo.dimensions, { width: 80, height: 60 });

  // Jail escape attempt must fail hard
  const outsideFile = path.join(os.tmpdir(), `ab-outside-${Date.now()}.txt`);
  await fs.writeFile(outsideFile, 'top-secret');
  t.after(() => fs.rm(outsideFile, { force: true }));
  await assert.rejects(
    () => inspectDownloadArtifact({ id: 'dl9', filename: 'evil.txt', savedPath: outsideFile }, { downloadDir: tmp }),
    /escapes AGENT_BROWSER_DOWNLOAD_DIR/,
  );

  // PDF generation saves inside jail, rejects path traversal filenames cleanly, and counts pages
  const fakePage = {
    url: () => 'https://docs.example.com/invoice',
    title: async () => 'Invoice #42',
    pdf: async () => Buffer.from('%PDF-1.4\n/Type /Page\n/Type /Pages\n/Type /Page\n%%EOF'),
  };
  const pdf = await generatePagePdf(fakePage, { save: true, filename: '../../invoice-42', format: 'Letter', downloadDir: tmp });
  assert.equal(pdf.pageCount, 2);
  assert.equal(pdf.format, 'Letter');
  assert.equal(path.dirname(pdf.savedPath), await fs.realpath(tmp));
  assert.equal(pdf.sha256.length, 64);
});

// ============================================================================
// 2. Workflow Store, Secret Redaction, Template Vars & Playwright Codegen
// ============================================================================
test('Pillar #3: WorkflowRecorder redacts secrets, jails .workflow.json files & generates valid Playwright *.spec.mjs', async (t) => {
  const wfDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-v2-wf-'));
  t.after(() => fs.rm(wfDir, { recursive: true, force: true }));

  const store = new WorkflowStore({ dir: wfDir });
  await assert.rejects(() => store.save({ name: '../escape', steps: [{ op: 'open', url: 'https://a.test' }] }), /invalid workflow name/);

  const rec = new WorkflowRecorder();
  rec.start({ name: 'login-and-filter', description: 'Smoke test for login + dashboard filter' });
  const fakeSnap = {
    boxes: [
      { ref: 'e1', role: 'textbox', name: 'Email', inputType: 'email' },
      { ref: 'e2', role: 'textbox', name: 'Password', inputType: 'password' },
      { ref: 'e3', role: 'combobox', name: 'Environment' },
      { ref: 'e4', role: 'button', name: 'Apply Filter' },
    ],
  };
  rec.record({ op: 'open', url: 'https://app.example.com/login' }, { snapshot: fakeSnap });
  rec.record({ op: 'type', ref: 'e1', text: '{{email}}' }, { snapshot: fakeSnap });
  rec.record({ op: 'type', ref: 'e2', text: 'MyRealPassword!99', submit: true }, { snapshot: fakeSnap });
  rec.record({ op: 'select', ref: 'e3', value: 'production' }, { snapshot: fakeSnap });
  rec.record({ op: 'click', ref: 'e4', doubleClick: true }, { snapshot: fakeSnap });
  const wf = rec.stop();

  // Password must NEVER be written to the workflow JSON!
  const serialized = JSON.stringify(wf);
  assert.doesNotMatch(serialized, /MyRealPassword/);
  assert.ok(wf.variables.includes('email'));
  assert.ok(wf.variables.includes('secret_1'));

  const { savedPath } = await store.save(wf);
  assert.equal(path.dirname(savedPath), await fs.realpath(wfDir));
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'login-and-filter');

  // Template variable extraction & interpolation requires all vars and blocks prototype pollution
  assert.deepEqual(extractTemplateVariables({ a: '{{user}}', b: ['{{token}}', '{{user}}'] }), ['user', 'token']);
  assert.equal(interpolateTemplate('Hello {{user}}!', { user: 'Pranab' }), 'Hello Pranab!');
  assert.throws(() => interpolateTemplate('Hello {{missing}}', {}), /missing workflow variable/);
  assert.throws(() => interpolateTemplate('{{constructor}}', {}), /missing workflow variable/);

  // Exported Playwright spec expresses semantic locators, env-backed variables, and compiles cleanly!
  const code = exportPlaywrightSpec(wf);
  assert.match(code, /import \{ test, expect \} from '@playwright\/test'/);
  assert.match(code, /process\.env\.EMAIL/);
  assert.match(code, /process\.env\.SECRET_1/);
  assert.match(code, /page\.getByRole\("textbox", \{ name: "Email" \}\)\.fill/);
  assert.match(code, /page\.getByRole\("button", \{ name: "Apply Filter" \}\)\.dblclick/);
  assert.doesNotMatch(code, /MyRealPassword/);
  const jsBody = code.replace(/^import .*$/gm, '');
  assert.doesNotThrow(() => new vm.Script(jsBody), 'Generated Playwright spec must be valid JavaScript');

  assert.equal(await store.delete('login-and-filter'), true);
  assert.equal((await store.list()).length, 0);
});

// ============================================================================
// 3. Schema-Based Scraper, Repeating Items Extractor, Auto-Pagination & Agent v2
// ============================================================================
test('Pillar #5: extract(items|schema), auto-pagination across Next links & Autonomous Agent v2 with modal self-heal', async () => {
  const pages = {
    'https://shop.example.com/p1': `<!doctype html><html><head><title>Catalog P1</title></head><body>
      <main>
        <ul class="products">
          <li class="card" data-x="10" data-y="20" data-w="240" data-h="90">
            <span class="badge">NEW</span>
            <h3><a href="/item/1">Quantum Keyboard</a></h3>
            <span class="price" data-cents="12900">$129.00</span>
            <p class="desc">Low-latency mechanical switch deck for engineers.</p>
          </li>
          <li class="card" data-x="10" data-y="120" data-w="240" data-h="90">
            <h3><a href="/item/2">Neural Mouse</a></h3>
            <span class="price" data-cents="7900">$79.00</span>
            <p class="desc">Ergonomic optical sensor with 8kHz polling.</p>
          </li>
        </ul>
        <a class="next" rel="next" href="/p2" data-goto="/p2">Next →</a>
      </main>
    </body></html>`,
    'https://shop.example.com/p2': `<!doctype html><html><head><title>Catalog P2</title></head><body>
      <main>
        <ul class="products">
          <li class="card" data-x="10" data-y="20" data-w="240" data-h="90">
            <h3><a href="/item/3">Studio Monitor</a></h3>
            <span class="price" data-cents="49900">$499.00</span>
            <p class="desc">5K reference display with factory calibration.</p>
          </li>
        </ul>
      </main>
    </body></html>`,
    'https://portal.example.com/search': `<!doctype html><html><head><title>Job Portal</title></head><body>
      <div class="cookie-banner"><button id="cookie-ok" data-dismiss-occlusion="1" data-x="200" data-y="400" data-w="120" data-h="32">Accept all</button></div>
      <main>
        <h1>Search Roles</h1>
        <label for="q">Keyword</label><input id="q" type="text" data-x="20" data-y="40" data-w="200" data-h="30" />
        <label for="loc">City</label><input id="loc" type="text" data-x="20" data-y="80" data-w="200" data-h="30" />
        <button id="go" type="button" data-occluded="1" data-goto="/results" data-x="20" data-y="130" data-w="120" data-h="34">Find Roles</button>
      </main>
    </body></html>`,
    'https://portal.example.com/results': `<!doctype html><html><head><title>Results</title></head><body>
      <main>
        <h1>2 Roles Found</h1>
        <div class="jobs">
          <article class="job"><h3><a href="/job/1">Staff Browser Engineer — Kolkata</a></h3><p>Build resilient autonomous browser runtimes.</p></article>
          <article class="job"><h3><a href="/job/2">Senior Systems Engineer — Remote</a></h3><p>Design distributed sandboxed Chromium fleets.</p></article>
        </div>
      </main>
    </body></html>`,
  };

  const mockBrowser = createRichMockBrowser(pages);
  const manager = new SessionManager({
    browserLauncher: async () => mockBrowser,
    sessionOptions: { minActionIntervalMs: 0, policy: { approvalsEnabled: false } },
  });
  const session = await manager.getOrCreate('scraper');

  // 1) Auto-detected repeating items + multi-page pagination
  await session.act({ op: 'open', url: 'https://shop.example.com/p1' });
  const itemsRes = await session.act({ op: 'extract', format: 'items', maxPages: 3 });
  assert.equal(itemsRes.error, undefined);
  const itemsMulti = itemsRes.data;
  assert.equal(itemsMulti.pagesVisited, 2);
  assert.equal(itemsMulti.count, 3);
  assert.equal(itemsMulti.items[0].title, 'Quantum Keyboard');
  assert.equal(itemsMulti.items[0].price, '$129.00');
  assert.equal(itemsMulti.items[2].title, 'Studio Monitor');
  assert.equal(itemsMulti.items[2]._page, 2);

  // 2) Typed CSS schema extraction across multiple pages
  await session.act({ op: 'open', url: 'https://shop.example.com/p1' });
  const schemaOut = (await session.act({
    op: 'extract',
    format: 'schema',
    maxPages: 3,
    schema: {
      container: 'li.card',
      fields: {
        name: 'h3 a',
        link: { selector: 'h3 a', attr: 'href', type: 'url' },
        cents: { selector: '.price', attr: 'data-cents', type: 'number' },
        isNew: { selector: '.badge', type: 'boolean' },
      },
    },
  })).data;
  assert.equal(schemaOut.pagesVisited, 2);
  assert.equal(schemaOut.count, 3);
  assert.deepEqual(schemaOut.items[0], {
    name: 'Quantum Keyboard',
    link: 'https://shop.example.com/item/1',
    cents: 12900,
    isNew: true,
    _page: 1,
  });
  assert.equal(schemaOut.items[1].isNew, false);
  assert.equal(schemaOut.items[2].cents, 49900);

  // Schema validator rejects bogus configs cleanly
  assert.throws(() => normalizeExtractSchema({ fields: {} }), /between 1 and 40 fields/);

  // 3) Autonomous Agent v2: fills form fields, hits occluded button, self-heals by dismissing "Accept all" banner,
  // retries click, navigates to /results, verifies page change, and extracts structured items!
  const answer = await runTask(session, 'Search engineering roles in Kolkata and extract items', {
    mode: 'autonomous',
    startUrl: 'https://portal.example.com/search',
    fields: { Keyword: 'Browser Engineer', City: 'Kolkata' },
    submitLabel: 'Find Roles',
    extractFormat: 'items',
    selfHeal: true,
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.mode, 'autonomous');
  assert.equal(answer.healedCount, 1, 'Agent should self-heal the blocking cookie modal');
  assert.equal(answer.data.count, 2);
  assert.equal(answer.data.items[0].title, 'Staff Browser Engineer — Kolkata');

  await manager.shutdown();
});

// ============================================================================
// 4. Full-Stack v2.0 Integration: Dashboard, Takeover, Batch, Workflows, Cross-Origin Iframe,
//    Advanced Input, PDF, Visual Diff, Delta Mode, MCP Resources & Prompts, Metrics & Proxy
// ============================================================================
test('Full-stack v2.0: Dashboard, Takeover, Batch, Workflow, X-Origin Iframe, Delta, MCP Resources/Prompts, Metrics & Proxy', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-v2-full-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const routes = {
    'https://checkout.example.com/pay': `<!doctype html><html><head><title>Checkout</title></head><body>
      <main>
        <h1>Checkout</h1>
        <button id="promo" data-x="20" data-y="40" data-w="120" data-h="32">Apply Promo</button>
        <iframe data-xorigin="1" src="https://vault.stripe-like.example/frame" data-x="20" data-y="100" data-w="300" data-h="120"></iframe>
      </main>
    </body></html>`,
  };

  const mockBrowser = createRichMockBrowser(routes);
  const token = 'v2-mission-control-token';
  const ctl = createControlServer({
    host: '127.0.0.1',
    token,
    managerOptions: {
      browserLauncher: async () => mockBrowser,
      workflowDir: path.join(tmp, 'workflows'),
      sessionOptions: {
        minActionIntervalMs: 0,
        downloadDir: path.join(tmp, 'downloads'),
        uploadDir: path.join(tmp, 'uploads'),
        traceDir: path.join(tmp, 'traces'),
        workflowDir: path.join(tmp, 'workflows'),
        policy: { approvalsEnabled: true, approvalTimeoutMs: 800 },
      },
    },
  });
  await new Promise((r) => ctl.server.listen(0, '127.0.0.1', r));
  t.after(() => ctl.close());
  const port = ctl.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const sdk = new AgentBrowser(baseUrl, { token });

  // ---------- Pillar #2: Live Supervisor Dashboard & Human Takeover ----------
  // Dashboard HTML loads without Bearer header (for browser tab entry), enforces strict CSP, and parses cleanly as JS!
  const dashRes = await fetch(`${baseUrl}/dashboard`);
  assert.equal(dashRes.status, 200);
  assert.equal(dashRes.headers.get('content-security-policy'), DASHBOARD_CSP);
  const dashHtml = await dashRes.text();
  assert.match(dashHtml, /Mission Control/);
  assert.match(dashHtml, /Human Takeover/);
  const scriptMatch = dashHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Dashboard must include inline controller script');
  assert.doesNotThrow(() => new vm.Script(scriptMatch[1]), 'Dashboard inline JS must have zero syntax errors');
  assert.doesNotMatch(scriptMatch[1], /\.innerHTML\s*=/, 'Dashboard JS must never assign untrusted innerHTML');

  // Meanwhile /api/* and /metrics remain strictly Bearer-protected!
  assert.equal((await fetch(`${baseUrl}/metrics`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/takeover`, { method: 'POST' })).status, 401);

  // Open initial workspace page, pause agent (Human Takeover), verify agent is blocked while supervisor interacts freely!
  const openSnap = await sdk.open('https://app.example.com/workspace');
  assert.match(openSnap.text, /\be\d+ textbox "Full Name"/);

  // Pause agent (Human Takeover): verify agent action waits cleanly while supervisor interacts, then resumes on handoff!
  await sdk.pause(true);
  let agentFinished = false;
  const queuedAgentSnap = sdk.snapshot().then((s) => { agentFinished = true; return s; });
  const tkClick = await sdk.takeover({ op: 'click', x: 50, y: 55 });
  assert.equal(tkClick.ok, true);
  assert.equal(tkClick.paused, true);
  assert.equal(agentFinished, false, 'Agent actions must stay held while human takeover is active');
  await sdk.takeover({ op: 'drag', x: 50, y: 190, targetX: 280, targetY: 200 });
  await sdk.takeover({ op: 'wheel', dy: 240 });
  await sdk.takeover({ op: 'type', text: '849201', secret: true, submit: true });
  await sdk.takeover({ op: 'press', key: 'Escape' });
  const stateAfterTk = await sdk.state();
  assert.doesNotMatch(JSON.stringify(stateAfterTk.log), /849201/, 'Secret OTP typed during takeover must be masked in logs');
  // SSRF policy still protects supervisor goto
  await assert.rejects(() => sdk.takeover({ op: 'goto', url: 'http://169.254.169.254/latest/meta-data/' }), /blocked/i);
  await sdk.pause(false);
  await queuedAgentSnap;
  assert.equal(agentFinished, true, 'Held agent action must automatically resume when supervisor hands back control');

  // ---------- Pillar #4: Drag, Dblclick, Rightclick, Multi-Key, Clipboard, Cross-Origin Iframe, PDF, Downloads, Visual Diff ----------
  const findRef = (snap, re) => {
    const m = snap.text.split('\n').find((l) => re.test(l))?.match(/^(?:[+~]\s+)?\[?(e\d+)\]?\s/);
    assert.ok(m, `Expected ref matching ${re} in:\n${snap.text}`);
    return m[1];
  };
  const fullSnap = await sdk.snapshot({ full: true });
  const afterDrag = await sdk.drag(findRef(fullSnap, /"Task Card"/), findRef(fullSnap, /"Done Column"/), { steps: 8 });
  const afterDbl = await sdk.dblclick(findRef(afterDrag, /"Apply Filter"/));
  await sdk.rightclick(findRef(afterDbl, /"Apply Filter"/), { modifiers: ['Shift'] });
  await sdk.press(['Control+a', 'Backspace', 'Tab']);
  await assert.rejects(() => sdk.press('NotAValidKeyChord!!!'), /invalid key/i);

  // Clipboard write succeeds; clipboard read is approval-gated and succeeds when supervisor approves!
  const clipW = await sdk.clipboard('write', { text: 'copied-invite-code' });
  assert.equal(clipW.written, true);
  const readPromise = sdk.clipboard('read');
  let pendingState = await sdk.state();
  for (let i = 0; i < 30 && !pendingState.pending.length; i++) {
    await new Promise((r) => setTimeout(r, 15));
    pendingState = await sdk.state();
  }
  assert.equal(pendingState.pending.length, 1);
  assert.equal(pendingState.pending[0].rule, 'clipboard');
  await sdk.approve(pendingState.pending[0].id, true);
  const clipR = await readPromise;
  assert.equal(clipR.text, 'copied-invite-code');

  // PDF generation + automatic download artifact registration + download inspection
  const pdfOut = await sdk.pdf({ format: 'A4', save: true, filename: 'workspace-summary' });
  assert.equal(pdfOut.mimeType, 'application/pdf');
  assert.equal(pdfOut.pageCount, 2);
  assert.ok(pdfOut.downloadId);
  const dlInspect = await sdk.inspectDownload(pdfOut.downloadId);
  assert.equal(dlInspect.kind, 'pdf');
  assert.equal(dlInspect.pageCount, 2);
  assert.equal(dlInspect.sha256, pdfOut.sha256);
  const dlViaRest = await sdk.request(`/api/downloads/${pdfOut.downloadId}`);
  assert.equal(dlViaRest.sha256, pdfOut.sha256);

  // Visual regression baseline -> clean compare -> visual mutation -> failing compare with diff PNG!
  const baseCap = await sdk.visualDiff('baseline', { name: 'home' });
  assert.equal(baseCap.width, 64);
  const cleanCmp = await sdk.visualDiff('compare', { name: 'home', maxDiffPercent: 0.5 });
  assert.equal(cleanCmp.passed, true);
  assert.equal(cleanCmp.diffPercent, 0);

  const activeSession = ctl.manager.get('default');
  activeSession.activePage()._state.visualPatch = { x: 8, y: 8, w: 16, h: 12, color: [250, 40, 40, 255] };
  const dirtyCmp = await sdk.visualDiff('compare', { name: 'home', maxDiffPercent: 1 });
  assert.equal(dirtyCmp.passed, false);
  assert.ok(dirtyCmp.diffPercent > 5);
  assert.deepEqual(dirtyCmp.boundingBox, { x: 8, y: 8, width: 16, height: 12 });
  assert.ok(dirtyCmp.diffBase64.length > 50);
  const baseList = await sdk.visualDiff('list');
  assert.equal(baseList.baselines.length, 1);

  // Cross-origin iframe discovery (`frame=f1:xorigin`) & action routing into child Frame!
  const xSnap = await sdk.open('https://checkout.example.com/pay');
  assert.match(xSnap.text, /frame=f1:xorigin/);
  const xInputRef = findRef(xSnap, /textbox "Card Code".*frame=f1:xorigin/);
  const afterXType = await sdk.type(xInputRef, '4242');
  const xBtnRef = findRef(afterXType, /button "Verify Widget".*frame=f1:xorigin/);
  const afterXClick = await sdk.click(xBtnRef);
  assert.match(afterXClick.text, /button "XFrame Activated".*frame=f1:xorigin/);

  // ---------- Pillar #6 (Part 1): Delta Snapshot Mode ----------
  const baseDelta = await sdk.open('https://app.example.com/workspace');
  const nameRef = findRef(baseDelta, /textbox "Full Name"/);
  const deltaSnap = await sdk.type(nameRef, 'Pranab Rana', { delta: true });
  assert.equal(deltaSnap.delta, true);
  assert.match(deltaSnap.text, /\[delta\]/);
  assert.match(deltaSnap.text, /~ e\d+ textbox "Full Name" value="Pranab Rana"/);
  assert.ok(deltaSnap.deltaStats.unchanged >= 3);

  // ---------- Pillar #3: Batch Execution + Workflow Record, Replay & Export ----------
  await sdk.startRecording('onboard-flow', { description: 'Fill profile & filter' });
  const s0 = await sdk.open('https://app.example.com/workspace');
  const rName = findRef(s0, /textbox "Full Name"/);
  const rRole = findRef(s0, /combobox "Role"/);
  const rBtn = findRef(s0, /button "Apply Filter"/);

  const batchOut = await sdk.batch([
    { op: 'type', ref: rName, text: '{{full_name}}' },
    { op: 'select', ref: rRole, value: 'qa' },
    { op: 'click', ref: rBtn },
  ]);
  assert.equal(batchOut.ok, true);
  assert.equal(batchOut.completed, 3);
  assert.equal(batchOut.stoppedEarly, false);

  const stopped = await sdk.stopRecording({ save: true });
  assert.equal(stopped.workflow.name, 'onboard-flow');
  assert.deepEqual(stopped.workflow.variables, ['full_name']);
  assert.ok(stopped.savedPath);

  // Replay with 0 LLM tokens and dynamic variable substitution!
  const replayed = await sdk.replayWorkflow('onboard-flow', { full_name: 'Aarav Sen' });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.workflow, 'onboard-flow');
  assert.match(replayed.snapshot.text, /value="Aarav Sen"/);
  assert.match(replayed.snapshot.text, /Action confirmed: clicked save-btn/);

  // Export as Playwright test
  const exported = await sdk.exportPlaywright('onboard-flow');
  assert.equal(exported.filename, 'onboard-flow.spec.mjs');
  assert.match(exported.code, /process\.env\.FULL_NAME/);

  // Batch stops cleanly on error
  const errBatch = await sdk.batch([
    { op: 'wait', ms: 5 },
    { op: 'click', ref: 'e9999' },
    { op: 'wait', ms: 5 },
  ]);
  assert.equal(errBatch.ok, false);
  assert.equal(errBatch.completed, 1);
  assert.equal(errBatch.stoppedEarly, true);

  // ---------- Pillar #6 (Part 2): Full MCP Spec (37 tools, resources/*, prompts/*) over HTTP /mcp & stdio ----------
  const mcpCall = (method, params, id = 1) =>
    sdk.request('/mcp', { jsonrpc: '2.0', id, method, params });

  const initRes = await mcpCall('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(initRes.result.serverInfo.version, '2.0.0');
  assert.ok(initRes.result.capabilities.tools);
  assert.ok(initRes.result.capabilities.resources);
  assert.ok(initRes.result.capabilities.prompts);

  const toolList = await mcpCall('tools/list');
  assert.equal(toolList.result.tools.length, 37);

  // MCP Resources + Resource Templates
  const resList = await mcpCall('resources/list');
  assert.ok(resList.result.resources.length >= 10);
  const tplList = await mcpCall('resources/templates/list');
  assert.equal(tplList.result.resourceTemplates.length, 4);

  const rSnap = await mcpCall('resources/read', { uri: 'browser://snapshot' });
  assert.match(rSnap.result.contents[0].text, /\[url\] https:\/\/app\.example\.com\/workspace/);
  const rShot = await mcpCall('resources/read', { uri: 'browser://screenshot' });
  assert.equal(rShot.result.contents[0].mimeType, 'image/jpeg');
  assert.ok(rShot.result.contents[0].blob.length > 40);
  const rHar = await mcpCall('resources/read', { uri: 'browser://network/har' });
  assert.equal(JSON.parse(rHar.result.contents[0].text).log.version, '1.2');
  const rWfCode = await mcpCall('resources/read', { uri: 'browser://workflows/onboard-flow/playwright' });
  assert.match(rWfCode.result.contents[0].text, /@playwright\/test/);
  const rDl = await mcpCall('resources/read', { uri: `browser://downloads/${pdfOut.downloadId}` });
  assert.equal(JSON.parse(rDl.result.contents[0].text).sha256, pdfOut.sha256);

  // Trace resource exposes zip blob after stop
  await sdk.trace('start');
  await sdk.trace('stop');
  const rTrace = await mcpCall('resources/read', { uri: 'browser://trace' });
  assert.equal(rTrace.result.contents.length, 2);
  assert.equal(rTrace.result.contents[1].mimeType, 'application/zip');

  // MCP Prompts
  const promptList = await mcpCall('prompts/list');
  assert.equal(promptList.result.prompts.length, 5);
  const qaPrompt = await mcpCall('prompts/get', { name: 'qa_audit', arguments: { url: 'https://example.com', device: 'iphone-15' } });
  assert.match(qaPrompt.result.messages[0].content.text, /browser_visual_diff/);
  assert.match(qaPrompt.result.messages[0].content.text, /iphone-15/);
  const badPrompt = await mcpCall('prompts/get', { name: 'qa_audit', arguments: {} });
  assert.equal(badPrompt.error.code, -32602);

  // Verify stdio MCP bridge also handles resources/read and prompts/get cleanly!
  const stdioOut = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(AB_DIR, 'mcp.mjs')], {
      env: { ...process.env, AGENT_BROWSER_URL: baseUrl, AGENT_BROWSER_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = [];
    child.stdout.on('data', (chunk) => {
      for (const l of chunk.toString('utf8').split('\n').filter(Boolean)) lines.push(JSON.parse(l));
      if (lines.length >= 2) { child.stdin.end(); child.kill('SIGKILL'); resolve(lines); }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'browser://workflows' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'security_review', arguments: { url: 'https://example.com' } } }) + '\n');
  });
  const r1 = stdioOut.find((m) => m.id === 1);
  const r2 = stdioOut.find((m) => m.id === 2);
  assert.equal(JSON.parse(r1.result.contents[0].text).workflows[0].name, 'onboard-flow');
  assert.match(r2.result.messages[0].content.text, /browser_security/);

  // ---------- Pillar #7: Per-Session Proxy + Prometheus /metrics ----------
  // SSRF guard blocks private proxy hosts unless allowPrivateNetworks is explicitly enabled!
  await assert.rejects(
    () => sdk.createSession({ id: 'bad-proxy', proxy: 'http://127.0.0.1:8080' }),
    /private or loopback/,
  );
  const proxied = await sdk.createSession({
    id: 'geo-eu',
    eager: true,
    proxy: 'http://user1:superSecretProxyPass@proxy.eu.example.com:8443',
  });
  assert.equal(proxied.id, 'geo-eu');
  assert.deepEqual(proxied.state.proxy, {
    server: 'http://proxy.eu.example.com:8443',
    authenticated: true,
  });
  assert.doesNotMatch(JSON.stringify(proxied.state), /superSecretProxyPass/);
  const lastCtx = mockBrowser.createdContexts.at(-1);
  assert.equal(lastCtx.opts.proxy.username, 'user1');
  assert.equal(lastCtx.opts.proxy.password, 'superSecretProxyPass');

  // Prometheus exposition & JSON metrics summary
  const promText = await sdk.metrics('prometheus');
  assert.match(promText, /agentbrowser_sessions_active 2/);
  assert.match(promText, /agentbrowser_action_duration_seconds_bucket\{op="batch",le="\+Inf"\} 2/);
  assert.match(promText, /agentbrowser_batch_runs_total 2/);
  assert.match(promText, /agentbrowser_workflow_replays_total 1/);
  assert.match(promText, /agentbrowser_takeover_events_total 6/);
  assert.match(promText, /process_resident_memory_bytes \d+/);

  const jsonMetrics = await sdk.metrics('json');
  assert.equal(jsonMetrics.ok, true);
  assert.equal(jsonMetrics.activeSessions, 2);
  assert.equal(jsonMetrics.workflowReplays, 1);
  assert.equal(jsonMetrics.takeoverEvents, 6);
  assert.equal(jsonMetrics.approvals.allowed, 1);
});

// ============================================================================
// 5. Pillar #7 Ecosystem Verification: sdk.d.ts, tools.d.ts, CLI flags & Docker Hardening
// ============================================================================
test('Pillar #7: sdk.d.ts & tools.d.ts cover 100% of SDK methods and 37 tools; CLI & Docker pass security checks', async () => {
  const sdkDts = await fs.readFile(path.join(AB_DIR, 'sdk.d.ts'), 'utf8');
  const toolsDts = await fs.readFile(path.join(AB_DIR, 'tools.d.ts'), 'utf8');
  const pkgJson = JSON.parse(await fs.readFile(path.join(AB_DIR, 'package.json'), 'utf8'));
  const dockerfile = await fs.readFile(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
  const compose = await fs.readFile(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');

  assert.equal(pkgJson.version, '2.0.0');
  assert.equal(pkgJson.types, './sdk.d.ts');

  // Every public method on AgentBrowser.prototype MUST be declared in sdk.d.ts!
  const publicMethods = Object.getOwnPropertyNames(AgentBrowser.prototype)
    .filter((m) => m !== 'constructor' && !m.startsWith('_'));
  for (const method of publicMethods) {
    assert.ok(
      new RegExp(`\\b${method}[<(]`).test(sdkDts),
      `sdk.d.ts is missing declaration for AgentBrowser.${method}()`,
    );
  }

  // Every single tool in tools.mjs MUST be listed in tools.d.ts AgentBrowserToolName union!
  assert.equal(tools.length, 37);
  for (const tool of tools) {
    assert.ok(toolsDts.includes(`'${tool.name}'`), `tools.d.ts is missing tool name '${tool.name}'`);
  }

  // CLI flag parsing for v2 options
  const cli = parseCliArgs(['fetch', 'https://news.ycombinator.com', '--dump', 'items', '--max-pages', '3', '--proxy', 'http://proxy.example.com:8080']);
  assert.equal(cli.dump, 'items');
  assert.equal(cli.maxPages, 3);
  assert.equal(cli.proxy, 'http://proxy.example.com:8080');
  assert.equal(parseCliArgs(['fetch', 'https://example.com', '--dump', 'pdf']).dump, 'pdf');

  // Proxy helper edge cases
  assert.equal(normalizeProxyConfig(''), null);
  assert.throws(() => normalizeProxyConfig('ftp://proxy.example.com:21'), /unsupported proxy protocol/);
  assert.deepEqual(
    redactProxy(normalizeProxyConfig({ server: 'socks5://gate.example.com:1080', username: 'u', password: 'p', bypass: '*.local' })),
    { server: 'socks5://gate.example.com:1080', bypass: '*.local', authenticated: true },
  );

  // Dockerfile & docker-compose production hardening invariants
  assert.match(dockerfile, /^FROM mcr\.microsoft\.com\/playwright:v\d+\.\d+\.\d+-noble/m);
  assert.match(dockerfile, /^USER pwuser$/m);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(dockerfile, /AGENT_BROWSER_WORKFLOW_DIR=\/data\/workflows/);
  assert.match(compose, /shm_size:\s*"1gb"/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /AGENT_BROWSER_TOKEN:/);
});
