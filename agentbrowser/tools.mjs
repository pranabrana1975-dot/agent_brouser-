// Agent-facing tool catalogue, shared by HTTP discovery and the MCP adapter.
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
export const tools = [
  { name: 'browser_open', description: 'Open an HTTP(S) URL and return a fresh agent document.', inputSchema: obj({ url: str('URL to open') }, ['url']) },
  { name: 'browser_snapshot', description: 'Read the current page as structured text and actionable refs.', inputSchema: obj({}) },
  { name: 'browser_click', description: 'Click a ref from the latest snapshot. Risky actions may wait for approval.', inputSchema: obj({ ref: str('Element ref, for example e3') }, ['ref']) },
  { name: 'browser_type', description: 'Fill an element and optionally press Enter.', inputSchema: obj({ ref: str('Element ref'), text: str('Text to enter'), submit: { type: 'boolean' } }, ['ref', 'text']) },
  { name: 'browser_scroll', description: 'Scroll vertically in pixels.', inputSchema: obj({ dy: { type: 'number' } }) },
  { name: 'browser_navigate', description: 'Navigate back, forward, or reload.', inputSchema: obj({ op: { type: 'string', enum: ['back', 'forward', 'reload'] } }, ['op']) },
  { name: 'browser_tabs', description: 'List tabs or create, select, and close a tab.', inputSchema: obj({ op: { type: 'string', enum: ['list', 'new', 'select', 'close'] }, id: str('Tab id for select or close') }, ['op']) },
  { name: 'browser_extract', description: 'Extract page text, rendered HTML, Markdown, links, or form metadata (never password values).', inputSchema: obj({ format: { type: 'string', enum: ['text', 'html', 'markdown', 'links', 'forms'] }, maxChars: { type: 'integer', minimum: 1, maximum: 200000 } }) },
  { name: 'browser_wait_for', description: 'Wait until a CSS selector is visible, then return a fresh snapshot.', inputSchema: obj({ selector: str('CSS selector'), timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 } }, ['selector']) },
  { name: 'browser_screenshot', description: 'Capture the current viewport as a PNG image.', inputSchema: obj({}) },
  { name: 'browser_task', description: 'Run the built-in heuristic research planner (not an LLM).', inputSchema: obj({ goal: str('Research goal') }, ['goal']) },
];
