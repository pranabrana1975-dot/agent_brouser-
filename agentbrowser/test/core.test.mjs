import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Policy } from '../lib/policy.mjs';
import { AgentBrowser } from '../sdk.mjs';
import { tools } from '../tools.mjs';

test('host policy validates protocol and domain boundaries', () => {
  const p = new Policy(); p.allowedHosts = ['example.com'];
  assert.equal(p.hostAllowed('https://example.com').ok, true);
  assert.equal(p.hostAllowed('https://a.example.com').ok, true);
  assert.equal(p.hostAllowed('https://notexample.com').ok, false);
  assert.equal(p.hostAllowed('file:///tmp/foo').ok, false);
  assert.equal(p.hostAllowed('javascript:alert(1)').ok, false);
});
test('SDK reports action failures instead of stale snapshots', async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: { error: 'failed to click' } }) });
  try { await assert.rejects(new AgentBrowser().click('e1'), /failed to click/); }
  finally { globalThis.fetch = old; }
});
test('MCP advertises tools over stdio without an HTTP server', async () => {
  const child = spawn(process.execPath, ['mcp.mjs'], { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
  const output = [];
  child.stdout.on('data', x => output.push(x));
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0);
  const responses = Buffer.concat(output).toString().trim().split('\n').map(JSON.parse);
  assert.equal(responses[0].result.serverInfo.name, 'agentbrowser');
  assert.deepEqual(responses[1].result.tools, tools);
});

test('MCP rejects invalid tool arguments before contacting the browser', async () => {
  const child = spawn(process.execPath, ['mcp.mjs'], { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
  const output = [];
  child.stdout.on('data', x => output.push(x));
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'browser_open', arguments: {} } }) + '\n');
  await new Promise(resolve => child.on('close', resolve));
  const result = JSON.parse(Buffer.concat(output).toString()).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Missing argument: url/);
});

test('MCP bridges extraction and screenshots to HTTP with token', async () => {
  const http = await import('node:http');
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    let body = ''; for await (const chunk of req) body += chunk;
    const action = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: { data: action.op === 'screenshot' ? { mimeType: 'image/png', base64: 'aGVsbG8=' } : { format: action.format, content: 'hello' } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, ['mcp.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, AGENT_BROWSER_URL: `http://127.0.0.1:${server.address().port}`, AGENT_BROWSER_TOKEN: 'test-token' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    child.stdout.on('data', x => output.push(x));
    child.stdin.end([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_extract', arguments: { format: 'markdown' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_screenshot', arguments: {} } },
    ].map(JSON.stringify).join('\n') + '\n');
    assert.equal(await new Promise(resolve => child.on('close', resolve)), 0);
    const responses = Buffer.concat(output).toString().trim().split('\n').map(JSON.parse);
    const get = id => responses.find(r => r.id === id).result.content[0];
    assert.equal(JSON.parse(get(1).text).content, 'hello');
    assert.deepEqual(get(2), { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
