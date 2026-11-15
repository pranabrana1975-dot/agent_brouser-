# AgentBrowser

একটি headless browser control plane ও **Agent DevTools ("F12 for Agents")** — মানুষের browsing UI নয়। AI agent-রা **HTTP API**, **JavaScript SDK**, **One-shot CLI**, **MCP stdio** (remote অথবা embedded), কিংবা **Streamable HTTP MCP (`/mcp`)** দিয়ে Chromium চালাতে এবং সরাসরি F12 DevTools দিয়ে পেজ ডিবাগ করতে পারে। পেজ থেকে কম token-এ actionable `e1..eN` ref, label, element state এবং `[devtools]` anomaly badge-সহ compact **Agent Document** তৈরি হয়।

## প্রধান বৈশিষ্ট্য

- **Smart Agent Document (`lib/snapshot.mjs`):** active modal, viewport এবং `<main>`/`<article>`/`<form>`-কে অগ্রাধিকার দেয়; প্রতি snapshot-এ নতুন অনন্য `e1..eN` ref দেয়; `<label for>`, `aria-labelledby`, icon alt, `disabled`/`checked`/`required`/`expanded` state, `<select>` options, open Shadow DOM, same-origin `<iframe>`, এবং error/toast থাকলে ১-লাইনের `[devtools]` স্ট্যাটাস ব্যাজ দেখায়।
- **৩০টি Agent ও DevTools Tool (`tools.mjs`):**
  - **Core Browsing (১৭টি):** `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_select`, `browser_press`, `browser_hover`, `browser_scroll`, `browser_wait`, `browser_wait_for`, `browser_extract`, `browser_read`, `browser_screenshot` (`annotate: true` Set-of-Mark সহ), `browser_upload`, `browser_navigate`, `browser_tabs`, `browser_task`।
  - **F12 Agent DevTools (১৩টি):** `browser_network`, `browser_console`, `browser_evaluate`, `browser_inspect`, `browser_a11y`, `browser_diff`, `browser_perf`, `browser_audit`, `browser_storage`, `browser_security`, `browser_emulate`, `browser_dialog`, `browser_trace`।
- **Network, Console & Diagnostics (`lib/devtools.mjs`):** `r1..rN` HTTP/XHR/Fetch লগ ও JSON response body, WebSocket ফ্রেম (`ws1..wsN`), HAR 1.2 export, `offline`/`slow-3g`/`fast-3g`/`4g` throttling, ad/tracker ও pattern blocker, API route mocking, `console.*` ও `pageerror` stack trace, JS dialog controller, এবং Playwright `.zip` trace recording। সব জায়গায় `Authorization`, `Cookie`, `Set-Cookie`, secret query param ও password ডিফল্টে `[REDACTED]` থাকে।
- **Elements, A11y, Diff, Perf, Audit, Storage & Security (`lib/inspector.mjs`):** যেকোনো `eN` ref বা CSS selector-এর box model, computed CSS ও click-occlusion নির্ণয় (`occludedBy`), পূর্ণ ARIA accessibility tree, DOM diff (`+`/`-`/`~`) ও ক্ষণস্থায়ী toast ধরা, Core Web Vitals + CDP JS heap/layout মেট্রিক্স, mini-Lighthouse অডিট (Accessibility/SEO/Security/Reliability), Cookies/Storage/IndexedDB/SW/Cache পরিদর্শন ও selective clear, TLS/CSP/HSTS/mixed-content ও third-party tracker বিশ্লেষণ, এবং iPhone/Pixel/iPad/dark-mode/geolocation/timezone emulation।
- **Structured Extraction ও CLI (`lib/extract.mjs`, `cli.mjs`):** `text`, rendered `html`, `markdown`, `links`, `forms` (field value ছাড়া), `tables` (HTML table → JSON) এবং `metadata` (OpenGraph, Twitter Card, JSON-LD, canonical, RSS feeds) নিষ্কাশন; পাশাপাশি CLI থেকেই `audit`, `perf`, `security`, `a11y`, `network`, `console` ও `inspect --selector`।
- **Multi-Session Isolation & Guardrails (`lib/manager.mjs`, `lib/policy.mjs`):** একটিমাত্র shared Chromium প্রসেসের ওপর আলাদা `BrowserContext` session (`x-session-id` / `Mcp-Session-Id`), SSRF/DNS-rebinding ব্লক, constant-time Bearer auth, jailed upload/download/trace ফোল্ডার, এবং timeout-সহ human approval gate (ইংরেজি ও বাংলা)। `browser_evaluate` ডিফল্টে বন্ধ (`AGENT_BROWSER_ALLOW_EVAL=1` ও human approval ছাড়া চলে না)।

## চালানো

**Node.js 20+** প্রয়োজন।

```sh
cd agentbrowser
npm ci
npx playwright install chromium   # Linux-এ প্রয়োজন হলে: npx playwright install --with-deps chromium
npm start                         # ডিফল্ট: http://127.0.0.1:3000 (MCP: http://127.0.0.1:3000/mcp)
```

Repo root থেকেও সরাসরি `npm run setup`, `npm start`, `npm test` চালানো যায়। নেটওয়ার্কে প্রকাশ করতে হলে token আবশ্যক:

```sh
HOST=0.0.0.0 PORT=3000 AGENT_BROWSER_TOKEN='a-long-random-secret' npm start
```

## MCP সংযোগ (৩টি উপায়)

1. **Embedded stdio (আলাদা server ছাড়া):** `node /absolute/path/to/agentbrowser/mcp.mjs --embedded`
2. **Remote stdio bridge:** `node /absolute/path/to/agentbrowser/mcp.mjs` (`AGENT_BROWSER_URL`, `AGENT_BROWSER_TOKEN`, `AGENT_BROWSER_SESSION` env সহ)
3. **Streamable HTTP MCP:** `POST http://127.0.0.1:3000/mcp` (ঐচ্ছিক `Mcp-Session-Id` ও `Authorization: Bearer <token>`; বন্ধ করতে `DELETE /mcp`)

## JavaScript SDK

```js
import { AgentBrowser } from './sdk.mjs';

const browser = new AgentBrowser('http://127.0.0.1:3000', {
  token: process.env.AGENT_BROWSER_TOKEN,
  sessionId: 'qa-1',
});

const page = await browser.open('https://example.com');
const tables = await browser.extract('tables');
const meta = await browser.extract('metadata');

// F12 Agent DevTools
const logs = await browser.console({ level: 'error', sinceLastAction: true });
const apiCalls = await browser.network({ resourceType: 'api', status: '4xx' });
const elem = await browser.inspect('e1');            // box model, computed CSS, click occlusion
const tree = await browser.a11y();                   // ARIA accessibility tree
const changes = await browser.diff();                // +added / -removed / ~modified + toasts
const perf = await browser.perf();                   // Web Vitals + CDP heap/nodes/layout
const audit = await browser.audit();                 // Accessibility / SEO / Security / Reliability
const storage = await browser.storage();             // Cookies, localStorage, IndexedDB, SW, Caches
const security = await browser.security();           // TLS, CSP/HSTS, mixed content, 3rd-party hosts
await browser.emulate({ device: 'iphone-15', colorScheme: 'dark' });
const annotated = await browser.screenshot({ annotate: true }); // [eN] Set-of-Mark overlay
```

## One-shot CLI

```sh
node cli.mjs fetch https://example.com --dump markdown
node cli.mjs fetch https://example.com --dump tables
node cli.mjs fetch https://example.com --dump metadata
node cli.mjs fetch https://example.com --dump audit --device iphone-15
node cli.mjs fetch https://example.com --dump security
node cli.mjs inspect https://example.com --selector "main h1"
```

`--dump` ফরম্যাট: `text`, `html`, `markdown`, `links`, `forms`, `tables`, `metadata`, `a11y`, `audit`, `perf`, `security`, `network`, `console`।

## HTTP Endpoints

| Method & Path | কাজ |
| --- | --- |
| `GET /api/health`, `GET /api/tools` | Engine readiness এবং ৩০টি tool-এর JSON Schema |
| `GET\|POST /api/sessions`, `GET\|DELETE /api/sessions/:id` | Multi-session তৈরি, তালিকা, দেখা ও বন্ধ করা |
| `GET /api/state`, `GET /api/events` | Session state (`devtools` summary সহ) ও SSE লাইভ স্ট্রিম |
| `GET /api/devtools`, `/api/network`, `/api/console`, `/api/perf`, `/api/audit`, `/api/security` | Read-only F12 DevTools inspection endpoints |
| `GET /api/shot.jpg` | সর্বশেষ বা নতুন (`?fresh=1`, `?fullPage=1`, `?annotate=1`) JPEG screenshot |
| `POST /api/act` | সব browser ও DevTools action (`open`, `click`, `type`, `extract`, `network`, `console`, `evaluate`, `inspect`, `a11y`, `diff`, `perf`, `audit`, `storage`, `security`, `emulate`, `dialog`, `trace` ইত্যাদি) |
| `POST /api/tab`, `/api/task`, `/api/policy`, `/api/approval`, `/api/pause`, `/api/reset` | Tab, research task, policy, human approval, pause ও reset |
| `GET\|POST /api/storage`, `GET /api/downloads` | Playwright `storageState` export/import এবং ডাউনলোড তালিকা |
| `POST\|DELETE /mcp` | Streamable HTTP MCP endpoint |

## গুরুত্বপূর্ণ Environment Variables

- `HOST` (`127.0.0.1`), `PORT` (`3000`), `AGENT_BROWSER_TOKEN`
- `ALLOW_PRIVATE_NETWORKS=1` — লোকাল/প্রাইভেট নেটওয়ার্ক অ্যাক্সেস চালু করতে (ডিফল্টে বন্ধ)
- `AGENT_BROWSER_ALLOW_EVAL=1` — `browser_evaluate` চালু করতে (ডিফল্টে বন্ধ; চালু থাকলেও human approval লাগে)
- `AGENT_BROWSER_ALLOW_STORAGE_VALUES=1` — `browser_storage`-এ কাঁচা cookie/secret value দেখার অনুমতি (ডিফল্টে বন্ধ ও `[REDACTED]`)
- `AGENT_BROWSER_UPLOAD_DIR`, `AGENT_BROWSER_DOWNLOAD_DIR`, `AGENT_BROWSER_TRACE_DIR` — jailed upload, download ও `.zip` trace ফোল্ডার
- `AGENT_BROWSER_NO_SANDBOX=1`, `CHROMIUM_EXECUTABLE_PATH`, `AGENT_BROWSER_VIEWPORT`, `AGENT_BROWSER_LOCALE`, `AGENT_BROWSER_TIMEZONE`, `AGENT_BROWSER_UA`
- `AGENT_BROWSER_MAX_SESSIONS` (`8`), `AGENT_BROWSER_SESSION_TTL_MS` (`1800000`), `AGENT_BROWSER_MAX_TABS` (`12`), `AGENT_BROWSER_MAX_ACTIONS` (`2000`), `AGENT_BROWSER_APPROVAL_TIMEOUT_MS` (`120000`)
- `AGENT_BROWSER_SEARCH_ENGINES` (`duckduckgo,bing,brave`), `AGENT_BROWSER_SEARXNG_URL`, `AGENT_BROWSER_LLM_API_KEY`, `AGENT_BROWSER_LLM_BASE_URL`, `AGENT_BROWSER_LLM_MODEL`

## টেস্ট

```sh
npm test          # সব unit, DevTools, integration এবং (Chromium থাকলে) E2E test
npm run test:unit # Chromium ছাড়াই দ্রুত unit + DevTools + integration test
npm run test:e2e  # Playwright Chromium end-to-end test
```
