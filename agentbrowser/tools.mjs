// tools.mjs — Agent-facing browser & F12 DevTools catalogue, shared by HTTP discovery and MCP.

const obj = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });
const num = (description) => ({ type: 'number', description });
const int = (description, minimum, maximum) => ({
  type: 'integer',
  ...(minimum !== undefined ? { minimum } : {}),
  ...(maximum !== undefined ? { maximum } : {}),
  description,
});

export const tools = [
  // ---------------- Core browsing & interaction ----------------
  {
    name: 'browser_open',
    description: 'Open an HTTP(S) URL (or about:blank) and return a fresh Agent Document.',
    inputSchema: obj({ url: str('URL to open') }, ['url']),
  },
  {
    name: 'browser_snapshot',
    description: 'Capture the active page as a compact Agent Document with actionable refs (e1..eN), states, and a [devtools] anomaly badge.',
    inputSchema: obj({
      full: bool('Include structured element bounding boxes and metadata JSON (default false).'),
    }),
  },
  {
    name: 'browser_click',
    description: 'Click an actionable ref from the latest snapshot. Risky actions wait for human approval.',
    inputSchema: obj({
      ref: str('Element ref from the latest snapshot, e.g. e3'),
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
      doubleClick: bool('Double-click instead of single-click.'),
    }, ['ref']),
  },
  {
    name: 'browser_type',
    description: 'Fill or type text into an element ref and optionally press Enter.',
    inputSchema: obj({
      ref: str('Element ref from the latest snapshot'),
      text: str('Text to enter'),
      submit: bool('Press Enter after typing.'),
      clear: bool('Clear existing field text before typing (default true).'),
      secret: bool('Mask the typed text in logs and event streams.'),
    }, ['ref', 'text']),
  },
  {
    name: 'browser_select',
    description: 'Select one or more options in a dropdown (<select>) by option value or visible label.',
    inputSchema: obj({
      ref: str('Combobox/select element ref from the latest snapshot'),
      value: {
        oneOf: [
          str('Option value or visible label to select'),
          { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Multiple option values or labels' },
        ],
        description: 'Option value(s) or label(s) to select',
      },
    }, ['ref', 'value']),
  },
  {
    name: 'browser_press',
    description: 'Press a keyboard key or shortcut (e.g. Enter, Escape, Tab, ArrowDown, Control+a).',
    inputSchema: obj({
      key: str('Playwright key name, e.g. Escape, Enter, Tab, ArrowDown'),
      ref: str('Optional element ref to focus before pressing the key'),
    }, ['key']),
  },
  {
    name: 'browser_hover',
    description: 'Hover over an element ref to reveal dropdown menus or tooltips and return an updated snapshot.',
    inputSchema: obj({
      ref: str('Element ref from the latest snapshot'),
    }, ['ref']),
  },
  {
    name: 'browser_scroll',
    description: 'Scroll vertically/horizontally in pixels, or scroll a specific element ref into view.',
    inputSchema: obj({
      dy: num('Vertical scroll delta in pixels (positive = down, default 700).'),
      dx: num('Horizontal scroll delta in pixels (default 0).'),
      ref: str('Optional element ref to scroll directly into view instead of wheel scrolling.'),
    }),
  },
  {
    name: 'browser_wait',
    description: 'Wait for visible text, a CSS selector, a URL pattern, or a page load state.',
    inputSchema: obj({
      text: str('Wait until this text becomes visible on the page.'),
      selector: str('Wait until the first element matching this CSS selector becomes visible.'),
      url: str('Wait until the page URL matches this URL or glob pattern.'),
      state: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'Load state to await when text/selector/url are omitted.' },
      timeoutMs: num('Maximum wait time in milliseconds (100–30000, default 8000).'),
    }),
  },
  {
    name: 'browser_wait_for',
    description: 'Wait until a CSS selector is visible, then return a fresh snapshot.',
    inputSchema: obj({
      selector: str('CSS selector'),
      timeoutMs: int('Maximum wait time in milliseconds.', 1, 30000),
    }, ['selector']),
  },
  {
    name: 'browser_extract',
    description: 'Extract page text, rendered HTML, Markdown, links, form metadata, HTML tables (JSON), or structured metadata (OpenGraph, Twitter, JSON-LD).',
    inputSchema: obj({
      format: {
        type: 'string',
        enum: ['text', 'html', 'markdown', 'links', 'forms', 'tables', 'metadata'],
        description: 'Extraction format (default text).',
      },
      maxChars: int('Maximum characters to return (default 20000).', 1, 200000),
    }),
  },
  {
    name: 'browser_read',
    description: 'Extract clean reader-mode prose from the active page (strips navigation, ads, and footers) for reading long articles.',
    inputSchema: obj({
      maxChars: num('Maximum characters to return (500–100000, default 20000).'),
    }),
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a screenshot of the active page. Set annotate=true to draw DevTools [e1..eN] highlight overlays around actionable controls.',
    inputSchema: obj({
      fullPage: bool('Capture full scrollable page instead of the current viewport.'),
      annotate: bool('Draw color-coded [eN] Set-of-Mark boxes over visible controls before capturing.'),
      type: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default png).' },
    }),
  },
  {
    name: 'browser_upload',
    description: 'Upload file(s) from AGENT_BROWSER_UPLOAD_DIR into a file input element.',
    inputSchema: obj({
      ref: str('File input element ref from the latest snapshot'),
      paths: {
        oneOf: [
          str('Relative file path inside AGENT_BROWSER_UPLOAD_DIR'),
          { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
        ],
        description: 'File path(s) inside AGENT_BROWSER_UPLOAD_DIR',
      },
    }, ['ref', 'paths']),
  },
  {
    name: 'browser_navigate',
    description: 'Navigate browser history back, forward, or reload the current page.',
    inputSchema: obj({
      op: { type: 'string', enum: ['back', 'forward', 'reload'] },
    }, ['op']),
  },
  {
    name: 'browser_tabs',
    description: 'List open tabs or create, select, or close a tab.',
    inputSchema: obj({
      op: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
      id: str('Tab id (e.g. t2) for select or close'),
      url: str('Optional initial URL when op is "new"'),
    }, ['op']),
  },

  // ---------------- F12 Agent DevTools suite ----------------
  {
    name: 'browser_network',
    description: 'F12 Network panel: list recorded requests (r1..rN), inspect response body/JSON & redacted headers, inspect WebSocket frames, export HAR, throttle speed/offline, block trackers/patterns, or mock API routes.',
    inputSchema: obj({
      op: {
        type: 'string',
        enum: ['list', 'get', 'websockets', 'har', 'clear', 'throttle', 'block', 'mock', 'unmock'],
        description: 'Network operation (default list).',
      },
      id: str('Request id (e.g. r4) for op="get", or mock id/pattern for op="unmock".'),
      resourceType: str('Filter list by type: "api" (fetch+xhr), "fetch", "xhr", "document", "script", "stylesheet", "image", or "all".'),
      status: str('Filter list by status: "failed", "2xx", "3xx", "4xx", "5xx", or exact code like "422".'),
      url: str('Filter list by URL substring.'),
      sinceLastAction: bool('Only show requests triggered during/since the last browser action.'),
      limit: int('Maximum entries to return (default 50).', 1, 200),
      maxChars: int('Maximum response body chars for op="get" (default 16000).', 100, 65536),
      wsId: str('Optional WebSocket id (e.g. ws1) for op="websockets".'),
      includeBodies: bool('Include truncated response text inside HAR export (op="har").'),
      preset: { type: 'string', enum: ['online', 'offline', 'slow-3g', 'fast-3g', '4g'], description: 'Network throttle preset for op="throttle".' },
      offline: bool('Toggle offline mode for op="throttle".'),
      latencyMs: num('Custom added latency in ms for op="throttle".'),
      downloadKbps: num('Custom download speed in Kbps for op="throttle" (-1 = unlimited).'),
      uploadKbps: num('Custom upload speed in Kbps for op="throttle" (-1 = unlimited).'),
      blockTrackers: bool('Enable/disable built-in ad & analytics tracker blocking for op="block".'),
      patterns: {
        oneOf: [str('Comma-separated URL/domain patterns to block'), { type: 'array', items: { type: 'string' } }],
        description: 'URL or domain patterns to block for op="block".',
      },
      urlPattern: str('URL substring or glob pattern to intercept for op="mock".'),
      method: str('HTTP method to match for op="mock" (default "*").'),
      mockStatus: int('HTTP status code returned by mock (default 200).', 100, 599),
      contentType: str('Response content-type for op="mock" (default application/json).'),
      body: str('Response body string for op="mock".'),
    }),
  },
  {
    name: 'browser_console',
    description: 'F12 Console panel: list console messages (error, warning, log, info, debug) and uncaught JS exceptions (pageerror with stack traces), or clear logs.',
    inputSchema: obj({
      op: { type: 'string', enum: ['list', 'clear'], description: 'Console operation (default list).' },
      level: { type: 'string', enum: ['all', 'error', 'warning', 'log', 'info', 'debug', 'pageerror'], description: 'Filter by log level ("error" includes uncaught pageerrors).' },
      search: str('Filter messages/stacks by substring.'),
      sinceLastAction: bool('Only show messages emitted during/since the last browser action.'),
      limit: int('Maximum entries to return (default 60).', 1, 300),
    }),
  },
  {
    name: 'browser_evaluate',
    description: 'F12 Console eval: execute a JavaScript expression in the active page. Disabled by default unless AGENT_BROWSER_ALLOW_EVAL=1 (and gated by human approval).',
    inputSchema: obj({
      expression: str('JavaScript expression or async body to evaluate in the active page.'),
      timeoutMs: int('Evaluation timeout in milliseconds (default 5000).', 100, 15000),
    }, ['expression']),
  },
  {
    name: 'browser_inspect',
    description: 'F12 Elements & Styles panel: inspect an element (by snapshot ref or CSS selector) for attributes, DOM path, HTML snippet, box model, computed CSS, states, and why-not-clickable/occlusion diagnosis.',
    inputSchema: obj({
      ref: str('Element ref from the latest snapshot, e.g. e5'),
      selector: str('CSS selector when inspecting an element without a snapshot ref'),
    }),
  },
  {
    name: 'browser_a11y',
    description: 'F12 Accessibility panel: dump the semantic ARIA accessibility tree of the page or a specific element.',
    inputSchema: obj({
      ref: str('Optional element ref to scope the tree'),
      selector: str('Optional CSS selector to scope the tree'),
      maxChars: int('Maximum characters to return (default 16000).', 200, 100000),
    }),
  },
  {
    name: 'browser_diff',
    description: 'DOM Diff & Toast Catcher: show added (+), removed (-), and modified (~) controls/text since the previous snapshot or mark, plus ephemeral toast/alert messages captured via MutationObserver.',
    inputSchema: obj({
      op: { type: 'string', enum: ['diff', 'mark'], description: '"mark" saves a baseline checkpoint; "diff" compares against previous snapshot or mark (default diff).' },
      sinceMark: bool('Compare against the last "mark" checkpoint instead of the immediately preceding snapshot.'),
      refresh: bool('Take a fresh snapshot before computing the diff.'),
      clearToasts: bool('Clear captured toast messages after reading them.'),
    }),
  },
  {
    name: 'browser_perf',
    description: 'F12 Performance & Memory panel: collect Core Web Vitals (TTFB, FCP, LCP, CLS, DCL, Load), slowest resources, DOM element counts, JS heap memory, and CDP layout/style metrics.',
    inputSchema: obj({}),
  },
  {
    name: 'browser_audit',
    description: 'F12 Lighthouse-style Page Audit: score (0–100) and report issues across accessibility (missing alt/labels, broken images), SEO (title/meta/canonical/h1), security (HTTPS, mixed content, headers), and reliability (console/network errors, DOM size, vitals).',
    inputSchema: obj({}),
  },
  {
    name: 'browser_storage',
    description: 'F12 Application Storage panel: inspect cookies (flags/domains; secret values redacted), localStorage, sessionStorage, IndexedDB databases, Service Workers, and Cache Storage, or selectively clear them.',
    inputSchema: obj({
      op: { type: 'string', enum: ['inspect', 'clear'], description: 'Storage operation (default inspect).' },
      targets: {
        type: 'array',
        items: { type: 'string', enum: ['cookies', 'localStorage', 'sessionStorage', 'indexedDB', 'caches'] },
        minItems: 1,
        description: 'Storage buckets to clear when op="clear".',
      },
    }),
  },
  {
    name: 'browser_security',
    description: 'F12 Security & Privacy panel: inspect HTTPS/TLS certificate info, main response security headers (CSP, HSTS, X-Frame-Options, COOP, Permissions-Policy), mixed content, cookie flags, and third-party domains contacted.',
    inputSchema: obj({}),
  },
  {
    name: 'browser_emulate',
    description: 'F12 Device Toolbar & Media emulation: switch device preset (desktop, desktop-hd, iphone-15, pixel-8, ipad) or custom viewport, dark/light colorScheme, reducedMotion, print/screen media, offline mode, geolocation, or timezone.',
    inputSchema: obj({
      device: { type: 'string', enum: ['desktop', 'desktop-hd', 'iphone-15', 'pixel-8', 'ipad'], description: 'Device preset.' },
      viewport: obj({ width: int('Viewport width in px', 320, 3840), height: int('Viewport height in px', 240, 2160) }, ['width', 'height']),
      colorScheme: { type: 'string', enum: ['light', 'dark', 'no-preference'], description: 'Emulate prefers-color-scheme.' },
      reducedMotion: { type: 'string', enum: ['reduce', 'no-preference'], description: 'Emulate prefers-reduced-motion.' },
      media: { type: 'string', enum: ['screen', 'print'], description: 'Emulate CSS media type.' },
      offline: bool('Toggle browser offline state.'),
      geolocation: obj({
        latitude: num('Latitude (-90 to 90)'),
        longitude: num('Longitude (-180 to 180)'),
        accuracy: num('Optional accuracy in meters'),
      }, ['latitude', 'longitude']),
      timezoneId: str('IANA timezone ID, e.g. Asia/Kolkata or America/New_York'),
      userAgent: str('Optional custom User-Agent override'),
    }),
  },
  {
    name: 'browser_dialog',
    description: 'Dialog controller: inspect alert/confirm/prompt history, pre-configure how upcoming dialogs are handled (accept, dismiss, or manual with optional promptText), or answer a pending dialog.',
    inputSchema: obj({
      op: { type: 'string', enum: ['list', 'set', 'accept', 'dismiss', 'clear'], description: 'Dialog operation (default list).' },
      action: { type: 'string', enum: ['accept', 'dismiss', 'manual'], description: 'Rule for op="set".' },
      promptText: str('Text entered into prompt() dialogs when accepting.'),
      once: bool('Apply op="set" rule only to the next dialog, then revert to auto-dismiss.'),
    }),
  },
  {
    name: 'browser_trace',
    description: 'Playwright Trace recorder: start or stop recording a step-by-step .zip trace (screenshots, DOM snapshots, and network timeline) for debugging.',
    inputSchema: obj({
      op: { type: 'string', enum: ['start', 'stop', 'status'], description: 'Trace operation.' },
      screenshots: bool('Capture screenshots during trace (default true).'),
      snapshots: bool('Capture DOM snapshots during trace (default true).'),
      sources: bool('Include script sources in trace (default false).'),
    }, ['op']),
  },
  {
    name: 'browser_task',
    description: 'Run the built-in research planner (multi-engine search + source verification, with optional LLM synthesis if configured).',
    inputSchema: obj({
      goal: str('Research question or goal (may include a target URL)'),
    }, ['goal']),
  },
];
