// mcp-handler.mjs — Shared Model Context Protocol (JSON-RPC 2.0) dispatcher.
// Used by both the stdio bridge (mcp.mjs) and the Streamable HTTP endpoint (/mcp).

import { tools } from '../tools.mjs';
import { runTask } from './agent.mjs';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
export const SERVER_INFO = { name: 'agentbrowser', version: '1.1.0' };

function matchesSchemaSpec(spec, value) {
  if (!spec || typeof spec !== 'object') return true;
  if (Array.isArray(spec.oneOf)) {
    return spec.oneOf.some((branch) => matchesSchemaSpec(branch, value));
  }
  if (spec.type === 'integer') {
    if (!Number.isInteger(value)) return false;
  } else if (spec.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  } else if (spec.type === 'array') {
    if (!Array.isArray(value)) return false;
    if (spec.minItems !== undefined && value.length < spec.minItems) return false;
    if (spec.maxItems !== undefined && value.length > spec.maxItems) return false;
    if (spec.items && !value.every((item) => matchesSchemaSpec(spec.items, item))) return false;
  } else if (spec.type && typeof value !== spec.type) {
    return false;
  }
  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) return false;
  if (spec.minimum !== undefined && value < spec.minimum) return false;
  if (spec.maximum !== undefined && value > spec.maximum) return false;
  return true;
}

export function validateToolCall(name, args) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Arguments must be an object');
  }
  const schema = tool.inputSchema;
  for (const key of schema.required || []) {
    if (!(key in args) || args[key] === undefined) {
      throw new Error(`Missing argument: ${key}`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const spec = schema.properties?.[key];
    if (!spec) throw new Error(`Unknown argument: ${key}`);
    if (!matchesSchemaSpec(spec, value)) throw new Error(`Invalid argument: ${key}`);
  }
  return tool;
}

function textContent(text) {
  return { content: [{ type: 'text', text: String(text ?? '') }] };
}

function snapContent(snap, { full = false } = {}) {
  if (!snap) return textContent('(empty snapshot)');
  if (full) return textContent(JSON.stringify(snap));
  return textContent(snap.text || JSON.stringify(snap));
}

function articleContent(article) {
  const header = [
    `[url] ${article?.url || ''}`,
    `[title] ${article?.title || ''}`,
    article?.truncated ? `[truncated] showing ${article.text?.length || 0} of ${article.length} chars` : '',
  ].filter(Boolean).join('\n');
  return textContent(`${header}\n\n${article?.text || ''}`.trim());
}

function shotContent(shot) {
  const b64 = shot?.base64 ?? shot?.data ?? '';
  const content = [{ type: 'image', data: b64, mimeType: shot?.mimeType || 'image/png' }];
  if (shot?.url || shot?.title) {
    content.push({ type: 'text', text: `[url] ${shot.url || ''}\n[title] ${shot.title || ''}`.trim() });
  }
  return { content };
}

// Build a tool executor backed by the HTTP SDK client.
export function createSdkExecutor(browser) {
  return async function invokeTool(name, a = {}) {
    validateToolCall(name, a);
    switch (name) {
      case 'browser_open':
        return snapContent(await browser.open(a.url, { compact: true }));
      case 'browser_snapshot': {
        const full = Boolean(a.full);
        return snapContent(await browser.snapshot({ full, compact: !full }), { full });
      }
      case 'browser_click':
        return snapContent(await browser.click(a.ref, { button: a.button, doubleClick: a.doubleClick, compact: true }));
      case 'browser_type':
        return snapContent(await browser.type(a.ref, a.text, { submit: a.submit, clear: a.clear, secret: a.secret, compact: true }));
      case 'browser_select':
        return snapContent(await browser.select(a.ref, a.value, { compact: true }));
      case 'browser_press':
        return snapContent(await browser.press(a.key, { ref: a.ref, compact: true }));
      case 'browser_hover':
        return snapContent(await browser.hover(a.ref, { compact: true }));
      case 'browser_scroll':
        return snapContent(await browser.scroll(a.dy, { dx: a.dx, ref: a.ref, compact: true }));
      case 'browser_wait':
        return snapContent(await browser.wait({ text: a.text, selector: a.selector, url: a.url, state: a.state, timeoutMs: a.timeoutMs, compact: true }));
      case 'browser_wait_for':
        return snapContent(await browser.wait({ selector: a.selector, timeoutMs: a.timeoutMs, compact: true }));
      case 'browser_extract':
        return textContent(JSON.stringify(await browser.extract(a.format, a.maxChars)));
      case 'browser_read':
        return articleContent(await browser.read({ maxChars: a.maxChars }));
      case 'browser_screenshot':
        return shotContent(await browser.screenshot({ fullPage: a.fullPage, type: a.type, encoding: 'object' }));
      case 'browser_upload':
        return snapContent(await browser.upload(a.ref, a.paths, { compact: true }));
      case 'browser_navigate':
        return snapContent(await browser.nav(a.op, { compact: true }));
      case 'browser_tabs':
        return textContent(JSON.stringify(await browser.tabs(a.op, a.id, a.url)));
      case 'browser_task':
        return textContent(JSON.stringify(await browser.task(a.goal)));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };
}

// Build a tool executor backed directly by an in-process Session (used by /mcp and `mcp.mjs --embedded`).
export function createSessionExecutor(getSession) {
  const unwrap = async (session, action) => {
    const out = await session.act(action);
    if (out?.blocked || out?.error) throw new Error(out.reason || out.error);
    return out;
  };

  return async function invokeTool(name, a = {}) {
    validateToolCall(name, a);
    const session = typeof getSession === 'function' ? await getSession() : getSession;
    switch (name) {
      case 'browser_open':
        return snapContent((await unwrap(session, { op: 'open', url: a.url, compact: true })).snapshot);
      case 'browser_snapshot': {
        const full = Boolean(a.full);
        return snapContent((await unwrap(session, { op: 'snapshot', full, compact: !full })).snapshot, { full });
      }
      case 'browser_click':
        return snapContent((await unwrap(session, { op: 'click', ref: a.ref, button: a.button, doubleClick: a.doubleClick, compact: true })).snapshot);
      case 'browser_type':
        return snapContent((await unwrap(session, { op: 'type', ref: a.ref, text: a.text, submit: a.submit, clear: a.clear, secret: a.secret, compact: true })).snapshot);
      case 'browser_select':
        return snapContent((await unwrap(session, { op: 'select', ref: a.ref, value: a.value, compact: true })).snapshot);
      case 'browser_press':
        return snapContent((await unwrap(session, { op: 'press', key: a.key, ref: a.ref, compact: true })).snapshot);
      case 'browser_hover':
        return snapContent((await unwrap(session, { op: 'hover', ref: a.ref, compact: true })).snapshot);
      case 'browser_scroll':
        return snapContent((await unwrap(session, { op: 'scroll', dy: a.dy, dx: a.dx, ref: a.ref, compact: true })).snapshot);
      case 'browser_wait':
        return snapContent((await unwrap(session, { op: 'wait', text: a.text, selector: a.selector, url: a.url, state: a.state, timeoutMs: a.timeoutMs, compact: true })).snapshot);
      case 'browser_wait_for':
        return snapContent((await unwrap(session, { op: 'wait', selector: a.selector, timeoutMs: a.timeoutMs, compact: true })).snapshot);
      case 'browser_extract':
        return textContent(JSON.stringify((await unwrap(session, { op: 'extract', format: a.format, maxChars: a.maxChars })).data));
      case 'browser_read':
        return articleContent((await unwrap(session, { op: 'read', maxChars: a.maxChars })).article);
      case 'browser_screenshot':
        return shotContent((await unwrap(session, { op: 'screenshot', fullPage: a.fullPage, type: a.type })).data);
      case 'browser_upload':
        return snapContent((await unwrap(session, { op: 'upload', ref: a.ref, paths: a.paths, compact: true })).snapshot);
      case 'browser_navigate':
        return snapContent((await unwrap(session, { op: a.op, compact: true })).snapshot);
      case 'browser_tabs': {
        if (a.op === 'list') {
          await session.init();
          return textContent(JSON.stringify(session.tabList()));
        }
        return textContent(JSON.stringify(await session.tabOp(a.op, a.id, a.url)));
      }
      case 'browser_task': {
        const goal = String(a.goal || '').trim();
        if (!goal) throw new Error('goal required');
        if (session.busy) throw new Error('a task is already running in this session');
        const ac = new AbortController();
        session.taskAbort = ac;
        session.busy = (async () => {
          try { return await runTask(session, goal, { signal: ac.signal }); }
          finally { session.busy = null; session.taskAbort = null; }
        })();
        const answer = await session.busy;
        if (!answer?.ok) throw new Error(answer?.error || 'task failed');
        return textContent(JSON.stringify(answer));
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };
}

export async function dispatchMcpMessage(req, invokeTool) {
  if (Array.isArray(req)) {
    if (!req.length) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const items = await Promise.all(req.map((item) => dispatchMcpMessage(item, invokeTool)));
    const replies = items.filter((x) => x !== null);
    return replies.length ? replies : null;
  }

  if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return { jsonrpc: '2.0', id: req?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }

  // Notifications have no `id` and expect no JSON-RPC response.
  if (req.id === undefined) return null;

  switch (req.method) {
    case 'initialize': {
      const requested = req.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-03-26';
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id: req.id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id: req.id, result: { tools } };
    case 'tools/call': {
      const toolName = req.params?.name;
      if (typeof toolName !== 'string' || !toolName) {
        return { jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'Tool name required' } };
      }
      const args = req.params?.arguments ?? {};
      try {
        const result = await invokeTool(toolName, args);
        return { jsonrpc: '2.0', id: req.id, result };
      } catch (e) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: { isError: true, content: [{ type: 'text', text: String(e.message || e) }] },
        };
      }
    }
    default:
      return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  }
}
