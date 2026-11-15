// mcp.mjs — MCP stdio bridge (stdout is strictly newline-delimited JSON-RPC).
//
// Two modes:
//   1. Remote mode (default): forwards tool calls to a running HTTP control plane
//      configured via AGENT_BROWSER_URL / AGENT_BROWSER_TOKEN / AGENT_BROWSER_SESSION.
//   2. Embedded mode (`node mcp.mjs --embedded` or AGENT_BROWSER_EMBEDDED=1):
//      manages its own headless Chromium session directly with zero extra server setup.

import readline from 'node:readline';
import { AgentBrowser } from './sdk.mjs';
import { envFlag } from './lib/policy.mjs';
import { SessionManager } from './lib/manager.mjs';
import {
  createSdkExecutor,
  createSessionExecutor,
  dispatchMcpMessage,
} from './lib/mcp-handler.mjs';

const embedded = process.argv.includes('--embedded') || envFlag('AGENT_BROWSER_EMBEDDED', false);
const sessionId = process.env.AGENT_BROWSER_SESSION || 'default';

let manager = null;
let invokeTool;

if (embedded) {
  manager = new SessionManager({ maxSessions: 2, idleTtlMs: 0 });
  invokeTool = createSessionExecutor(() => manager.getOrCreate(sessionId));
} else {
  const browser = new AgentBrowser(process.env.AGENT_BROWSER_URL || 'http://127.0.0.1:3000', {
    token: process.env.AGENT_BROWSER_TOKEN,
    sessionId: process.env.AGENT_BROWSER_SESSION || '',
  });
  invokeTool = createSdkExecutor(browser);
}

const send = (message) => {
  if (message !== null && message !== undefined) {
    process.stdout.write(JSON.stringify(message) + '\n');
  }
};

const inFlight = new Set();
let stdinClosed = false;
let shuttingDown = false;

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (manager) {
    try { await manager.shutdown(); } catch {}
  }
  process.exit(code);
}

function maybeFinish() {
  if (stdinClosed && inFlight.size === 0 && manager) {
    void shutdown(0);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const errJob = Promise.resolve()
      .then(() => send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
      .finally(() => { inFlight.delete(errJob); maybeFinish(); });
    inFlight.add(errJob);
    return;
  }
  const job = dispatchMcpMessage(parsed, invokeTool)
    .then(send)
    .catch((e) => {
      send({ jsonrpc: '2.0', id: parsed?.id ?? null, error: { code: -32603, message: String(e.message || e) } });
    })
    .finally(() => {
      inFlight.delete(job);
      maybeFinish();
    });
  inFlight.add(job);
});

rl.on('close', () => {
  stdinClosed = true;
  maybeFinish();
});

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
