// tools.mjs — Shared tool definitions for MCP, OpenAI/Anthropic function-calling,
// and direct agents (v2.0: 37 core browsing, automation, artifact, and F12 DevTools tools).

import { EXTRACT_FORMATS } from './lib/extract.mjs';

const DELTA_PROP = {
  type: 'boolean',
  description: 'Return a compact delta snapshot (+added / ~changed / -removed + updated [refs]) instead of repeating unchanged page text — saves 60–85% tokens.',
};

export const tools = [
  // ---------------- Core Browsing & Advanced Interaction ----------------
  {
    name: 'browser_open',
    description: 'Open a URL in the active tab and return a compact Agent Document with actionable element refs (e1..eN), accessible names, states, cross-origin iframe controls, and a 1-line [devtools] anomaly badge when issues occur.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'HTTP or HTTPS URL to navigate to' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description: 'Return the current Agent Document: URL, title, viewport/scroll position, [devtools] status badge, headings, prioritized interactive controls with unique refs (e1..eN), and visible text (or a compact delta when delta=true).',
    inputSchema: {
      type: 'object',
      properties: {
        full: {
          type: 'boolean',
          description: 'Include structured bounding-box and control metadata (boxes) alongside text (default false over MCP)',
        },
        delta: DELTA_PROP,
        deltaMode: {
          type: 'boolean',
          description: 'Enable or disable sticky delta snapshot mode for subsequent actions in this session',
        },
      },
    },
  },
  {
    name: 'browser_click',
    description: 'Click, double-click, or right-click an interactive element by snapshot ref (e.g. "e3"), including elements inside Shadow DOM and same-origin or cross-origin iframes. High-impact actions automatically pause for human approval.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from the latest snapshot, e.g. "e3"' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default "left")' },
        doubleClick: { type: 'boolean', description: 'Double-click instead of single-click (default false)' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'] },
          description: 'Optional modifier keys held during click (e.g. ["Control"] or ["Shift"])',
        },
        delta: DELTA_PROP,
      },
      required: ['ref'],
    },
  },
  {
    name: 'browser_drag',
    description: 'Drag an element by snapshot ref to another element (Kanban boards, sortable lists) or by pixel offset/coordinates (sliders, canvas, split panes).',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Source element ref to drag, e.g. "e4"' },
        targetRef: { type: 'string', description: 'Destination element ref to drop onto, e.g. "e9"' },
        dx: { type: 'number', description: 'Horizontal pixel offset when dragging a slider or handle' },
        dy: { type: 'number', description: 'Vertical pixel offset when dragging relative to source' },
        targetX: { type: 'number', description: 'Absolute viewport X destination (used with targetY)' },
        targetY: { type: 'number', description: 'Absolute viewport Y destination (used with targetX)' },
        steps: { type: 'integer', minimum: 2, maximum: 40, description: 'Mouse interpolation steps (default 10)' },
        delta: DELTA_PROP,
      },
      required: ['ref'],
    },
  },
  {
    name: 'browser_type',
    description: 'Fill or type text into an input, search box, textarea, or contenteditable element by ref. Password and secret inputs are automatically masked in logs and recorded workflows.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from the latest snapshot, e.g. "e2"' },
        text: { type: 'string', description: 'Text to enter' },
        submit: { type: 'boolean', description: 'Press Enter after typing (default false)' },
        clear: { type: 'boolean', description: 'Clear existing value before typing (default true)' },
        secret: { type: 'boolean', description: 'Mask typed text in logs and convert to {{secret_N}} when recording workflows' },
        delta: DELTA_PROP,
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'browser_select',
    description: 'Select one or more options in a <select> dropdown by option value or visible label.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Combobox/select ref from the latest snapshot' },
        value: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'Option value or visible label (or array for multi-select)',
        },
        delta: DELTA_PROP,
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'browser_press',
    description: 'Press a keyboard key, multi-key shortcut chord (e.g. "Control+Shift+K", "Control+a", "Alt+ArrowLeft"), or sequential array of keys (e.g. ["Tab", "Tab", "Enter"]).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Single key or chord name (e.g. "Escape", "Control+k", "Meta+Shift+p")' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 20,
          description: 'Optional sequence of keys/chords pressed in order',
        },
        ref: { type: 'string', description: 'Optional element ref to focus first' },
        delta: DELTA_PROP,
      },
    },
  },
  {
    name: 'browser_clipboard',
    description: 'Write text to, read text from (requires human approval), or clear the browser clipboard.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['write', 'read', 'clear'], description: 'Clipboard action (default "read", or "write" if text is given)' },
        text: { type: 'string', description: 'Text to copy into clipboard (for op="write")' },
      },
    },
  },
  {
    name: 'browser_hover',
    description: 'Hover over an element by ref to reveal dropdown menus, tooltips, or hover actions.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from the latest snapshot' },
        delta: DELTA_PROP,
      },
      required: ['ref'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the viewport vertically/horizontally or scroll a specific element ref into view.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['down', 'up'], description: 'Scroll direction (default "down")' },
        amount: { type: 'number', description: 'Scroll distance in pixels (default 700)' },
        ref: { type: 'string', description: 'If set, scrolls this element ref directly into view' },
        delta: DELTA_PROP,
      },
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait for a visible text string, CSS selector, URL pattern, load state, or millisecond delay before taking a fresh snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Wait until this text becomes visible' },
        selector: { type: 'string', description: 'Wait until this CSS selector becomes visible' },
        url: { type: 'string', description: 'Wait until the page URL matches this pattern' },
        state: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'Load state (default "networkidle")' },
        ms: { type: 'integer', minimum: 10, maximum: 15000, description: 'Fixed pause in milliseconds' },
        timeoutMs: { type: 'number', description: 'Maximum wait time in ms (100–30000, default 8000)' },
        delta: DELTA_PROP,
      },
    },
  },
  {
    name: 'browser_wait_for',
    description: 'Wait until an element matching a CSS selector becomes visible and return a fresh snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 30000, description: 'Maximum wait time in ms (default 8000)' },
      },
      required: ['selector'],
    },
  },

  // ---------------- Batch Automation & Workflow Record/Replay/Codegen ----------------
  {
    name: 'browser_batch',
    description: 'Execute up to 25 sequential browser actions (open, click, dblclick, rightclick, drag, type, select, press, hover, scroll, wait, clipboard, extract, navigate) in a SINGLE round-trip (3–5x faster, far fewer tokens). Stops immediately on error, denied approval, or unexpected navigation.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 25,
          items: { type: 'object' },
          description: 'Ordered action objects, e.g. [{op:"type",ref:"e1",text:"ada"},{op:"select",ref:"e2",value:"pro"},{op:"click",ref:"e3"}]',
        },
        stopOnError: { type: 'boolean', description: 'Abort remaining steps on first failure (default true)' },
        stopOnNavigation: { type: 'boolean', description: 'Pause batch early if a non-open step navigates to a new URL (default false)' },
        delta: DELTA_PROP,
      },
      required: ['steps'],
    },
  },
  {
    name: 'browser_workflow',
    description: 'Record actions as resilient semantic workflows (.workflow.json), replay saved workflows with {{variable}} substitution using zero LLM tokens (still enforcing policy & approvals), or export directly to runnable Playwright *.spec.mjs tests.',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['record_start', 'record_stop', 'status', 'list', 'get', 'save', 'delete', 'replay', 'export'],
          description: 'Workflow operation (default "list")',
        },
        name: { type: 'string', description: 'Workflow name (1–64 alphanumeric, ".", "_", or "-")' },
        description: { type: 'string', description: 'Optional human-readable workflow summary' },
        save: { type: 'boolean', description: 'Persist workflow when stopping recording (default true)' },
        vars: { type: 'object', description: 'Key-value map filling {{varName}} placeholders during replay' },
        workflow: { type: 'object', description: 'Full workflow definition (for op="save", "replay", or "export")' },
        steps: { type: 'array', items: { type: 'object' }, description: 'Workflow steps when calling op="save" directly' },
        stopOnError: { type: 'boolean', description: 'Stop replay on first failing step (default true)' },
        testName: { type: 'string', description: 'Custom test() title when exporting Playwright *.spec.mjs' },
        delta: DELTA_PROP,
      },
    },
  },

  // ---------------- Extraction, PDF, Downloads, Visual Regression & Browsing ----------------
  {
    name: 'browser_extract',
    description: 'Extract structured page content: text, html, markdown, links, forms (no values), tables (JSON rows), metadata (OpenGraph/Twitter/JSON-LD/feeds), items (auto-detected product/job/pricing/article cards), or schema (CSS/attr/type map) — with optional multi-page auto-pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: EXTRACT_FORMATS,
          description: 'Output format (default "text")',
        },
        maxChars: { type: 'integer', minimum: 1, maximum: 200000, description: 'Max text/html/markdown chars (default 20000)' },
        selector: { type: 'string', description: 'Optional CSS selector overriding auto-detected card elements when format="items"' },
        schema: {
          type: 'object',
          description: 'Declarative schema for format="schema": { container?: ".card", limit?: 100, fields: { title: "h2", price: { selector: ".price", type: "number" }, url: { selector: "a", attr: "href" } } }',
        },
        maxPages: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: 'Auto-follow Next pagination links up to N pages for items/schema/tables/links (default 1)',
        },
        nextSelector: { type: 'string', description: 'Optional CSS selector for the Next-page link or button' },
      },
    },
  },
  {
    name: 'browser_read',
    description: 'Extract clean reader-mode article text from the active tab (strips navigation, ads, and boilerplate).',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'Maximum characters to return (500–100000, default 20000)' },
      },
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a screenshot of the active tab. Set annotate=true to draw Set-of-Mark [eN] ref badges over interactive controls so vision models can map elements accurately.',
    inputSchema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: 'Capture full scrollable page instead of viewport (default false)' },
        annotate: { type: 'boolean', description: 'Overlay numbered [eN] Set-of-Mark boxes on interactive controls (default false)' },
        quality: { type: 'number', description: 'JPEG quality 20–95 (default 65)' },
      },
    },
  },
  {
    name: 'browser_pdf',
    description: 'Render the current page to a PDF document (invoices, receipts, reports, documentation) with SHA-256 checksum, page count, and optional persistence in AGENT_BROWSER_DOWNLOAD_DIR.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['A4', 'Letter', 'Legal', 'Tabloid', 'Ledger', 'A0', 'A1', 'A2', 'A3', 'A5', 'A6'],
          description: 'Paper format (default "A4")',
        },
        landscape: { type: 'boolean', description: 'Landscape orientation (default false)' },
        printBackground: { type: 'boolean', description: 'Include CSS backgrounds (default true)' },
        scale: { type: 'number', minimum: 0.1, maximum: 2, description: 'Page rendering scale (default 1)' },
        pageRanges: { type: 'string', description: 'Page ranges to print, e.g. "1-3, 5"' },
        margin: {
          type: 'object',
          properties: {
            top: { type: 'string' },
            right: { type: 'string' },
            bottom: { type: 'string' },
            left: { type: 'string' },
          },
          additionalProperties: false,
          description: 'Page margins (e.g. { top: "12mm", bottom: "12mm" })',
        },
        save: { type: 'boolean', description: 'Save PDF into AGENT_BROWSER_DOWNLOAD_DIR if configured' },
        filename: { type: 'string', description: 'Optional filename when save=true (e.g. "invoice.pdf")' },
        includeBase64: { type: 'boolean', description: 'Include base64 PDF payload in response (default true)' },
      },
    },
  },
  {
    name: 'browser_downloads',
    description: 'List downloaded/exported session artifacts or safely inspect a downloaded file (SHA-256 hash, byte size, parsed CSV/TSV rows, JSON structure, text preview, PDF page count, or PNG dimensions — with secret redaction).',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'inspect'], description: 'Downloads action (default "list", or "inspect" if id is set)' },
        id: { type: 'string', description: 'Download ID (e.g. "dl1") or filename to inspect (defaults to latest download)' },
        maxChars: { type: 'integer', minimum: 100, maximum: 50000, description: 'Max text preview characters (default 4000)' },
        maxRows: { type: 'integer', minimum: 1, maximum: 200, description: 'Max parsed CSV/TSV rows to return (default 25)' },
      },
    },
  },
  {
    name: 'browser_visual_diff',
    description: 'Pixel-level visual regression testing: capture named baseline PNG screenshots and compare subsequent renders, returning diff percentage, pass/fail status, changed bounding box, 8x8 layout hotspots, and a highlighted diff PNG.',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['baseline', 'compare', 'list', 'delete'],
          description: 'Visual diff operation (default "compare")',
        },
        name: { type: 'string', description: 'Baseline name, e.g. "homepage" or "checkout-modal" (default "default")' },
        selector: { type: 'string', description: 'Optional CSS selector to screenshot a single component instead of viewport' },
        fullPage: { type: 'boolean', description: 'Capture full scrollable page (default false)' },
        threshold: { type: 'number', minimum: 0, maximum: 1, description: 'Per-pixel YIQ sensitivity 0..1 (default 0.1)' },
        maxDiffPercent: { type: 'number', minimum: 0, maximum: 100, description: 'Max changed pixel % considered passing (default 0.1)' },
        includeDiffImage: { type: 'boolean', description: 'Include highlighted magenta diff PNG image (default true)' },
        updateBaseline: { type: 'boolean', description: 'Overwrite baseline with current capture after comparing (default false)' },
      },
    },
  },
  {
    name: 'browser_upload',
    description: 'Upload one or more files from AGENT_BROWSER_UPLOAD_DIR to a file input element (requires human approval).',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'File input element ref from the latest snapshot' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Relative filenames inside AGENT_BROWSER_UPLOAD_DIR',
        },
      },
      required: ['ref', 'paths'],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Step through browser history or reload the active tab.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['back', 'forward', 'reload'] },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_tabs',
    description: 'List open tabs, open a new tab, switch active tab, or close a tab by id.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
        id: { type: 'string', description: 'Tab id (e.g. "t1") for select or close' },
        url: { type: 'string', description: 'Initial URL when op is "new"' },
      },
      required: ['op'],
    },
  },
  {
    name: 'browser_task',
    description: 'Run the Agent v2 planner: multi-engine research & synthesis (mode="research") OR an autonomous Observe → Plan → Act → Verify loop (mode="autonomous") with form filling, filtering, multi-page schema/items scraping, and self-healing modal/occlusion recovery.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Natural-language goal or question (English or Bangla)' },
        mode: { type: 'string', enum: ['auto', 'research', 'autonomous'], description: 'Execution strategy (default "auto")' },
        startUrl: { type: 'string', description: 'Optional starting URL for autonomous workflow' },
        fields: { type: 'object', description: 'Optional map of form field/select labels to values to fill automatically' },
        submitLabel: { type: 'string', description: 'Optional button/link label to click after filling fields' },
        extractFormat: { type: 'string', enum: EXTRACT_FORMATS, description: 'Optional structured format to extract after acting' },
        schema: { type: 'object', description: 'Optional declarative schema when extractFormat="schema"' },
        maxPages: { type: 'integer', minimum: 1, maximum: 10, description: 'Max pages to paginate when extracting (default 1)' },
        maxSteps: { type: 'integer', minimum: 1, maximum: 40, description: 'Max Observe-Plan-Act-Verify steps (default 15)' },
      },
      required: ['goal'],
    },
  },

  // ---------------- F12 Agent DevTools (13 tools) ----------------
  {
    name: 'browser_network',
    description: 'DevTools Network panel: list HTTP/XHR/Fetch requests (r1..rN), inspect response body/JSON/headers/TLS by id, inspect WebSocket frames, export HAR 1.2, throttle network (offline/slow-3g/fast-3g/4g/online), block ads/trackers/patterns, or mock API routes. Secrets are auto-[REDACTED].',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['list', 'get', 'websockets', 'har', 'clear', 'throttle', 'block', 'mock', 'unmock'],
          description: 'Network action (default "list")',
        },
        id: { type: 'string', description: 'Request id (e.g. "r4") for "get", or mock id (e.g. "m1") for "unmock"' },
        resourceType: {
          type: 'string',
          enum: ['all', 'api', 'fetch', 'xhr', 'document', 'script', 'stylesheet', 'image', 'font', 'media', 'other'],
          description: 'Filter by resource type ("api" = fetch + xhr)',
        },
        status: { type: 'string', description: 'Filter by "failed", "2xx", "3xx", "4xx", "5xx", or exact code like "404"' },
        url: { type: 'string', description: 'Case-insensitive URL substring filter' },
        sinceLastAction: { type: 'boolean', description: 'Only return requests fired since the last page interaction' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max items (default 50)' },
        maxChars: { type: 'integer', minimum: 100, maximum: 65536, description: 'Max body chars for "get" (default 16000)' },
        wsId: { type: 'string', description: 'Optional WebSocket id (e.g. "ws1") for op="websockets"' },
        includeBodies: { type: 'boolean', description: 'Include response bodies in HAR export (default false)' },
        preset: { type: 'string', enum: ['online', '4g', 'fast-3g', 'slow-3g', 'offline'], description: 'Throttle preset' },
        offline: { type: 'boolean' },
        latencyMs: { type: 'number', minimum: 0 },
        downloadKbps: { type: 'number' },
        uploadKbps: { type: 'number' },
        blockTrackers: { type: 'boolean', description: 'Block common analytics/ad tracker domains' },
        patterns: { type: 'array', items: { type: 'string' }, description: 'Domains or wildcard URL patterns to abort' },
        urlPattern: { type: 'string', description: 'URL pattern to mock, e.g. "*/api/checkout*"' },
        method: { type: 'string', description: 'HTTP method for mock (default "ANY")' },
        mockStatus: { type: 'integer', minimum: 100, maximum: 599, description: 'HTTP status for mock (default 200)' },
        contentType: { type: 'string', description: 'Response content-type for mock (default "application/json")' },
        body: { type: 'string', description: 'Response body for mock' },
        headers: { type: 'object', description: 'Extra response headers for mock' },
      },
    },
  },
  {
    name: 'browser_console',
    description: 'DevTools Console panel: read captured console.log/info/warn/error entries and uncaught pageerror exceptions with stack traces, or clear the log.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'clear'], description: 'List or clear console entries (default "list")' },
        level: { type: 'string', enum: ['all', 'error', 'warning', 'info', 'log', 'debug'], description: 'Level filter' },
        search: { type: 'string', description: 'Substring filter on console text/URL' },
        sinceLastAction: { type: 'boolean', description: 'Only return messages logged since the last interaction' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max entries (default 50)' },
      },
    },
  },
  {
    name: 'browser_evaluate',
    description: 'DevTools Console JS evaluator (disabled by default; requires AGENT_BROWSER_ALLOW_EVAL=1 and human approval).',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate in page context' },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 15000, description: 'Timeout in ms (default 5000)' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'browser_inspect',
    description: 'DevTools Elements & Styles inspector: inspect any snapshot ref (eN) or CSS selector — tag, redacted attributes, DOM path, HTML snippet, box model, computed CSS, and click-occlusion diagnosis.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from latest snapshot, e.g. "e5"' },
        selector: { type: 'string', description: 'CSS selector to inspect when ref is omitted' },
      },
    },
  },
  {
    name: 'browser_a11y',
    description: 'DevTools Accessibility tree: dump the full semantic ARIA hierarchy of the page or a specific ref/selector.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Optional snapshot ref to scope the ARIA tree' },
        selector: { type: 'string', description: 'Optional CSS selector to scope the ARIA tree' },
        maxChars: { type: 'integer', minimum: 500, maximum: 100000, description: 'Max characters (default 20000)' },
      },
    },
  },
  {
    name: 'browser_diff',
    description: 'DevTools DOM/Snapshot diff & ephemeral toast tracker: show +added, -removed, ~modified elements, changed text, and transient [role=alert]/[aria-live] toast banners.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['diff', 'mark'], description: 'Compute diff or mark baseline checkpoint' },
        sinceMark: { type: 'boolean', description: 'Compare against last "mark" checkpoint' },
        refresh: { type: 'boolean', description: 'Take a fresh snapshot before diffing' },
        clearToasts: { type: 'boolean', description: 'Clear captured toasts after reading' },
      },
    },
  },
  {
    name: 'browser_perf',
    description: 'DevTools Performance & Memory panel: Core Web Vitals (TTFB, FCP, LCP, CLS, DOMContentLoaded, Load), slowest resources, DOM stats, and CDP JS heap / node / layout metrics.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_audit',
    description: 'DevTools Lighthouse-style audit: score and diagnose Accessibility, SEO, Security, and Reliability issues in a single call.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_storage',
    description: 'DevTools Application & Storage inspector: view cookies (values redacted), localStorage, sessionStorage (secrets redacted), IndexedDB, Service Workers, and Cache Storage; or selectively clear storage.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['inspect', 'clear'], description: 'Inspect or clear storage (default "inspect")' },
        targets: {
          type: 'array',
          items: { type: 'string', enum: ['all', 'cookies', 'localStorage', 'sessionStorage', 'caches', 'indexedDB', 'serviceWorkers'] },
          description: 'Storage buckets to clear when op="clear"',
        },
        includeValues: { type: 'boolean', description: 'Include raw values only if AGENT_BROWSER_ALLOW_STORAGE_VALUES=1' },
      },
    },
  },
  {
    name: 'browser_security',
    description: 'DevTools Security & Privacy panel: inspect TLS certificate, security headers (CSP/HSTS/X-Frame-Options), mixed content, insecure forms/cookies, and third-party tracker domains.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_emulate',
    description: 'DevTools Device & Media emulation: switch device presets (iphone-15, pixel-8, ipad, desktop, desktop-hd) or custom viewport, dark/light mode, reduced motion, print/screen media, offline mode, geolocation, timezone, and UA.',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', enum: ['desktop', 'desktop-hd', 'iphone-15', 'pixel-8', 'ipad'] },
        width: { type: 'integer', minimum: 320, maximum: 3840 },
        height: { type: 'integer', minimum: 240, maximum: 2160 },
        colorScheme: { type: 'string', enum: ['light', 'dark', 'no-preference'] },
        reducedMotion: { type: 'string', enum: ['reduce', 'no-preference'] },
        media: { type: 'string', enum: ['screen', 'print'] },
        offline: { type: 'boolean' },
        timezoneId: { type: 'string' },
        userAgent: { type: 'string' },
        geolocation: {
          type: 'object',
          properties: {
            latitude: { type: 'number', minimum: -90, maximum: 90 },
            longitude: { type: 'number', minimum: -180, maximum: 180 },
            accuracy: { type: 'number', minimum: 0 },
          },
          required: ['latitude', 'longitude'],
          additionalProperties: false,
        },
      },
    },
  },
  {
    name: 'browser_dialog',
    description: 'DevTools JavaScript Dialog controller: list alert/confirm/prompt/beforeunload dialogs, set auto-accept/dismiss/manual rules, or accept/dismiss a pending dialog.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'set', 'accept', 'dismiss', 'clear'] },
        action: { type: 'string', enum: ['accept', 'dismiss', 'manual'] },
        promptText: { type: 'string' },
        once: { type: 'boolean' },
      },
    },
  },
  {
    name: 'browser_trace',
    description: 'DevTools Playwright Trace recorder: start, check status, or stop and save a confined .zip execution trace.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['start', 'stop', 'status'] },
        screenshots: { type: 'boolean' },
        snapshots: { type: 'boolean' },
        sources: { type: 'boolean' },
      },
    },
  },
];
