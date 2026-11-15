import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  Policy,
  isPrivateOrReservedIp,
  isLoopbackHost,
  matchHostPattern,
  normalizeHostList,
} from '../lib/policy.mjs';
import { AgentBrowser } from '../sdk.mjs';
import { verifyBearerToken, assertSafeBind } from '../server.mjs';
import { tools } from '../tools.mjs';

test('host policy validates protocol, credentials, and domain boundaries', () => {
  const p = new Policy();
  p.allowedHosts = ['example.com'];
  assert.equal(p.hostAllowed('about:blank').ok, true);
  assert.equal(p.hostAllowed('https://example.com').ok, true);
  assert.equal(p.hostAllowed('https://a.example.com').ok, true);
  assert.equal(p.hostAllowed('https://notexample.com').ok, false);
  assert.equal(p.hostAllowed('https://user:pass@example.com/').ok, false);
  assert.equal(p.hostAllowed('file:///tmp/foo').ok, false);
  assert.equal(p.hostAllowed('javascript:alert(1)').ok, false);
  assert.equal(p.hostAllowed('data:text/html,<h1>x</h1>').ok, false);
});

test('host policy blocks SSRF targets by default and honors allowPrivateNetworks', async () => {
  const p = new Policy({ allowPrivateNetworks: false });
  const blockedUrls = [
    'http://localhost:3000/api/state',
    'http://sub.localhost/',
    'http://127.0.0.1:3000/',
    'http://127.12.34.56/',
    'http://2130706433/',                  // decimal 127.0.0.1
    'http://0x7f000001/',                  // hex 127.0.0.1
    'http://0177.0.0.1/',                  // octal 127.0.0.1
    'http://0.0.0.0/',
    'http://10.0.0.5/',
    'http://100.64.1.2/',                  // CGNAT
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://192.168.1.10/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/',
    'http://printer.local/',
    'http://service.internal/',
    'http://[::1]:3000/',
    'http://[::]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
    'http://[64:ff9b::10.0.0.1]/',
    'http://[2002:7f00:0001::1]/',
  ];
  for (const url of blockedUrls) {
    assert.equal(p.hostAllowed(url).ok, false, `expected blocked: ${url}`);
  }

  // Public IPs and domains remain allowed.
  assert.equal(p.hostAllowed('http://172.32.0.1/').ok, true);
  assert.equal(p.hostAllowed('https://93.184.216.34/').ok, true);
  assert.equal(p.hostAllowed('https://[2606:2800:220:1:248:1893:25c8:1946]/').ok, true);
  assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);
  assert.equal(isPrivateOrReservedIp('fe80::1%eth0'), true);

  // DNS resolution pointing to private IP is blocked.
  const rebind = await p.resolveAllowed('https://rebind.example.org/', {
    lookup: async () => [{ address: '169.254.169.254', family: 4 }],
  });
  assert.equal(rebind.ok, false);

  const pubDns = await p.resolveAllowed('https://public.example.org/', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.equal(pubDns.ok, true);

  // Opting in allows local targets for trusted dev/test use.
  p.update({ allowPrivateNetworks: true });
  assert.equal(p.hostAllowed('http://127.0.0.1:8080/').ok, true);
  assert.equal(p.hostAllowed('http://localhost:8080/').ok, true);
});

test('label-aware wildcard patterns block bank domains without breaking databank.org', () => {
  const p = new Policy();
  assert.equal(p.hostAllowed('https://chase.bank/login').ok, false);
  assert.equal(p.hostAllowed('https://bank.com/').ok, false);
  assert.equal(p.hostAllowed('https://online.bank.co.in/').ok, false);
  assert.equal(p.hostAllowed('https://accounts.google.com/').ok, false);
  assert.equal(p.hostAllowed('https://databank.worldbank.org/').ok, true);
  assert.equal(p.hostAllowed('https://www.google.com/').ok, true);
  assert.equal(matchHostPattern('my-paypal-check.com', '*paypal*.com'), true);
  assert.equal(matchHostPattern('evil.com', '*.example.com'), false);

  // normalizeHostList accepts both string and string[].
  assert.deepEqual(normalizeHostList('A.com, b.com\na.com '), ['a.com', 'b.com']);
  assert.deepEqual(normalizeHostList(['Example.ORG.', ' foo.bar ']), ['example.org', 'foo.bar']);
  assert.equal(normalizeHostList(123), null);
});

test('approval heuristics avoid search/article false positives and catch split submit + Bangla rules', () => {
  const p = new Policy();

  // Search box queries with risky words must NOT require approval.
  assert.equal(
    p.inspect({ op: 'type', role: 'searchbox', name: 'Search the web', text: 'how to delete a git branch', submit: true }).requireApproval,
    false,
  );
  assert.equal(
    p.inspect({ op: 'type', role: 'textbox', name: 'অনুসন্ধান', text: 'buy best laptop', submit: true }).requireApproval,
    false,
  );

  // Clicking a blog post URL `/blog/post/123` or a "How to delete..." article link must NOT block.
  assert.equal(
    p.inspect({ op: 'click', role: 'link', name: 'Release notes 2026', href: 'https://example.com/blog/post/123' }).requireApproval,
    false,
  );
  assert.equal(
    p.inspect({ op: 'click', role: 'link', name: 'How to delete remote branches', href: 'https://docs.example.com/git' }).requireApproval,
    false,
  );

  // Real risky buttons (English & Bangla) DO require approval.
  assert.equal(p.inspect({ op: 'click', role: 'button', name: 'Delete repository' }).requireApproval, true);
  assert.equal(p.inspect({ op: 'click', role: 'button', name: 'Place order' }).requireApproval, true);
  assert.equal(p.inspect({ op: 'click', role: 'button', name: 'Post comment' }).requireApproval, true);
  assert.equal(p.inspect({ op: 'click', role: 'button', name: 'অ্যাকাউন্ট বন্ধ' }).requireApproval, true);
  assert.equal(p.inspect({ op: 'click', role: 'button', name: 'অর্ডার করুন' }).requireApproval, true);
  assert.equal(p.inspect({ op: 'click', role: 'link', name: 'Continue', href: '/account/delete' }).requireApproval, true);

  // Split type(submit:false) followed by generic click("Submit") is caught via dirtyRisk / hasPassword.
  const dirtyRisk = p.matchRedZone('Please transfer $500 immediately');
  assert.ok(dirtyRisk);
  assert.equal(p.inspect({ op: 'click', role: 'button', name: 'Submit', dirtyRisk }).requireApproval, true);
  assert.equal(p.inspect({ op: 'click', role: 'button', name: 'Sign in', hasPassword: true }).requireApproval, true);
  // Navigating away via a non-submit link when password was typed does NOT block.
  assert.equal(p.inspect({ op: 'click', role: 'link', name: 'Privacy Policy', href: '/privacy', hasPassword: true }).requireApproval, false);
});

test('loopback binding and constant-time bearer verification', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.0.1.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('::'), false);
  assert.equal(isLoopbackHost('192.168.1.5'), false);

  assert.doesNotThrow(() => assertSafeBind('[::1]', ''));
  assert.throws(() => assertSafeBind('0.0.0.0', ''), /AGENT_BROWSER_TOKEN/);
  assert.throws(() => assertSafeBind('::', ''), /AGENT_BROWSER_TOKEN/);
  assert.doesNotThrow(() => assertSafeBind('0.0.0.0', 'secret-token'));

  assert.equal(verifyBearerToken('Bearer s3cr3t', 's3cr3t'), true);
  assert.equal(verifyBearerToken('Bearer wrong', 's3cr3t'), false);
  assert.equal(verifyBearerToken('Basic s3cr3t', 's3cr3t'), false);
  assert.equal(verifyBearerToken(undefined, 's3cr3t'), false);
  assert.equal(verifyBearerToken(undefined, ''), true);
});

test('SDK reports action failures, non-JSON errors, and session headers cleanly', async () => {
  const seenHeaders = [];
  const client = new AgentBrowser('http://127.0.0.1:3000', {
    token: 'tok-1',
    sessionId: 'agent-a',
    fetch: async (_url, init) => {
      seenHeaders.push(init.headers);
      return { ok: true, json: async () => ({ result: { error: 'failed to click' } }) };
    },
  });
  await assert.rejects(client.click('e1'), /failed to click/);
  assert.equal(seenHeaders[0].authorization, 'Bearer tok-1');
  assert.equal(seenHeaders[0]['x-session-id'], 'agent-a');

  const badGateway = new AgentBrowser('http://127.0.0.1:3000', {
    fetch: async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
      text: async () => 'Bad Gateway',
    }),
  });
  await assert.rejects(badGateway.health(), /Bad Gateway/);
});

test('MCP advertises tools and handles JSON-RPC errors over stdio without an HTTP server', async () => {
  const child = spawn(process.execPath, ['mcp.mjs'], {
    cwd: new URL('..', import.meta.url),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (x) => output.push(x));
  const messages = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), // notification -> no output
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'unknown/method' }),
    '{broken-json',
  ];
  child.stdin.end(messages.join('\n') + '\n');
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  const responses = Buffer.concat(output).toString().trim().split('\n').map(JSON.parse);
  assert.equal(responses.length, 5);
  assert.equal(responses[0].result.serverInfo.name, 'agentbrowser');
  assert.deepEqual(responses[1].result.tools, tools);
  assert.deepEqual(responses[2].result, {});
  assert.equal(responses[3].error.code, -32601);
  assert.equal(responses[4].error.code, -32700);
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
