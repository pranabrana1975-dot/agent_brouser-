# AgentBrowser

একটি headless browser control plane, মানুষের browsing UI নয়। AI agent-রা **HTTP API**, **JavaScript SDK**, **MCP stdio** (remote অথবা embedded), কিংবা **Streamable HTTP MCP (`/mcp`)** দিয়ে Chromium চালাতে পারে। পেজ থেকে কম token-এ actionable `e1..eN` ref, label ও element state-সহ compact **Agent Document** তৈরি হয়।

## প্রধান বৈশিষ্ট্য

- **Smart Agent Document (`lib/snapshot.mjs`):** active modal, viewport এবং `<main>`/`<article>`/`<form>`-কে অগ্রাধিকার দেয়; প্রতি snapshot-এ নতুন অনন্য `e1..eN` ref দেয় যাতে পুরনো ref ভুল element-এ না লাগে; `<label for>`, `aria-labelledby`, icon alt, `disabled`/`checked`/`required`/`expanded` state, `<select>` options, open Shadow DOM এবং same-origin `<iframe>` সমর্থন করে।
- **১৭টি Agent Tool (`tools.mjs`):** `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_select`, `browser_press`, `browser_hover`, `browser_scroll`, `browser_wait`, `browser_wait_for`, `browser_extract`, `browser_read`, `browser_screenshot`, `browser_upload`, `browser_navigate`, `browser_tabs`, `browser_task`।
- **Structured Extraction ও One-Shot CLI (`lib/extract.mjs`, `cli.mjs`):** `text`, rendered `html`, `markdown`, `links` এবং `forms` (field value ছাড়া) নিষ্কাশন ও সরাসরি shell pipeline-এ ব্যবহার।
- **Multi-Session Isolation (`lib/manager.mjs`):** একটিমাত্র shared Chromium প্রসেসের ওপর আলাদা `BrowserContext`-ভিত্তিক session (`x-session-id` / `Mcp-Session-Id`), idle TTL cleanup ও automatic crash recovery।
- **Security & Guardrails (`lib/policy.mjs`):** ডিফল্টে private/loopback/metadata IP ও DNS-rebinding SSRF ব্লক, label-aware domain allow/block list, constant-time Bearer auth, password log masking, jailed file upload, এবং timeout-সহ human approval gate (ইংরেজি ও বাংলা)।
- **Multi-Engine Planner (`lib/agent.mjs`):** DuckDuckGo → Bing → Brave (এবং ঐচ্ছিক SearXNG) fallback, Unicode/বাংলা-সচেতন extractive summary, per-task action budget, এবং ঐচ্ছিক OpenAI-compatible LLM synthesis hook।

## চালানো

**Node.js 20+** প্রয়োজন।

```sh
cd agentbrowser
npm ci
npx playwright install chromium   # Linux-এ প্রয়োজন হলে: npx playwright install --with-deps chromium
npm start                         # ডিফল্ট: http://127.0.0.1:3000 (MCP: http://127.0.0.1:3000/mcp)
```

Repo root থেকেও সরাসরি `npm run setup`, `npm start`, `npm test` চালানো যায়।

নেটওয়ার্কে প্রকাশ করতে হলে authentication token আবশ্যক এবং সামনে TLS/reverse proxy রাখুন:

```sh
HOST=0.0.0.0 PORT=3000 AGENT_BROWSER_TOKEN='a-long-random-secret' npm start
```

Token সেট করলে সব HTTP ও `/mcp` endpoint-এ `Authorization: Bearer <token>` প্রয়োজন। Token ছাড়া non-loopback bind নিষিদ্ধ।

## MCP সংযোগ (৩টি উপায়)

### ১) Embedded stdio (আলাদা server চালাতে হবে না)

```json
{
  "mcpServers": {
    "agentbrowser": {
      "command": "node",
      "args": ["/absolute/path/to/agentbrowser/mcp.mjs", "--embedded"]
    }
  }
}
```

### ২) Remote stdio bridge (চলমান HTTP control plane-এর সাথে)

```json
{
  "mcpServers": {
    "agentbrowser": {
      "command": "node",
      "args": ["/absolute/path/to/agentbrowser/mcp.mjs"],
      "env": {
        "AGENT_BROWSER_URL": "http://127.0.0.1:3000",
        "AGENT_BROWSER_TOKEN": "your-token-if-enabled",
        "AGENT_BROWSER_SESSION": "agent-1"
      }
    }
  }
}
```

### ৩) Streamable HTTP MCP

সরাসরি `POST http://127.0.0.1:3000/mcp`-এ JSON-RPC 2.0 পাঠান (ঐচ্ছিক `Mcp-Session-Id` ও `Authorization: Bearer <token>` header-সহ; session বন্ধ করতে `DELETE /mcp`)।

Token বাঁচাতে MCP tool-গুলো ডিফল্টে compact text ফরম্যাটে Agent Document ফেরত দেয় (`browser_snapshot`-এ `{ "full": true }` দিলে `boxes` পাওয়া যায়) এবং `browser_screenshot` সরাসরি MCP `image/jpeg` content পাঠায়।

## JavaScript SDK

```js
import { AgentBrowser } from './sdk.mjs';

const browser = new AgentBrowser('http://127.0.0.1:3000', {
  token: process.env.AGENT_BROWSER_TOKEN,
  sessionId: 'research-1', // ঐচ্ছিক isolated session (ডিফল্ট: "default")
  timeoutMs: 60_000,
});

const page = await browser.open('https://example.com');
console.log(page.text, page.boxes);

// Element, extraction ও page actions (সর্বশেষ snapshot-এর ref ব্যবহার করুন)
// const markdown = await browser.extract('markdown');
// await browser.waitFor('main', 10000);
// await browser.click('e1');
// await browser.type('e2', 'hello', { submit: true });
// await browser.select('e3', 'বাংলা');
// await browser.press('Escape');
// await browser.hover('e4');
// await browser.wait({ text: 'Done', timeoutMs: 5000 });
// const article = await browser.read({ maxChars: 15000 });
// const image = await browser.screenshot(); // { mimeType: 'image/png', base64, ... }
```

## One-shot CLI

HTTP server ছাড়াই সরাসরি Chromium দিয়ে পেজ খুলে পাইপ করা যায়:

```sh
node cli.mjs fetch https://example.com --dump markdown
node cli.mjs fetch https://example.com --dump links
node cli.mjs fetch https://example.com --dump text --max-chars 10000
```

`--dump`-এর format: `text`, `html`, `markdown`, `links`, `forms`। Links ও forms JSON; অন্য format text। প্রয়োজনে `CHROMIUM_EXECUTABLE_PATH` দিয়ে বিদ্যমান Chromium executable নির্দিষ্ট করা যায়।

## Obscura থেকে পার্থক্য

[Obscura](https://github.com/h4ckf0r0day/obscura) নিজস্ব Rust/V8 engine ও CDP implementation ব্যবহার করে। এই project Chromium + Playwright ব্যবহার করে; Obscura-এর memory, speed, stealth বা সম্পূর্ণ tool/CDP compatibility-এর দাবি করা হচ্ছে না। Snapshot ref-গুলো কেবল সর্বশেষ snapshot-এর জন্য বৈধ; navigation বা page পরিবর্তনের পরে আবার snapshot নিন। Extraction সীমাবদ্ধ এবং পূর্ণ accessibility tree নয়।

## HTTP Endpoints

| Method & Path | কাজ |
| --- | --- |
| `GET /api/health` | Engine readiness ও active session সংখ্যা |
| `GET /api/tools` | Tool catalogue ও JSON Schema |
| `GET /api/sessions`, `POST /api/sessions`, `GET\|DELETE /api/sessions/:id` | Multi-session তৈরি, তালিকা, দেখা ও বন্ধ করা |
| `GET /api/state` | বর্তমান session-এর state, tabs, snapshot, log ও pending approvals |
| `GET /api/events` | Server-Sent Events (SSE) লাইভ স্ট্রিম |
| `GET /api/shot.jpg` | সর্বশেষ বা নতুন (`?fresh=1`, `?fullPage=1`) JPEG screenshot |
| `POST /api/act` | Browser action (`open`, `snapshot`, `click`, `type`, `select`, `press`, `hover`, `scroll`, `wait`, `read`, `screenshot`, `upload`, `back`, `forward`, `reload`) |
| `POST /api/tab` | Tab পরিচালনা (`new`, `select`, `close`) |
| `POST /api/task` | Research planner চালানো |
| `POST /api/policy` | `approvalsEnabled`, `allowPrivateNetworks`, `approvalTimeoutMs`, `allowedHosts`, `blockedHosts` (string বা array) |
| `POST /api/approval` | `{ "id": "a1", "allow": true }` দিয়ে ঝুঁকিপূর্ণ কাজের অনুমোদন/বাতিল |
| `POST /api/pause` | `{ "paused": true }` দিয়ে human takeover pause/resume |
| `POST /api/reset` | Session context, tabs, pending approval ও action budget রিসেট |
| `GET\|POST /api/storage` | Playwright `storageState` (cookies + localStorage) export/import |
| `GET /api/downloads` | সংরক্ষিত ডাউনলোডের তালিকা |
| `POST\|DELETE /mcp` | Streamable HTTP MCP endpoint |

যেকোনো session-scoped endpoint-এ `X-Session-Id: <id>` header (অথবা GET-এ `?session=<id>`) পাঠানো যায়।

## গুরুত্বপূর্ণ Environment Variables

- `HOST` (ডিফল্ট `127.0.0.1`), `PORT` (ডিফল্ট `3000`), `AGENT_BROWSER_TOKEN`
- `ALLOW_PRIVATE_NETWORKS=1` — লোকাল/প্রাইভেট নেটওয়ার্কে অ্যাক্সেস চালু করতে (ডিফল্টে বন্ধ)
- `AGENT_BROWSER_NO_SANDBOX=1` — সীমাবদ্ধ কন্টেইনারে Chromium `--no-sandbox` প্রয়োজন হলে (ডিফল্টে sandbox চালু)
- `AGENT_BROWSER_VIEWPORT` (`1280x800`), `AGENT_BROWSER_LOCALE` (`en-US`), `AGENT_BROWSER_TIMEZONE` (`Asia/Kolkata`), `AGENT_BROWSER_UA`
- `AGENT_BROWSER_MAX_SESSIONS` (`8`), `AGENT_BROWSER_SESSION_TTL_MS` (`1800000`), `AGENT_BROWSER_MAX_TABS` (`12`), `AGENT_BROWSER_MAX_ACTIONS` (`2000`), `AGENT_BROWSER_APPROVAL_TIMEOUT_MS` (`120000`)
- `AGENT_BROWSER_UPLOAD_DIR`, `AGENT_BROWSER_DOWNLOAD_DIR` — jailed file upload ও download ফোল্ডার
- `AGENT_BROWSER_SEARCH_ENGINES` (`duckduckgo,bing,brave`), `AGENT_BROWSER_SEARXNG_URL`
- `AGENT_BROWSER_LLM_API_KEY`, `AGENT_BROWSER_LLM_BASE_URL`, `AGENT_BROWSER_LLM_MODEL` — ঐচ্ছিক OpenAI-compatible LLM synthesis

## নিরাপত্তা ও সীমাবদ্ধতা

- ঝুঁকিপূর্ণ click, form submit, credential submit এবং file upload human approval-এর জন্য অপেক্ষা করে এবং নির্ধারিত সময়ের মধ্যে উত্তর না এলে স্বয়ংক্রিয়ভাবে বাতিল হয়। তবে heuristic নিয়ম সব ঝুঁকিপূর্ণ কাজ শনাক্ত করতে পারে না।
- ডিফল্টে private/loopback/cloud-metadata IP ও প্রাইভেট DNS রেজোলিউশন ব্লক করা হয়, তবুও untrusted agent বা website চালানোর সময় আলাদা container, OS sandbox এবং network egress firewall ব্যবহার করুন।

## টেস্ট

```sh
npm test          # সব unit, integration এবং (Chromium থাকলে) E2E test
npm run test:unit # Chromium ছাড়াই দ্রুত unit + integration test
npm run test:e2e  # Playwright Chromium end-to-end test
```
