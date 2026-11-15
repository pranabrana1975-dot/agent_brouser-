import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractPage } from '../lib/extract.mjs';
import { takeSnapshot } from '../lib/snapshot.mjs';

function pageFor(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/path', runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 5, y: 5, top: 5, bottom: 25, width: 80, height: 20 });
  return { evaluate(fn, arg) { window.__testArg = arg; return Promise.resolve(window.eval(`(${fn.toString()})(window.__testArg)`)); } };
}

test('extracts text, markdown, absolute links, and form metadata', async () => {
  const page = pageFor('<title>Demo</title><main><h1>Heading</h1><p>Hello world.</p><script>evil()</script><a href="/next">Next page</a><form action="/submit"><label>Email<input name="email" required></label><input type="password" name="secret" value="private"></form></main>');
  const text = await extractPage(page, 'text');
  assert.match(text.content, /Hello world/);
  const markdown = await extractPage(page, 'markdown');
  assert.match(markdown.content, /Heading/);
  assert.doesNotMatch(markdown.content, /evil/);
  const links = await extractPage(page, 'links');
  assert.equal(links.links[0].url, 'https://example.com/next');
  const forms = await extractPage(page, 'forms');
  assert.equal(forms.forms[0].fields[0].name, 'email');
  assert.equal(forms.forms[0].fields[0].required, true);
  assert.doesNotMatch(JSON.stringify(forms), /private/);
  await assert.rejects(extractPage(page, 'text', 0), /maxChars/);
});

test('snapshot refs remain unique across successive snapshots', async () => {
  const page = pageFor('<body><button>First</button><button>Second</button></body>');
  const first = await takeSnapshot(page, 0);
  const next = await takeSnapshot(page, first.boxes.length);
  assert.deepEqual(Array.from(first.boxes, b => b.ref), ['e1', 'e2']);
  assert.deepEqual(Array.from(next.boxes, b => b.ref), ['e3', 'e4']);
});
