import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { PAGE_PROBE, renderDoc, toWireSnapshot } from '../lib/snapshot.mjs';

// Minimal DOM fixture builder so PAGE_PROBE can be tested directly without a browser binary.
function createMockDom({ url = 'https://example.com/page', title = 'Demo Page', vw = 1280, vh = 800, scrollY = 0, docHeight = 1600 }) {
  const byId = new Map();

  class MockElement {
    constructor(tag, opts = {}, ownerDoc = null) {
      this.tagName = tag.toUpperCase();
      this.attrs = new Map(Object.entries(opts.attrs || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
      this.id = opts.id || this.attrs.get('id') || '';
      if (this.id) this.attrs.set('id', this.id);
      this.innerText = opts.text ?? '';
      this.textContent = opts.text ?? '';
      this.value = opts.value ?? '';
      this.type = opts.type ?? this.attrs.get('type') ?? '';
      this.disabled = Boolean(opts.disabled);
      this.required = Boolean(opts.required);
      this.readOnly = Boolean(opts.readOnly);
      this.checked = Boolean(opts.checked);
      this.indeterminate = Boolean(opts.indeterminate);
      this.open = Boolean(opts.open);
      this.options = opts.options || null;
      this.selectedOptions = opts.options ? opts.options.filter((o) => o.selected) : null;
      this.labels = opts.labels || null;
      this.style = opts.style || { visibility: 'visible', display: 'block', opacity: '1' };
      this._rect = opts.rect || { left: 20, top: 40, width: 140, height: 32 };
      this.children = [];
      this.parentElement = null;
      this.shadowRoot = null;
      this.contentDocument = opts.contentDocument || null;
      this.contentWindow = opts.contentWindow || null;
      this._ownerDoc = ownerDoc;
      if (this.id && ownerDoc) ownerDoc._byId.set(this.id, this);
    }

    append(...kids) {
      for (const k of kids) {
        k.parentElement = this;
        k._setOwner(this._ownerDoc);
        this.children.push(k);
      }
      return this;
    }

    _setOwner(doc) {
      this._ownerDoc = doc;
      if (this.id && doc) doc._byId.set(this.id, this);
      for (const c of this.children) c._setOwner(doc);
    }

    attachShadow() {
      const sr = new MockRoot(this._ownerDoc);
      this.shadowRoot = sr;
      return sr;
    }

    getRootNode() {
      let cur = this;
      while (cur.parentElement) cur = cur.parentElement;
      return cur._rootContainer || this._ownerDoc;
    }

    getAttribute(name) {
      const key = String(name).toLowerCase();
      return this.attrs.has(key) ? this.attrs.get(key) : null;
    }

    setAttribute(name, val) {
      this.attrs.set(String(name).toLowerCase(), String(val));
    }

    removeAttribute(name) {
      this.attrs.delete(String(name).toLowerCase());
    }

    getBoundingClientRect() {
      const { left, top, width, height } = this._rect;
      return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height };
    }

    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    }

    matches(selector) {
      return selector.split(',').some((part) => matchSingle(this, part.trim()));
    }

    closest(selector) {
      let cur = this;
      while (cur) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }

    querySelectorAll(selector) {
      const out = [];
      const walk = (node) => {
        for (const c of node.children) {
          if (c.matches(selector)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    cloneNode() {
      const copy = new MockElement(this.tagName, { text: this.innerText }, this._ownerDoc);
      copy.children = this.children.map((c) => c.cloneNode());
      return copy;
    }

    remove() {
      if (!this.parentElement) return;
      const idx = this.parentElement.children.indexOf(this);
      if (idx >= 0) this.parentElement.children.splice(idx, 1);
    }
  }

  class MockRoot {
    constructor(ownerDoc) {
      this._ownerDoc = ownerDoc;
      this._byId = new Map();
      this.children = [];
    }

    append(...kids) {
      for (const k of kids) {
        k._rootContainer = this;
        if (k.id) this._byId.set(k.id, k);
        this.children.push(k);
      }
      return this;
    }

    getElementById(id) {
      return this._byId.get(id) || null;
    }

    querySelectorAll(selector) {
      const out = [];
      const walk = (node) => {
        for (const c of node.children) {
          if (c.matches(selector)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  function matchSingle(el, sel) {
    if (!sel) return false;
    if (sel === '*') return true;
    // Descendant combinator support (e.g. `svg title`)
    if (sel.includes(' ') && !sel.includes('[')) {
      const [anc, leaf] = sel.split(/\s+/);
      return matchSingle(el, leaf) && Boolean(el.parentElement?.closest(anc));
    }
    if (sel === 'input:not([type="hidden"])') {
      return el.tagName === 'INPUT' && (el.getAttribute('type') || el.type || 'text').toLowerCase() !== 'hidden';
    }
    const tagAttr = sel.match(/^([a-z0-9]+)?(?:\[([a-z0-9-]+)(?:="([^"]*)")?\])?$/i);
    if (!tagAttr) return false;
    const [, tag, attr, val] = tagAttr;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    if (attr) {
      const got = el.getAttribute(attr);
      if (got === null) return false;
      if (val !== undefined && got !== val) return false;
    }
    return Boolean(tag || attr);
  }

  const doc = {
    _byId: byId,
    title,
    documentElement: { scrollHeight: docHeight, innerHTML: '<html></html>', querySelectorAll: () => [] },
    body: null,
    el(tag, opts) { return new MockElement(tag, opts, doc); },
    getElementById(id) { return doc._byId.get(id) || null; },
    querySelectorAll(sel) { return doc.body ? doc.body.querySelectorAll(sel) : []; },
    querySelector(sel) { return doc.querySelectorAll(sel)[0] || null; },
  };
  doc.body = new MockElement('body', { text: '' }, doc);

  const win = {
    innerWidth: vw,
    innerHeight: vh,
    scrollY,
    getComputedStyle: (el) => el.style,
  };

  function runProbe(probeOpts = {}) {
    const context = vm.createContext({
      document: doc,
      window: win,
      location: { href: url },
      performance: { getEntriesByType: () => [{ decodedBodySize: 4096 }] },
      CSS: { escape: (s) => s },
    });
    return vm.runInContext(`(${PAGE_PROBE.toString()})(${JSON.stringify(probeOpts)})`, context);
  }

  return { doc, win, runProbe };
}

test('PAGE_PROBE prioritizes viewport and <main> controls over bloated navigation headers', () => {
  const { doc, runProbe } = createMockDom({ url: 'https://shop.example.com/' });
  const nav = doc.el('nav');
  for (let i = 1; i <= 120; i++) {
    nav.append(doc.el('a', {
      text: `Nav Link ${i}`,
      attrs: { href: `/cat/${i}` },
      rect: { left: 10, top: i <= 20 ? 20 : 1400, width: 80, height: 24 },
    }));
  }

  const main = doc.el('main');
  const emailLabel = doc.el('label', { text: 'Work Email', attrs: { for: 'email-input' } });
  const emailInput = doc.el('input', {
    id: 'email-input',
    type: 'email',
    required: true,
    rect: { left: 100, top: 220, width: 240, height: 36 },
  });
  const pwdInput = doc.el('input', {
    type: 'password',
    value: 'super-secret-password',
    attrs: { 'aria-label': 'Account Password' },
    rect: { left: 100, top: 270, width: 240, height: 36 },
  });
  const countrySelect = doc.el('select', {
    attrs: { 'aria-label': 'Country' },
    options: [
      { value: 'in', label: 'India', text: 'India', selected: true },
      { value: 'us', label: 'United States', text: 'United States', selected: false },
    ],
    rect: { left: 100, top: 320, width: 200, height: 36 },
  });
  const agreeBox = doc.el('input', {
    type: 'checkbox',
    checked: true,
    attrs: { 'aria-label': 'Accept terms' },
    rect: { left: 100, top: 370, width: 20, height: 20 },
  });
  const disabledBtn = doc.el('button', {
    text: 'Continue',
    disabled: true,
    rect: { left: 100, top: 410, width: 120, height: 38 },
  });
  main.append(emailLabel, emailInput, pwdInput, countrySelect, agreeBox, disabledBtn);
  doc.body.append(nav, main);

  const raw = runProbe({ maxActions: 30 });
  const snap = renderDoc(raw);

  assert.equal(snap.boxes.length, 30);
  assert.equal(snap.truncatedActions, 95); // 125 total - 30 kept

  // Every single <main> control survived truncation despite coming AFTER 120 nav links!
  const names = snap.boxes.map((b) => b.name);
  assert.ok(names.includes('Work Email'));
  assert.ok(names.includes('Account Password'));
  assert.ok(names.includes('Country'));
  assert.ok(names.includes('Accept terms'));
  assert.ok(names.includes('Continue'));

  // Password value is masked, states and options are rendered, labels resolved.
  assert.match(snap.text, /textbox\[email\] "Work Email" \[required\]/);
  assert.match(snap.text, /password "Account Password" value="••••••"/);
  assert.doesNotMatch(snap.text, /super-secret-password/);
  assert.match(snap.text, /combobox "Country" value="India" options=\[\*"India", "United States"\]/);
  assert.match(snap.text, /checkbox "Accept terms" \[checked\]/);
  assert.match(snap.text, /button "Continue" \[disabled\]/);

  // Wire snapshot omits heavy raw bodyText and strips boxes in compact mode.
  const fullWire = toWireSnapshot(snap, { full: true });
  assert.equal('bodyText' in fullWire, false);
  assert.ok(Array.isArray(fullWire.boxes));
  const compactWire = toWireSnapshot(snap, { full: false });
  assert.equal('boxes' in compactWire, false);
  assert.equal(compactWire.text, snap.text);
});

test('PAGE_PROBE handles aria-labelledby, shadow DOM, same-origin iframes, heading bounds, and li>p dedupe', () => {
  const { doc, runProbe } = createMockDom({ url: 'https://app.example.com/', vh: 800 });

  // Above-viewport heading (bottom = -10) must be marked offscreen `[·]`, not `[v]`.
  const scrolledPastHeading = doc.el('h2', {
    text: 'Previous Section',
    rect: { left: 20, top: -60, width: 300, height: 50 },
  });
  const visibleHeading = doc.el('h1', {
    text: 'Dashboard Overview',
    rect: { left: 20, top: 30, width: 400, height: 44 },
  });

  // aria-labelledby resolution + icon button fallback
  const lbl = doc.el('span', { id: 'q-lbl', text: 'Filter projects' });
  const input = doc.el('input', {
    attrs: { 'aria-labelledby': 'q-lbl' },
    rect: { left: 20, top: 90, width: 220, height: 32 },
  });
  const iconLink = doc.el('a', { attrs: { href: '/settings' }, rect: { left: 260, top: 90, width: 32, height: 32 } });
  iconLink.append(doc.el('img', { attrs: { alt: 'Workspace Settings' } }));

  // Open Shadow DOM button
  const host = doc.el('custom-widget');
  const shadow = host.attachShadow();
  const shadowBtn = doc.el('button', {
    text: 'Shadow Action',
    attrs: { 'aria-expanded': 'false' },
    rect: { left: 20, top: 150, width: 140, height: 34 },
  });
  shadow.append(shadowBtn);

  // Same-origin iframe with inner button
  const child = createMockDom({ url: 'https://app.example.com/embed' });
  const frameBtn = child.doc.el('button', {
    text: 'Frame Confirm',
    rect: { left: 10, top: 15, width: 120, height: 30 },
  });
  child.doc.body.append(frameBtn);
  const iframe = doc.el('iframe', {
    contentDocument: child.doc,
    contentWindow: child.win,
    rect: { left: 50, top: 220, width: 400, height: 200 },
  });

  // `<li><p>...</p></li>` prose must appear ONCE, not duplicated.
  const prose = 'AgentBrowser converts complex DOM trees into compact structured documents for deterministic control.';
  const li = doc.el('li', { text: prose, rect: { left: 20, top: 450, width: 600, height: 40 } });
  li.append(doc.el('p', { text: prose, rect: { left: 20, top: 450, width: 600, height: 40 } }));

  doc.body.append(scrolledPastHeading, visibleHeading, lbl, input, iconLink, host, iframe, li);

  const snap = renderDoc(runProbe());

  assert.match(snap.text, /h2\[·\] "Previous Section"/);
  assert.match(snap.text, /h1\[v\] "Dashboard Overview"/);
  assert.match(snap.text, /textbox "Filter projects"/);
  assert.match(snap.text, /link "Workspace Settings" → \/settings/);
  assert.match(snap.text, /button "Shadow Action" \[collapsed\]/);
  assert.match(snap.text, /button "Frame Confirm" \[frame=f1\]/);

  assert.equal(iframe.getAttribute('data-agent-frame'), 'f1');
  const frameBox = snap.boxes.find((b) => b.name === 'Frame Confirm');
  assert.equal(frameBox.frame, 'f1');
  assert.equal(frameBox.x, 60);  // 50 + 10
  assert.equal(frameBox.y, 235); // 220 + 15

  assert.equal(snap.textBits.length, 1);
  assert.equal(snap.textBits[0], prose);
});
