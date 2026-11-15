# AgentBrowser

Headless Chromium control plane, JavaScript SDK, and Model Context Protocol (MCP) server built specifically for AI agents — turning live web pages into compact, deterministic **Agent Documents** (`e1..eN` refs + accessible labels + control states) instead of raw pixels or bloated HTML.

বিস্তারিত বাংলা ডকুমেন্টেশনের জন্য দেখুন: **[`agentbrowser/README.md`](./agentbrowser/README.md)**।

## Quick Start

Requires **Node.js 20+**.

```sh
npm run setup
npx --prefix agentbrowser playwright install chromium
npm start
```

The control plane listens on `http://127.0.0.1:3000` by default (Streamable HTTP MCP at `http://127.0.0.1:3000/mcp`). To run standalone over MCP stdio without starting a separate HTTP server:

```sh
npm run mcp:embedded
```

## Project Layout

- `agentbrowser/server.mjs` — Hardened HTTP control plane, SSE event stream, multi-session routes, and Streamable HTTP MCP (`/mcp`)
- `agentbrowser/mcp.mjs` & `agentbrowser/lib/mcp-handler.mjs` — MCP JSON-RPC 2.0 dispatcher (remote stdio, embedded stdio, and HTTP)
- `agentbrowser/cli.mjs` & `agentbrowser/lib/extract.mjs` — One-shot shell CLI (`fetch --dump text|html|markdown|links|forms`) and structured extractor
- `agentbrowser/sdk.mjs` — Zero-dependency JavaScript client SDK with timeouts and multi-session support
- `agentbrowser/tools.mjs` — 17 shared agent tools (`open`, `snapshot`, `click`, `type`, `select`, `press`, `hover`, `scroll`, `wait`, `wait_for`, `extract`, `read`, `screenshot`, `upload`, `navigate`, `tabs`, `task`)
- `agentbrowser/lib/snapshot.mjs` — Viewport/modal/main-prioritized Agent Document generator with label resolution, element states, open Shadow DOM, and same-origin iframe support
- `agentbrowser/lib/session.mjs` & `agentbrowser/lib/manager.mjs` — Isolated `BrowserContext` sessions over a shared Chromium instance with popup tracking, storage state, jailed uploads/downloads, idle TTL reaping, and crash recovery
- `agentbrowser/lib/policy.mjs` — Protocol/host guardrails, SSRF private-network & DNS filtering, and English/Bangla human-in-the-loop approval rules with timeout protection
- `agentbrowser/lib/agent.mjs` — Multi-engine research planner (DuckDuckGo, Bing, Brave, optional SearXNG) with Unicode/Bangla summarization and optional OpenAI-compatible LLM synthesis
- `agentbrowser/test/` — Unit, mock-DOM, live HTTP/MCP/SSE integration, and Playwright Chromium E2E tests
- `.github/workflows/ci.yml` — Automated CI across Node 20/22 plus Playwright Chromium E2E

## Testing

```sh
npm test
```

## License

[MIT](./LICENSE)
