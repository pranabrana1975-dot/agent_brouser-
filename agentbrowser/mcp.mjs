// MCP stdio bridge. Start the HTTP service separately; stdout is JSON-RPC only.
import readline from 'node:readline';
import { AgentBrowser } from './sdk.mjs';
import { tools } from './tools.mjs';

const browser = new AgentBrowser(process.env.AGENT_BROWSER_URL || 'http://127.0.0.1:3000', { token: process.env.AGENT_BROWSER_TOKEN });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
async function invoke(name, a) {
  switch (name) {
    case 'browser_open': return browser.open(a.url);
    case 'browser_snapshot': return browser.snapshot();
    case 'browser_click': return browser.click(a.ref);
    case 'browser_type': return browser.type(a.ref, a.text, { submit: a.submit });
    case 'browser_scroll': return browser.scroll(a.dy);
    case 'browser_navigate': return browser.nav(a.op);
    case 'browser_tabs': return browser.tabs(a.op, a.id);
    case 'browser_task': return browser.task(a.goal);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}
async function handle(req) {
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return send({ jsonrpc: '2.0', id: req?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
  }
  if (req.id === undefined) return; // notifications have no response
  let result;
  switch (req.method) {
    case 'initialize':
      result = { protocolVersion: ['2024-11-05', '2025-03-26'].includes(req.params?.protocolVersion) ? req.params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'agentbrowser', version: '1.0.0' } }; break;
    case 'ping': result = {}; break;
    case 'tools/list': result = { tools }; break;
    case 'tools/call': {
      try {
        const value = await invoke(req.params?.name, req.params?.arguments || {});
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch (e) { result = { isError: true, content: [{ type: 'text', text: e.message }] }; }
      break;
    }
    default: return send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } });
  }
  send({ jsonrpc: '2.0', id: req.id, result });
}
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  try { void handle(JSON.parse(line)); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
});
