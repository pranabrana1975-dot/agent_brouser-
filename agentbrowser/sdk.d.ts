// sdk.d.ts — TypeScript declarations for the zero-dependency AgentBrowser v2.0 SDK.

import type { ExtractFormat, ToolDefinition } from './tools.mjs';

export type KeyModifier = 'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift';
export type MouseButton = 'left' | 'right' | 'middle';
export type DevicePreset = 'desktop' | 'desktop-hd' | 'iphone-15' | 'pixel-8' | 'ipad';
export type NetworkPreset = 'online' | '4g' | 'fast-3g' | 'slow-3g' | 'offline';
export type PdfFormat = 'A4' | 'Letter' | 'Legal' | 'Tabloid' | 'Ledger' | 'A0' | 'A1' | 'A2' | 'A3' | 'A5' | 'A6';

export interface AgentBrowserOptions {
  token?: string;
  sessionId?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
  method?: string;
  timeoutMs?: number;
  sessionId?: string;
  responseType?: 'json' | 'text' | 'buffer';
  signal?: AbortSignal;
}

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
}

export interface RedactedProxy {
  server: string;
  bypass?: string;
  authenticated: boolean;
}

export interface PolicyConfig {
  approvalsEnabled: boolean;
  allowPrivateNetworks: boolean;
  approvalTimeoutMs: number;
  blockedHosts: string[];
  allowedHosts: string[];
}

export interface PolicyPatch {
  approvalsEnabled?: boolean;
  allowPrivateNetworks?: boolean;
  approvalTimeoutMs?: number;
  blockedHosts?: string | string[];
  allowedHosts?: string | string[];
}

export interface ControlOption {
  value: string;
  label: string;
  selected?: boolean;
}

export interface SnapshotBox {
  ref: string;
  role: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  v: boolean;
  frame?: string;
  crossOrigin?: boolean;
  value?: string;
  inputType?: string;
  href?: string;
  disabled?: boolean;
  required?: boolean;
  readonly?: boolean;
  checked?: boolean | 'mixed';
  expanded?: boolean;
  options?: ControlOption[];
}

export interface SnapshotMeta {
  url: string;
  title: string;
  vw: number;
  vh: number;
  scrollY: number;
  docHeight: number;
}

export interface DeltaStats {
  added: number;
  modified: number;
  removed: number;
  unchanged: number;
  toasts: number;
}

export interface Snapshot {
  text: string;
  tokens: number;
  htmlBytes: number;
  truncatedActions: number;
  meta: SnapshotMeta;
  boxes?: SnapshotBox[];
  bodyText?: string;
  textBits?: string[];
  delta?: boolean;
  deltaStats?: DeltaStats;
  savedTokens?: number;
  fullTokens?: number;
}

export interface ClickOptions {
  button?: MouseButton;
  doubleClick?: boolean;
  modifiers?: KeyModifier[];
  delta?: boolean;
  compact?: boolean;
}

export interface DragOptions {
  targetRef?: string;
  dx?: number;
  dy?: number;
  targetX?: number;
  targetY?: number;
  steps?: number;
  delta?: boolean;
  compact?: boolean;
}

export interface TypeOptions {
  submit?: boolean;
  clear?: boolean;
  secret?: boolean;
  delta?: boolean;
  compact?: boolean;
}

export interface BatchStep {
  op:
    | 'open' | 'snapshot' | 'click' | 'dblclick' | 'rightclick' | 'drag'
    | 'type' | 'select' | 'press' | 'hover' | 'scroll' | 'wait' | 'wait_for'
    | 'clipboard' | 'extract' | 'read' | 'screenshot' | 'back' | 'forward'
    | 'reload' | 'navigate';
  [key: string]: unknown;
}

export interface BatchStepResult {
  step: number;
  op: string;
  ok: boolean;
  navigatedTo?: string;
  data?: unknown;
  article?: unknown;
  shot?: { mimeType: string; annotated: boolean };
  error?: string;
}

export interface BatchResult {
  ok: boolean;
  completed: number;
  total: number;
  stoppedEarly: boolean;
  stopReason?: string;
  results: BatchStepResult[];
  snapshot: Snapshot;
}

export interface WorkflowDefinition {
  version: number;
  name: string;
  description: string;
  createdAt?: string;
  updatedAt?: string;
  startUrl: string;
  variables: string[];
  steps: BatchStep[];
}

export interface PlaywrightExportResult {
  name: string;
  filename: string;
  format: 'playwright-test';
  variables: string[];
  code: string;
}

export interface SchemaFieldSpec {
  selector: string;
  attr?: string;
  type?: 'string' | 'number' | 'boolean' | 'url' | 'list';
  multiple?: boolean;
}

export interface ExtractSchema {
  container?: string;
  limit?: number;
  fields: Record<string, string | SchemaFieldSpec>;
}

export interface ExtractOptions {
  maxChars?: number;
  selector?: string;
  schema?: ExtractSchema;
  maxPages?: number;
  nextSelector?: string;
}

export interface ExtractedItem {
  title: string;
  url?: string;
  price?: string;
  summary?: string;
  date?: string;
  author?: string;
  badge?: string;
  image?: string;
  ref?: string;
  _page?: number;
}

export interface ExtractResult {
  format: ExtractFormat;
  url: string;
  title?: string;
  content?: string;
  count?: number;
  items?: Array<ExtractedItem | Record<string, unknown>>;
  data?: Record<string, unknown>;
  links?: Array<{ text: string; url: string; ref?: string }>;
  forms?: Array<{ action: string; method: string; fields: Array<Record<string, unknown>> }>;
  tables?: Array<{ caption?: string; headers: string[]; rowCount: number; rows: Array<Record<string, string> | string[]> }>;
  metadata?: Record<string, unknown>;
  pagesVisited?: number;
  pageUrls?: string[];
  hasMore?: boolean;
  nextPage?: { url: string | null; text: string; ref: string | null } | null;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  type?: 'png' | 'jpeg';
  quality?: number;
  annotate?: boolean;
  encoding?: 'base64' | 'buffer';
}

export interface ScreenshotResult {
  mimeType: 'image/png' | 'image/jpeg';
  base64: string;
  bytes: number;
  annotated: boolean;
  url: string;
  title: string;
  shotVersion?: number;
  shotAt?: number;
}

export interface PdfOptions {
  format?: PdfFormat;
  landscape?: boolean;
  printBackground?: boolean;
  scale?: number;
  pageRanges?: string;
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  save?: boolean;
  filename?: string;
  includeBase64?: boolean;
  encoding?: 'base64' | 'buffer';
}

export interface PdfResult {
  mimeType: 'application/pdf';
  url: string;
  title: string;
  format: PdfFormat;
  landscape: boolean;
  bytes: number;
  pageCount: number;
  sha256: string;
  savedPath: string | null;
  downloadId?: string;
  base64?: string;
  base64Omitted?: boolean;
}

export interface DownloadInspection {
  id: string | null;
  filename: string;
  url: string;
  at: number | null;
  savedPath?: string;
  bytes?: number;
  sha256?: string;
  kind?: string;
  inspected: boolean;
  reason?: string;
  headers?: string[];
  totalRows?: number;
  rowsTruncated?: boolean;
  rows?: Array<Record<string, string>>;
  preview?: string;
  truncated?: boolean;
  jsonType?: string;
  itemCount?: number;
  keys?: string[];
  sample?: unknown[];
  pageCount?: number;
  dimensions?: { width: number; height: number } | null;
}

export interface VisualDiffOptions {
  op?: 'baseline' | 'compare' | 'list' | 'delete';
  name?: string;
  selector?: string;
  fullPage?: boolean;
  threshold?: number;
  maxDiffPercent?: number;
  includeDiffImage?: boolean;
  updateBaseline?: boolean;
  baselineBase64?: string;
  currentBase64?: string;
}

export interface VisualDiffResult {
  name?: string;
  baselineUrl?: string;
  currentUrl?: string;
  passed?: boolean;
  matched?: boolean;
  threshold?: number;
  maxDiffPercent?: number;
  width?: number;
  height?: number;
  sizeChanged?: boolean;
  baselineSize?: { width: number; height: number };
  currentSize?: { width: number; height: number };
  totalPixels?: number;
  diffPixels?: number;
  diffRatio?: number;
  diffPercent?: number;
  boundingBox?: { x: number; y: number; width: number; height: number } | null;
  hotspots?: Array<{ x: number; y: number; width: number; height: number; diffPixels: number; cellDiffPercent: number }>;
  mimeType?: 'image/png';
  diffBytes?: number;
  diffBase64?: string;
  baselines?: Array<{ name: string; url: string; width: number; height: number; bytes: number; capturedAt: string }>;
  bytes?: number;
  capturedAt?: string;
  deleted?: boolean;
}

export interface TaskOptions {
  mode?: 'auto' | 'research' | 'autonomous';
  startUrl?: string;
  fields?: Record<string, string | number | boolean>;
  submitLabel?: string;
  extractFormat?: ExtractFormat;
  schema?: ExtractSchema;
  selector?: string;
  nextSelector?: string;
  maxPages?: number;
  maxSteps?: number;
  maxActions?: number;
  selfHeal?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface TaskAnswer {
  ok: boolean;
  mode?: 'autonomous';
  goal: string;
  query: string;
  sources: Array<{ title: string; url: string }>;
  bullets: string[];
  extractedFrom: string[];
  synthesizedBy: string;
  actionsUsed: number;
  healedCount?: number;
  steps?: Array<{ step: number; thought: string; action: Record<string, unknown>; ok: boolean; verify: string; healed?: Record<string, unknown> }>;
  data?: ExtractResult | null;
  at: string;
  error?: string;
}

export interface TakeoverInput {
  op: 'click' | 'dblclick' | 'rightclick' | 'drag' | 'wheel' | 'type' | 'press' | 'goto' | 'back' | 'forward' | 'reload';
  x?: number;
  y?: number;
  targetX?: number;
  targetY?: number;
  dx?: number;
  dy?: number;
  button?: MouseButton;
  text?: string;
  secret?: boolean;
  submit?: boolean;
  key?: string;
  url?: string;
}

export interface TabSummary {
  id: string;
  url: string;
  host: string;
  title: string;
  active: boolean;
}

export interface PendingApproval {
  id: string;
  reason: string;
  detail: string;
  rule: string;
  at: number;
  expiresAt: number | null;
}

export interface SessionState {
  id: string;
  ready: boolean;
  engine: string;
  activeId: string | null;
  tabs: TabSummary[];
  url: string;
  title: string;
  viewport: { width: number; height: number };
  shotVersion: number;
  shotAt: number;
  snapshot: Snapshot | null;
  log: Array<{ i: number; at: number; kind: string; text: string }>;
  pending: PendingApproval[];
  downloads: Array<Record<string, unknown>>;
  devtools: Record<string, unknown>;
  workflow: { recording: boolean; name?: string; stepCount?: number };
  proxy: RedactedProxy | null;
  stats: { actions: number; snapshots: number; tokens: number; htmlBytes: number; approvals: number; taskRuns: number };
  policy: PolicyConfig;
  agentStatus: string;
  paused: boolean;
  createdAt: number;
  lastActiveAt: number;
}

export interface CreateSessionOptions {
  id?: string;
  eager?: boolean;
  policy?: PolicyPatch;
  viewport?: string | { width: number; height: number };
  locale?: string;
  timezoneId?: string;
  colorScheme?: 'light' | 'dark';
  userAgent?: string;
  proxy?: string | ProxyConfig;
  deltaMode?: boolean;
}

export interface MetricsSummary {
  ok: boolean;
  uptimeSeconds: number;
  browserReady: boolean;
  engine: string;
  activeSessions: number;
  sessionsCreatedTotal: number;
  sseClients: number;
  pendingApprovals: number;
  actionsTotal: number;
  actionErrorsTotal: number;
  errorRate: number;
  avgActionMs: number;
  snapshotsTotal: number;
  snapshotTokensTotal: number;
  approvals: { allowed: number; denied: number; timeout: number };
  batchRuns: number;
  workflowReplays: number;
  takeoverEvents: number;
  memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number };
  byOp: Record<string, { ok: number; error: number; avgMs: number }>;
}

export declare class AgentBrowser {
  base: string;
  token: string;
  sessionId: string;
  timeoutMs: number;

  constructor(base?: string, opts?: AgentBrowserOptions);
  withSession(sessionId: string): AgentBrowser;
  request<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  act<T = unknown>(action: Record<string, unknown>, reqOpts?: RequestOptions): Promise<T>;

  // Core & Advanced Interactions
  open(url: string, opts?: { compact?: boolean; includeBody?: boolean }): Promise<Snapshot>;
  snapshot(opts?: { full?: boolean; compact?: boolean; delta?: boolean; deltaMode?: boolean }): Promise<Snapshot>;
  delta(opts?: { full?: boolean; compact?: boolean }): Promise<Snapshot>;
  click(ref: string, opts?: ClickOptions): Promise<Snapshot>;
  dblclick(ref: string, opts?: Omit<ClickOptions, 'doubleClick'>): Promise<Snapshot>;
  rightclick(ref: string, opts?: Omit<ClickOptions, 'button'>): Promise<Snapshot>;
  drag(ref: string, targetOrOpts: string | DragOptions, extra?: DragOptions): Promise<Snapshot>;
  type(ref: string, text: string, submitOrOpts?: boolean | TypeOptions): Promise<Snapshot>;
  select(ref: string, value: string | string[], opts?: { delta?: boolean; compact?: boolean }): Promise<Snapshot>;
  press(keyOrKeys: string | string[], refOrOpts?: string | { ref?: string; delta?: boolean; compact?: boolean }): Promise<Snapshot>;
  clipboard(opOrText?: 'read' | 'write' | 'clear' | string, opts?: { text?: string }): Promise<{ text?: string; length?: number; written?: boolean; cleared?: boolean }>;
  hover(ref: string, opts?: { delta?: boolean; compact?: boolean }): Promise<Snapshot>;
  scroll(dyOrOpts?: number | { dy?: number; dx?: number; ref?: string; delta?: boolean; compact?: boolean }, extra?: { dx?: number; delta?: boolean; compact?: boolean }): Promise<Snapshot>;
  wait(opts?: { text?: string; selector?: string; url?: string; state?: 'load' | 'domcontentloaded' | 'networkidle'; ms?: number; timeoutMs?: number; delta?: boolean; compact?: boolean }): Promise<Snapshot>;
  waitFor(selector: string, timeoutMs?: number, opts?: { delta?: boolean; compact?: boolean }): Promise<Snapshot>;

  // Batch & Workflows
  batch(steps: BatchStep[], opts?: { stopOnError?: boolean; stopOnNavigation?: boolean; delta?: boolean; compact?: boolean }): Promise<BatchResult>;
  workflow<T = Record<string, unknown>>(opOrOpts?: string | Record<string, unknown>, extra?: Record<string, unknown>): Promise<T>;
  startRecording(name?: string, opts?: { description?: string }): Promise<{ recording: boolean; name: string; startedAt: string; stepCount: number }>;
  stopRecording(opts?: { save?: boolean }): Promise<{ workflow: WorkflowDefinition; savedPath: string | null }>;
  replayWorkflow(name: string, vars?: Record<string, string | number | boolean>, opts?: { stopOnError?: boolean; delta?: boolean }): Promise<BatchResult & { workflow: string }>;
  exportPlaywright(name: string, opts?: { testName?: string }): Promise<PlaywrightExportResult>;

  // Extraction, PDF, Downloads, Visual Regression & Browsing
  extract(format?: ExtractFormat, maxCharsOrOpts?: number | ExtractOptions): Promise<ExtractResult>;
  read(opts?: { maxChars?: number }): Promise<{ title: string; url: string; text: string; length: number; truncated: boolean }>;
  screenshot(opts: ScreenshotOptions & { encoding: 'buffer' }): Promise<Buffer>;
  screenshot(opts?: ScreenshotOptions): Promise<ScreenshotResult>;
  pdf(opts: PdfOptions & { encoding: 'buffer' }): Promise<Buffer>;
  pdf(opts?: PdfOptions): Promise<PdfResult>;
  downloads(): Promise<{ downloads: Array<Record<string, unknown>> }>;
  downloads(idOrOpts: string | { op?: 'list' | 'inspect'; id?: string; maxChars?: number; maxRows?: number }): Promise<DownloadInspection>;
  inspectDownload(id?: string, opts?: { maxChars?: number; maxRows?: number }): Promise<DownloadInspection>;
  visualDiff(opOrName?: string | VisualDiffOptions, opts?: VisualDiffOptions): Promise<VisualDiffResult>;
  upload(ref: string, paths: string | string[], opts?: { compact?: boolean }): Promise<Snapshot>;
  navigate(action: 'back' | 'forward' | 'reload', opts?: { delta?: boolean; compact?: boolean }): Promise<Snapshot>;
  back(opts?: { delta?: boolean; compact?: boolean }): Promise<Snapshot>;
  forward(opts?: { delta?: boolean; compact?: boolean }): Promise<Snapshot>;
  reload(opts?: { delta?: boolean; compact?: boolean }): Promise<Snapshot>;
  tabs(op?: 'list' | 'new' | 'select' | 'close', id?: string, url?: string): Promise<TabSummary[]>;
  task(goal: string, opts?: TaskOptions): Promise<TaskAnswer>;

  // F12 Agent DevTools
  devtools(): Promise<Record<string, unknown>>;
  network<T = Record<string, unknown>>(optsOrId?: string | Record<string, unknown>): Promise<T>;
  console<T = Record<string, unknown>>(opts?: Record<string, unknown>): Promise<T>;
  evaluate<T = { value: unknown; type: string }>(expression: string, opts?: { timeoutMs?: number }): Promise<T>;
  inspect(refOrSelector: string | { ref?: string; selector?: string }): Promise<Record<string, unknown>>;
  a11y(opts?: string | { ref?: string; selector?: string; maxChars?: number }): Promise<{ url: string; source: string; truncated: boolean; tree: string }>;
  diff(opts?: string | { op?: 'diff' | 'mark'; sinceMark?: boolean; refresh?: boolean; clearToasts?: boolean }): Promise<Record<string, unknown>>;
  perf(): Promise<Record<string, unknown>>;
  audit(): Promise<{ url: string; scores: Record<string, number>; issues: Array<Record<string, unknown>> }>;
  storage(opts?: string | { op?: 'inspect' | 'clear'; targets?: string[]; includeValues?: boolean }): Promise<Record<string, unknown>>;
  security(): Promise<Record<string, unknown>>;
  emulate(opts: DevicePreset | Record<string, unknown>): Promise<{ emulation: Record<string, unknown>; snapshot: Snapshot }>;
  dialog(opts?: string | { op?: 'list' | 'set' | 'accept' | 'dismiss' | 'clear'; action?: 'accept' | 'dismiss' | 'manual'; promptText?: string; once?: boolean }): Promise<Record<string, unknown>>;
  trace(opOrOpts?: 'start' | 'stop' | 'status' | { op?: 'start' | 'stop' | 'status'; screenshots?: boolean; snapshots?: boolean; sources?: boolean }): Promise<Record<string, unknown>>;

  // Supervisor, Takeover, Metrics & Sessions
  takeover(input: TakeoverInput): Promise<{ ok: boolean; paused: boolean; url: string; title: string; shotVersion: number; hasShot: boolean; controls: number }>;
  health(): Promise<{ ready: boolean; engine: string; version: string; sessions: number; maxSessions: number; dashboard: string | null }>;
  metrics(format: 'prometheus'): Promise<string>;
  metrics(format?: 'json'): Promise<MetricsSummary>;
  tools(): Promise<{ tools: ToolDefinition[] }>;
  state(): Promise<SessionState>;
  approve(id: string, allow: boolean): Promise<{ ok: boolean }>;
  policy(patch: PolicyPatch): Promise<PolicyConfig>;
  pause(paused?: boolean): Promise<{ paused: boolean }>;
  reset(): Promise<{ ok: boolean; state: SessionState }>;
  getStorage(): Promise<{ cookies: Array<Record<string, unknown>>; origins: Array<Record<string, unknown>> }>;
  setStorage(storageState: { cookies?: Array<Record<string, unknown>>; origins?: Array<Record<string, unknown>> }): Promise<{ ok: boolean; cookies: number; origins: number }>;
  listSessions(): Promise<Array<Record<string, unknown>>>;
  createSession(opts?: CreateSessionOptions): Promise<{ id: string; state: SessionState }>;
  closeSession(id?: string): Promise<{ ok: boolean }>;
}
