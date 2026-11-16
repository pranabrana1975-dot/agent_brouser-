# AgentBrowser v2.0

Complete AI browser platform: hardened headless Chromium control plane, **Live Supervisor Mission Control & Human Takeover UI (`/dashboard`)**, **Batch & Zero-Token Workflow Record/Replay + Playwright Codegen**, **Agent DevTools ("F12 for Agents")**, **Autonomous Browser Agent v2 & Schema Scraper**, zero-dependency **JavaScript/TypeScript SDK**, one-shot **CLI**, **Full MCP Server** (37 Tools + Resources + Prompts + Delta Snapshots), **Prometheus `/metrics`**, and production **Docker** setup.

বিস্তারিত বাংলা ডকুমেন্টেশনের জন্য দেখুন: **[`agentbrowser/README.md`](./agentbrowser/README.md)**।

## Quick Start

Requires **Node.js 20+** (or Docker).

```sh
npm run setup
npx --prefix agentbrowser playwright install chromium
npm start
```

By default `server.mjs` listens on `http://127.0.0.1:3000`:
- **Live Mission Control & Human Takeover UI:** `http://127.0.0.1:3000/dashboard`
- **Streamable HTTP MCP:** `http://127.0.0.1:3000/mcp`
- **Prometheus Metrics:** `http://127.0.0.1:3000/metrics` (JSON summary: `/api/metrics`)

Run standalone over MCP stdio, scrape paginated pages, or export PDFs straight from the shell:

```sh
npm run mcp:embedded
npm run fetch -- https://news.ycombinator.com --dump items --max-pages 2
npm run fetch -- https://example.com --dump pdf > page.pdf
npm run inspect -- https://example.com --selector main
```

### Docker Compose (Production)

```sh
AGENT_BROWSER_TOKEN="$(openssl rand -hex 32)" docker compose up --build -d
```

Runs as non-root `pwuser` with `shm_size: "1gb"`, `read_only: true`, `no-new-privileges`, `/api/health` healthcheck, and jailed volumes for `/data/{uploads,downloads,traces,workflows}`.

## What's in v2.0 (37 Tools + Full MCP + Mission Control)

1. **Live Supervisor Dashboard & Human Takeover (`/dashboard`, `POST /api/takeover`):** Zero-dependency dark Mission Control UI with live viewport (including `[eN]` Set-of-Mark overlays), 1-click **Approve / Deny** banners for gated actions, **Human Takeover** mode (pause agent, click/drag/scroll/type masked OTP/2FA/CAPTCHA directly, then seamlessly resume held agent actions), multi-session switcher (with per-session proxy), live workflow recorder/replayer, and Timeline / Network / Console / Audit / Snapshot / Workflows panels.
2. **Batch Actions, Workflow Recorder, Replay & Playwright Codegen (`browser_batch`, `browser_workflow`):** Execute multi-step sequences in a single LLM round-trip with automatic semantic ref re-binding and instant stop on error, navigation, or denied approval. Record semantic `role + label + CSS fallback` workflows to jailed `.workflow.json` files (auto-converting passwords/secrets into `{{secret_N}}` variables), replay them at **0 LLM tokens** with `{{variable}}` interpolation, or export clean `@playwright/test` `*.spec.mjs` files.
3. **Advanced Interaction, Cross-Origin Iframes, PDF, Download Inspector & Visual Diff (`browser_drag`, `browser_click`, `browser_press`, `browser_clipboard`, `browser_pdf`, `browser_downloads`, `browser_visual_diff`):** Kanban/slider drag-and-drop, `dblclick`, right-click, modifier chords, multi-key sequences, approval-gated clipboard access, cross-origin `<iframe>` discovery (`frame=fN:xorigin`) & FrameLocator routing, PDF generation with SHA-256 & page count, jailed download artifact inspection (CSV/TSV/JSON/JSONL/text/PDF/PNG previews with secret redaction), and zero-dependency YIQ perceptual PNG visual regression diffing (diff %, bounding box, hotspots, and highlighted diff PNG).
4. **Autonomous Browser Agent v2 & Schema/Paginated Scraper (`browser_task`, `browser_extract`):** Full **Observe → Plan → Act → Verify** loop supporting multi-field form filling, proactive & reactive modal/cookie-banner occlusion self-healing, DOM-diff verification, optional OpenAI-compatible LLM planner, plus existing grounded English/Bangla multi-engine research. `browser_extract` adds auto-detected `items` cards, typed CSS `schema` extraction (`string`, `number`, `boolean`, `url`, `list`), and automatic multi-page `Next` pagination (`maxPages`).
5. **Agent DevTools — "F12 for Agents" (13 tools):** `browser_network` (XHR/Fetch/WS/HAR/throttle/block/mock), `browser_console`, `browser_evaluate` (disabled by default + approval-gated), `browser_inspect` (box model, computed CSS, click occlusion), `browser_a11y`, `browser_diff`, `browser_perf` (Core Web Vitals + CDP metrics), `browser_audit`, `browser_storage`, `browser_security`, `browser_emulate`, `browser_dialog`, and `browser_trace`.
6. **Full MCP Spec & Delta Snapshots (`mcp.mjs`, `lib/mcp-handler.mjs`, `lib/snapshot.mjs`):** Supports `tools/list` & `tools/call` (37 tools), `resources/list`, `resources/templates/list` & `resources/read` (`browser://snapshot`, `browser://state`, `browser://console`, `browser://network`, `browser://network/{id}`, `browser://network/har`, `browser://screenshot`, `browser://devtools`, `browser://workflows`, `browser://workflows/{name}`, `browser://workflows/{name}/playwright`, `browser://downloads`, `browser://downloads/{id}`, `browser://trace`), `prompts/list` & `prompts/get` (`qa_audit`, `security_review`, `research_topic`, `scrape_structured`, `record_workflow`), and compact `delta: true` snapshots showing only `+added / ~changed / -removed` elements.
7. **TypeScript, Observability & Per-Session Proxies (`sdk.d.ts`, `tools.d.ts`, `lib/metrics.mjs`):** Complete TypeScript definitions for `AgentBrowser` and all 37 tools, Prometheus histograms/counters/gauges on `/metrics`, SSRF-checked per-session HTTP/HTTPS/SOCKS5 proxies with credential redaction, and modularized session internals (`lib/session.mjs` + `lib/session-ops.mjs`).

## Testing

```sh
npm test
```

## License

[MIT](./LICENSE)
