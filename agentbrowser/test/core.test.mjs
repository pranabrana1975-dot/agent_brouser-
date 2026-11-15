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
