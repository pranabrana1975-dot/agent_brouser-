// metrics.mjs — Prometheus observability registry + per-session proxy sanitizer.

import { isPrivateHostname } from './policy.mjs';

const ACTION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const ALLOWED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

function escLabel(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function formatLabels(labels = {}) {
  const entries = Object.entries(labels).filter(([, v]) => v !== undefined && v !== null);
  if (!entries.length) return '';
  return '{' + entries.map(([k, v]) => `${k}="${escLabel(v)}"`).join(',') + '}';
}

export function normalizeRouteLabel(pathname) {
  const p = String(pathname || '/');
  if (p.startsWith('/api/sessions/')) return '/api/sessions/:id';
  if (p.startsWith('/api/downloads/')) return '/api/downloads/:id';
  if (p.startsWith('/api/workflows/')) return '/api/workflows/:name';
  if (p === '/dashboard/') return '/dashboard';
  const known = new Set([
    '/api/health', '/api/tools', '/api/sessions', '/api/state', '/api/events',
    '/api/devtools', '/api/network', '/api/console', '/api/perf', '/api/audit',
    '/api/security', '/api/shot.jpg', '/api/act', '/api/takeover', '/api/tab',
    '/api/task', '/api/policy', '/api/approval', '/api/pause', '/api/reset',
    '/api/storage', '/api/downloads', '/api/workflows', '/api/metrics',
    '/metrics', '/mcp', '/dashboard',
  ]);
  return known.has(p) ? p : '/other';
}

export class MetricsRegistry {
  constructor() {
    this.startedAt = Date.now();
    this.httpRequests = new Map();       // "method|route|status" -> count
    this.actionCounts = new Map();       // "op|status" -> count
    this.actionHist = new Map();         // op -> { buckets: number[], sum: number, count: number }
    this.approvalCounts = { allowed: 0, denied: 0, timeout: 0 };
    this.sessionsCreated = 0;
    this.snapshotTokens = 0;
    this.snapshotsTotal = 0;
    this.batchRuns = 0;
    this.workflowReplays = 0;
    this.takeoverEvents = 0;
  }

  recordHttp(method, pathname, status) {
    const m = String(method || 'GET').toUpperCase();
    const route = normalizeRouteLabel(pathname);
    const code = String(Number(status) || 500);
    const key = `${m}|${route}|${code}`;
    this.httpRequests.set(key, (this.httpRequests.get(key) || 0) + 1);
  }

  recordAction(op, durationMs, ok = true) {
    const safeOp = String(op || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'unknown';
    const status = ok ? 'ok' : 'error';
    const cKey = `${safeOp}|${status}`;
    this.actionCounts.set(cKey, (this.actionCounts.get(cKey) || 0) + 1);

    const seconds = Math.max(0, Number(durationMs || 0) / 1000);
    let h = this.actionHist.get(safeOp);
    if (!h) {
      h = { buckets: Array(ACTION_BUCKETS.length).fill(0), sum: 0, count: 0 };
      this.actionHist.set(safeOp, h);
    }
    h.count += 1;
    h.sum += seconds;
    for (let i = 0; i < ACTION_BUCKETS.length; i++) {
      if (seconds <= ACTION_BUCKETS[i]) h.buckets[i] += 1;
    }
  }

  recordApproval(decision) {
    if (decision === 'allowed' || decision === 'denied' || decision === 'timeout') {
      this.approvalCounts[decision] += 1;
    }
  }

  recordSnapshot(tokens = 0) {
    this.snapshotsTotal += 1;
    if (Number.isFinite(tokens) && tokens > 0) this.snapshotTokens += Math.trunc(tokens);
  }

  recordSessionCreated() {
    this.sessionsCreated += 1;
  }

  recordBatch() {
    this.batchRuns += 1;
  }

  recordWorkflowReplay() {
    this.workflowReplays += 1;
  }

  recordTakeover() {
    this.takeoverEvents += 1;
  }

  summary({ manager = null, sseClients = 0 } = {}) {
    const mem = process.memoryUsage();
    const sessions = manager ? manager.list() : [];
    const pendingApprovals = sessions.reduce((n, s) => n + (Number(s.pending) || 0), 0);
    let totalActions = 0;
    let errorActions = 0;
    let totalLatencySec = 0;
    const byOp = {};
    for (const [key, count] of this.actionCounts.entries()) {
      const [op, status] = key.split('|');
      totalActions += count;
      if (status === 'error') errorActions += count;
      byOp[op] = byOp[op] || { ok: 0, error: 0, avgMs: 0 };
      byOp[op][status] = count;
    }
    for (const [op, h] of this.actionHist.entries()) {
      totalLatencySec += h.sum;
      if (byOp[op] && h.count > 0) {
        byOp[op].avgMs = Math.round((h.sum / h.count) * 1000);
      }
    }
    return {
      uptimeSeconds: Math.round(((Date.now() - this.startedAt) / 1000) * 100) / 100,
      browserReady: manager ? Boolean(manager.isBrowserReady()) : false,
      engine: manager ? manager.engineLabel() : 'unknown',
      activeSessions: sessions.length,
      sessionsCreatedTotal: this.sessionsCreated,
      sseClients,
      pendingApprovals,
      actionsTotal: totalActions,
      actionErrorsTotal: errorActions,
      errorRate: totalActions > 0 ? Math.round((errorActions / totalActions) * 10000) / 10000 : 0,
      avgActionMs: totalActions > 0 ? Math.round((totalLatencySec / totalActions) * 1000) : 0,
      snapshotsTotal: this.snapshotsTotal,
      snapshotTokensTotal: this.snapshotTokens,
      approvals: { ...this.approvalCounts },
      batchRuns: this.batchRuns,
      workflowReplays: this.workflowReplays,
      takeoverEvents: this.takeoverEvents,
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
      },
      byOp,
    };
  }

  renderPrometheus({ manager = null, sseClients = 0 } = {}) {
    const s = this.summary({ manager, sseClients });
    const lines = [];
    const emitGauge = (name, help, value, labels) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name}${formatLabels(labels)} ${value}`);
    };
    const emitCounter = (name, help, value, labels) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name}${formatLabels(labels)} ${value}`);
    };

    emitGauge('agentbrowser_up', 'Whether the AgentBrowser control plane is up.', 1);
    emitGauge('agentbrowser_uptime_seconds', 'Control plane uptime in seconds.', s.uptimeSeconds);
    emitGauge('agentbrowser_browser_ready', 'Whether the shared Chromium browser process is connected.', s.browserReady ? 1 : 0);
    emitGauge('agentbrowser_sessions_active', 'Currently open isolated browser sessions.', s.activeSessions);
    emitCounter('agentbrowser_sessions_created_total', 'Total browser sessions created since start.', s.sessionsCreatedTotal);
    emitGauge('agentbrowser_sse_clients_active', 'Currently connected SSE supervisor streams.', s.sseClients);
    emitGauge('agentbrowser_approvals_pending', 'Currently pending human-in-the-loop approvals.', s.pendingApprovals);
    emitCounter('agentbrowser_snapshots_total', 'Total Agent Document snapshots captured.', s.snapshotsTotal);
    emitCounter('agentbrowser_snapshot_tokens_total', 'Estimated total snapshot tokens emitted.', s.snapshotTokensTotal);
    emitCounter('agentbrowser_batch_runs_total', 'Total browser_batch executions.', s.batchRuns);
    emitCounter('agentbrowser_workflow_replays_total', 'Total workflow replay runs.', s.workflowReplays);
    emitCounter('agentbrowser_takeover_events_total', 'Total human takeover input events.', s.takeoverEvents);

    lines.push('# HELP agentbrowser_approvals_total Total human approval decisions by outcome.');
    lines.push('# TYPE agentbrowser_approvals_total counter');
    for (const [decision, count] of Object.entries(this.approvalCounts)) {
      lines.push(`agentbrowser_approvals_total${formatLabels({ decision })} ${count}`);
    }

    lines.push('# HELP agentbrowser_http_requests_total Total HTTP control plane requests.');
    lines.push('# TYPE agentbrowser_http_requests_total counter');
    for (const [key, count] of this.httpRequests.entries()) {
      const [method, route, status] = key.split('|');
      lines.push(`agentbrowser_http_requests_total${formatLabels({ method, route, status })} ${count}`);
    }

    lines.push('# HELP agentbrowser_actions_total Total browser actions executed by op and status.');
    lines.push('# TYPE agentbrowser_actions_total counter');
    for (const [key, count] of this.actionCounts.entries()) {
      const [op, status] = key.split('|');
      lines.push(`agentbrowser_actions_total${formatLabels({ op, status })} ${count}`);
    }

    lines.push('# HELP agentbrowser_action_duration_seconds Action execution latency histogram in seconds.');
    lines.push('# TYPE agentbrowser_action_duration_seconds histogram');
    for (const [op, h] of this.actionHist.entries()) {
      for (let i = 0; i < ACTION_BUCKETS.length; i++) {
        lines.push(`agentbrowser_action_duration_seconds_bucket${formatLabels({ op, le: ACTION_BUCKETS[i] })} ${h.buckets[i]}`);
      }
      lines.push(`agentbrowser_action_duration_seconds_bucket${formatLabels({ op, le: '+Inf' })} ${h.count}`);
      lines.push(`agentbrowser_action_duration_seconds_sum${formatLabels({ op })} ${Math.round(h.sum * 1e6) / 1e6}`);
      lines.push(`agentbrowser_action_duration_seconds_count${formatLabels({ op })} ${h.count}`);
    }

    emitGauge('process_resident_memory_bytes', 'Resident memory size in bytes.', s.memory.rssBytes);
    emitGauge('process_heap_used_bytes', 'V8 heap used in bytes.', s.memory.heapUsedBytes);
    emitGauge('process_heap_total_bytes', 'V8 heap total in bytes.', s.memory.heapTotalBytes);

    return lines.join('\n') + '\n';
  }
}

// ---------- Per-session proxy parser, validator & secret redactor ----------
export function normalizeProxyConfig(input, { allowPrivate = false } = {}) {
  if (input === undefined || input === null || input === '') return null;

  let rawServer = '';
  let username;
  let password;
  let bypass;

  if (typeof input === 'string') {
    rawServer = input.trim();
    if (!rawServer) return null;
  } else if (typeof input === 'object' && !Array.isArray(input)) {
    rawServer = String(input.server || '').trim();
    if (!rawServer) {
      const err = new Error('proxy.server URL is required');
      err.status = 400;
      throw err;
    }
    if (input.username !== undefined) username = String(input.username);
    if (input.password !== undefined) password = String(input.password);
    if (input.bypass !== undefined) bypass = String(input.bypass).trim().slice(0, 512);
  } else {
    const err = new Error('proxy must be a URL string or { server, username?, password?, bypass? } object');
    err.status = 400;
    throw err;
  }

  let parsed;
  try {
    parsed = new URL(rawServer);
  } catch {
    const err = new Error('invalid proxy server URL (expected http://, https://, socks5://, or socks5h://)');
    err.status = 400;
    throw err;
  }

  if (!ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    const err = new Error(`unsupported proxy protocol "${parsed.protocol}" (use http, https, socks5, or socks5h)`);
    err.status = 400;
    throw err;
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) {
    const err = new Error('invalid proxy hostname');
    err.status = 400;
    throw err;
  }

  if (!allowPrivate && isPrivateHostname(host)) {
    const err = new Error(`private or loopback proxy host blocked by policy: ${host} (enable allowPrivateNetworks to allow)`);
    err.status = 400;
    throw err;
  }

  // Extract inline URL credentials into Playwright's separate username/password fields
  // so the server string itself never carries raw secrets.
  if (parsed.username && username === undefined) username = decodeURIComponent(parsed.username);
  if (parsed.password && password === undefined) password = decodeURIComponent(parsed.password);
  parsed.username = '';
  parsed.password = '';

  const server = `${parsed.protocol}//${parsed.host}`;
  const out = { server };
  if (username) out.username = username;
  if (password) out.password = password;
  if (bypass) out.bypass = bypass;
  return out;
}

export function redactProxy(proxy) {
  if (!proxy || typeof proxy !== 'object') return null;
  return {
    server: proxy.server,
    ...(proxy.bypass ? { bypass: proxy.bypass } : {}),
    authenticated: Boolean(proxy.username || proxy.password),
  };
}
