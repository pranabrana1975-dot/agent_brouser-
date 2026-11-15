# AgentBrowser

Headless Chromium control plane, **Agent DevTools ("F12 for Agents")**, one-shot CLI, JavaScript SDK, and Model Context Protocol (MCP) server built specifically for AI agents — turning live web pages into compact, deterministic **Agent Documents** (`e1..eN` refs + accessible labels + control states + live DevTools diagnostics) instead of raw pixels or bloated HTML.

বিস্তারিত বাংলা ডকুমেন্টেশনের জন্য দেখুন: **[`agentbrowser/README.md`](./agentbrowser/README.md)**।

## Quick Start

Requires **Node.js 20+**.

```sh
npm run setup
npx --prefix agentbrowser playwright install chromium
npm start
```

The control plane listens on `http://127.0.0.1:3000` by default (Streamable HTTP MCP at `http://127.0.0.1:3000/mcp`). Run standalone over MCP stdio or inspect any page straight from the shell:

```sh
npm run mcp:embedded
npm run fetch -- https://example.com --dump audit
npm run inspect -- https://example.com --selector main
```

## Agent DevTools ("F12 for Agents")

Alongside the 17 core browsing tools, AgentBrowser ships 13 built-in DevTools tools (30 total across HTTP, SDK, CLI, and MCP):

1. **Network (`browser_network`):** Ring-buffered HTTP/XHR/Fetch log (`r1..rN`), response body/JSON/header/query inspection, WebSocket connection & frame inspector (`ws1..wsN`), HAR 1.2 export, network throttling (`offline`, `slow-3g`, `fast-3g`, `4g`, `online`), ad/tracker & URL pattern blocker, and QA API route mocks — with automatic `[REDACTED]` masking of auth headers, cookies, secret query params, and password payloads.
2. **Console & Gated Eval (`browser_console`, `browser_evaluate`):** Captures `console.*` messages and uncaught `pageerror` stack traces with level & `sinceLastAction` filters, injects a 1-line `[devtools]` anomaly badge into snapshots only when errors/failed requests/toasts occur, and keeps `browser_evaluate` disabled by default (`AGENT_BROWSER_ALLOW_EVAL=1` + human approval gate).
3. **Elements, Accessibility & Diff (`browser_inspect`, `browser_a11y`, `browser_diff`):** Inspects any `eN` ref or CSS selector (tag, redacted attributes, DOM path, HTML snippet, box model, computed CSS, and `elementFromPoint` click-occlusion diagnosis), dumps the full ARIA accessibility tree, tracks snapshot DOM diffs (`+`/`-`/`~`), and catches ephemeral toast/alert banners via `MutationObserver`.
4. **Performance, Audit & Trace (`browser_perf`, `browser_audit`, `browser_trace`):** Core Web Vitals (`TTFB`, `FCP`, `LCP`, `CLS`, `DOMContentLoaded`, `Load`), slowest resources, DOM depth, and CDP `Performance.getMetrics` (JS heap, DOM nodes, layouts, style recalcs); single-call page audit across accessibility, SEO, security, and reliability; and Playwright `.zip` trace recording.
5. **Storage & Security (`browser_storage`, `browser_security`):** Inspects and selectively clears cookies, `localStorage`, `sessionStorage`, `IndexedDB`, Service Workers, and Cache Storage (masking cookie values and sensitive storage keys by default); inspects TLS certificates, CSP/HSTS/X-Frame-Options security headers, mixed content, insecure forms/cookies, and third-party tracker domains.
6. **Emulation, Set-of-Mark Overlay, Dialogs & Structured Extract (`browser_emulate`, `browser_screenshot({ annotate: true })`, `browser_dialog`, `browser_extract`):** Device presets (`iphone-15`, `pixel-8`, `ipad`, `desktop`, `desktop-hd`), dark/light mode, reduced motion, print media, offline mode, geolocation & timezone emulation; `[eN]` Set-of-Mark annotated screenshots for vision models; JS `alert`/`confirm`/`prompt` history and rules; plus `tables` and `metadata` (OpenGraph, Twitter Card, JSON-LD, feeds) extraction.

## Project Layout

- `agentbrowser/server.mjs` — Hardened HTTP control plane, SSE event stream, DevTools REST endpoints, multi-session routes, and Streamable HTTP MCP (`/mcp`)
- `agentbrowser/mcp.mjs` & `agentbrowser/lib/mcp-handler.mjs` — MCP JSON-RPC 2.0 dispatcher (remote stdio, embedded stdio, and HTTP)
- `agentbrowser/cli.mjs` & `agentbrowser/lib/extract.mjs` — One-shot shell CLI (`fetch` + `inspect`) and structured extractor (`text`, `html`, `markdown`, `links`, `forms`, `tables`, `metadata`)
- `agentbrowser/sdk.mjs` & `agentbrowser/tools.mjs` — Zero-dependency JavaScript SDK and 30 shared agent/DevTools tool schemas
- `agentbrowser/lib/devtools.mjs` & `agentbrowser/lib/inspector.mjs` — Network/WS/HAR/console/dialog/mock/trace engine and DOM/CSS/a11y/diff/perf/audit/storage/security/overlay inspectors
- `agentbrowser/lib/snapshot.mjs` — Viewport/modal/main-prioritized Agent Document generator with Shadow DOM, same-origin iframes, and live `[devtools]` anomaly badge
- `agentbrowser/lib/session.mjs`, `agentbrowser/lib/manager.mjs`, `agentbrowser/lib/policy.mjs`, `agentbrowser/lib/agent.mjs` — Multi-session isolation, SSRF & approval guardrails, and multi-engine English/Bangla research planner
- `agentbrowser/test/` & `.github/workflows/ci.yml` — Unit, DevTools, mock-DOM, HTTP/MCP/SSE integration, and Playwright Chromium E2E tests across Node 20 & 22

## Testing

```sh
npm test
```

## License

[MIT](./LICENSE)
