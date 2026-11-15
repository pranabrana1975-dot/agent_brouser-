// tools.mjs — Agent-facing tool catalogue, shared by HTTP discovery and MCP.

const obj = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });
const num = (description) => ({ type: 'number', description });

export const tools = [
  {
    name: 'browser_open',
    description: 'Open an HTTP(S) URL (or about:blank) and return a fresh Agent Document.',
    inputSchema: obj({ url: str('URL to open') }, ['url']),
  },
  {
    name: 'browser_snapshot',
    description: 'Capture the active page as a compact Agent Document with actionable refs (e1..eN) and element states.',
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
      timeoutMs: { type: 'integer', minimum: 1, maximum: 30000, description: 'Maximum wait time in milliseconds.' },
    }, ['selector']),
  },
  {
    name: 'browser_extract',
    description: 'Extract page text, rendered HTML, Markdown, links, or form metadata (never password/field values).',
    inputSchema: obj({
      format: { type: 'string', enum: ['text', 'html', 'markdown', 'links', 'forms'], description: 'Extraction format (default text).' },
      maxChars: { type: 'integer', minimum: 1, maximum: 200000, description: 'Maximum characters to return (default 20000).' },
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
    description: 'Capture a screenshot of the active page for visual inspection (charts, images, layout).',
    inputSchema: obj({
      fullPage: bool('Capture full scrollable page instead of the current viewport.'),
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
  {
    name: 'browser_task',
    description: 'Run the built-in research planner (multi-engine search + source verification, with optional LLM synthesis if configured).',
    inputSchema: obj({
      goal: str('Research question or goal (may include a target URL)'),
    }, ['goal']),
  },
];
