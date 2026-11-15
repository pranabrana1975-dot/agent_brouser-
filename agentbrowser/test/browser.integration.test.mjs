import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { Session } from '../lib/session.mjs';
const binary = process.env.CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();

test('browser navigation, extraction, refs, wait and screenshot', { skip: !fs.existsSync(binary) ? 'Chromium not installed' : false, timeout: 60000 }, async () => {
  const server = http.createServer((req, res) => res.end('<title>Fixture</title><main><h1>Example</h1><p>Local fixture text.</p><a href="/next">Next</a><input placeholder="Search"></main>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const session = new Session({ policy: { allowPrivateNetworks: true } });
  try {
    const opened = await session.act({ op: 'open', url: `http://127.0.0.1:${server.address().port}` });
    assert.ok(opened.snapshot);
    const oldRef = opened.snapshot.boxes[0].ref;
    assert.match((await session.act({ op: 'extract', format: 'markdown' })).data.content, /Example/);
    assert.match((await session.act({ op: 'extract', format: 'links' })).data.links[0].url, /\/next$/);
    const snap = await session.act({ op: 'wait', selector: 'h1', timeoutMs: 2000 });
    assert.ok(!snap.snapshot.boxes.some(b => b.ref === oldRef));
    assert.equal((await session.act({ op: 'click', ref: oldRef })).blocked, true);
    assert.equal((await session.act({ op: 'screenshot' })).data.mimeType, 'image/png');
  } finally { await session.shutdown(); await new Promise(resolve => server.close(resolve)); }
});
