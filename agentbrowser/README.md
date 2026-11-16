# AgentBrowser v2.0

একটি পূর্ণাঙ্গ **AI Browser Platform** — hardened headless Chromium control plane, **Live Supervisor Mission Control ও Human Takeover UI (`/dashboard`)**, **Batch ও Zero-Token Workflow Record/Replay + Playwright Codegen**, **F12 Agent DevTools**, **Autonomous Browser Agent v2 ও Schema Scraper**, zero-dependency **JavaScript/TypeScript SDK (`sdk.mjs` + `sdk.d.ts`)**, **One-shot CLI**, **Full MCP Server** (৩৭টি Tool + Resources + Prompts + Delta Snapshot), **Prometheus `/metrics`**, এবং production **Docker** সাপোর্ট।

## প্রধান বৈশিষ্ট্য (v2.0)

1. **Live Supervisor Dashboard & Human Takeover (`/dashboard`, `POST /api/takeover`):** কোনো এক্সটার্নাল ফ্রেমওয়ার্ক ছাড়াই দ্রুতগতির ওয়েব Mission Control UI — লাইভ ব্রাউজার ভিউপোর্ট (`[eN]` Set-of-Mark ব্যাজসহ), pending approval-এর জন্য ১-ক্লিক **Approve / Deny** কার্ড, **Human Takeover** মোড (CAPTCHA / OTP / 2FA সমাধানের জন্য এজেন্ট pause করে সরাসরি মাউস click/drag/scroll ও গোপন OTP type করে আবার এজেন্টকে নিয়ন্ত্রণ ফিরিয়ে দেওয়া), multi-session switcher, লাইভ workflow recorder/replayer, এবং Timeline / Network / Console / Audit / Snapshot / Workflows প্যানেল।
2. **Batch Actions ও Workflow Record, Replay, Playwright Codegen (`browser_batch`, `browser_workflow`):** এক কলেই একাধিক ধাপ চালানো যায় (`browser_batch`) — error, অপ্রত্যাশিত navigation বা denied approval হলে সাথে সাথে থেমে যায়। `browser_workflow` দিয়ে semantic selector (`role + label + CSS fallback`) সহ `.workflow.json` রেকর্ড করা যায় (পাসওয়ার্ড/secret স্বয়ংক্রিয়ভাবে `{{secret_N}}` ভেরিয়েবলে রূপান্তরিত হয়), **০ LLM token**-এ `{{variable}}` বসিয়ে পুনরায় চালানো যায়, এবং সরাসরি `@playwright/test` `*.spec.mjs` ফাইল এক্সপোর্ট করা যায়।
3. **উন্নত ইন্টারঅ্যাকশন, Cross-Origin Iframe, PDF, Download Inspector ও Visual Diff (`lib/visual.mjs`, `lib/session-ops.mjs`):** `browser_drag` (Kanban/slider drag & drop), `dblclick`, `right-click`, modifier click, multi-key shortcut (`keys: [...]`), approval-gated `browser_clipboard`, cross-origin `<iframe>` সাপোর্ট (`frame=fN:xorigin`), `browser_pdf` (SHA-256 ও page count সহ), `browser_downloads` (CSV/TSV/JSON/JSONL/text/PDF/PNG ফাইলের নিরাপদ jailed প্রিভিউ ও secret redaction), এবং zero-dependency `browser_visual_diff` (দুটি স্ক্রিনশটের pixel diff %, bounding box, hotspots ও হাইলাইট করা diff PNG)।
4. **Autonomous Browser Agent v2 ও Schema/Paginated Scraper (`lib/agent.mjs`, `lib/extract.mjs`):** পূর্ণ **Observe → Plan → Act → Verify** লুপ — ফর্ম পূরণ, cookie/modal দ্বারা ব্লক হওয়া বাটন নিজে থেকে সরিয়ে নেওয়া (proactive ও reactive occlusion self-healing), DOM diff যাচাই, ঐচ্ছিক LLM planner, এবং বাংলা/ইংরেজি বহু-উৎস গবেষণা। `browser_extract`-এ যোগ হয়েছে `items` (কার্ড/পণ্য তালিকা), `schema` (typed CSS → JSON) এবং `maxPages` দিয়ে স্বয়ংক্রিয় `Next` পেজ pagination।
5. **F12 Agent DevTools (১৩টি টুল):** `browser_network` (HTTP/XHR/Fetch/WebSocket/HAR/throttle/block/mock), `browser_console`, `browser_evaluate` (ডিফল্টে বন্ধ + approval-gated), `browser_inspect`, `browser_a11y`, `browser_diff`, `browser_perf`, `browser_audit`, `browser_storage`, `browser_security`, `browser_emulate`, `browser_dialog`, ও `browser_trace`।
6. **Full MCP Spec ও Delta Mode (`mcp.mjs`, `lib/mcp-handler.mjs`):** ৩৭টি টুল ছাড়াও `resources/list`, `resources/templates/list`, `resources/read` (`browser://snapshot`, `browser://state`, `browser://console`, `browser://network`, `browser://network/har`, `browser://screenshot`, `browser://workflows/{name}/playwright`, `browser://downloads/{id}`, `browser://trace` ইত্যাদি), ৫টি রেডিমেড `prompts/list` ও `prompts/get` (`qa_audit`, `security_review`, `research_topic`, `scrape_structured`, `record_workflow`), এবং টোকেন-সাশ্রয়ী `delta: true` স্ন্যাপশট।
7. **TypeScript, Docker, Prometheus `/metrics` ও Per-Session Proxy:** সম্পূর্ণ TypeScript টাইপ (`sdk.d.ts`, `tools.d.ts`), non-root production `Dockerfile` ও `docker-compose.yml` (`shm_size: "1gb"`, healthcheck, jailed volumes), Prometheus `/metrics` ও `/api/metrics`, এবং প্রতি সেশনে SSRF-সুরক্ষিত HTTP/HTTPS/SOCKS5 proxy সাপোর্ট।

## চালানো

**Node.js 20+** অথবা **Docker** প্রয়োজন।

```sh
cd agentbrowser
npm ci
npx playwright install chromium   # Linux-এ প্রয়োজন হলে: npx playwright install --with-deps chromium
npm start
```

সার্ভার চালু হলে ডিফল্ট ঠিকানা:
- **Control Plane API:** `http://127.0.0.1:3000`
- **Live Supervisor Dashboard:** `http://127.0.0.1:3000/dashboard`
- **Streamable HTTP MCP:** `http://127.0.0.1:3000/mcp`
- **Prometheus Metrics:** `http://127.0.0.1:3000/metrics`

নেটওয়ার্কে বা Docker-এ চালাতে `AGENT_BROWSER_TOKEN` আবশ্যক:

```sh
AGENT_BROWSER_TOKEN="$(openssl rand -hex 32)" docker compose up --build -d
```

## JavaScript / TypeScript SDK উদাহরণ

```js
import { AgentBrowser } from './sdk.mjs';

const browser = new AgentBrowser('http://127.0.0.1:3000', {
  token: process.env.AGENT_BROWSER_TOKEN,
  sessionId: 'qa-1',
});

// Workflow রেকর্ড + Batch অ্যাকশন + Replay + Playwright টেস্ট এক্সপোর্ট
await browser.startRecording('checkout-smoke');
const s = await browser.open('https://example.com');
await browser.visualDiff('baseline', { name: 'landing' });
await browser.stopRecording({ save: true });
const { code } = await browser.exportPlaywright('checkout-smoke');

// Paginated Schema Scraping ও PDF Export
const data = await browser.extract('schema', {
  maxPages: 3,
  schema: {
    container: 'article.card',
    fields: {
      title: 'h2 a',
      url: { selector: 'h2 a', attr: 'href', type: 'url' },
      price: '.price',
    },
  },
});
const pdf = await browser.pdf({ format: 'A4', save: true, filename: 'report' });
const metrics = await browser.metrics('json');
```

## MCP সংযোগ (৩টি উপায়)

1. **Embedded stdio (আলাদা server ছাড়া):** `node /absolute/path/to/agentbrowser/mcp.mjs --embedded`
2. **Remote stdio bridge:** `node /absolute/path/to/agentbrowser/mcp.mjs` (`AGENT_BROWSER_URL`, `AGENT_BROWSER_TOKEN`, `AGENT_BROWSER_SESSION` env সহ)
3. **Streamable HTTP MCP:** `POST http://127.0.0.1:3000/mcp` (`Mcp-Session-Id` ও `Authorization: Bearer <token>`; সেশন বন্ধ করতে `DELETE /mcp`)

## প্রধান পরিবেশ চলক (Environment Variables)

| চলক | ডিফল্ট | কাজ |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `3000` | HTTP bind ঠিকানা ও পোর্ট (non-loopback হলে `AGENT_BROWSER_TOKEN` আবশ্যক) |
| `AGENT_BROWSER_TOKEN` | ফাঁকা | API, SSE, `/metrics` ও `/mcp`-এর Bearer token |
| `ALLOW_PRIVATE_NETWORKS` | `false` | `1`/`true` দিলে localhost/private IP ও private proxy অনুমোদিত হয় |
| `AGENT_BROWSER_ALLOW_EVAL` | `false` | `1`/`true` দিলে approval-gated `browser_evaluate` চালু হয় |
| `AGENT_BROWSER_PROXY` | ফাঁকা | ডিফল্ট HTTP/HTTPS/SOCKS5 proxy (সেশন তৈরির সময় আলাদা `proxy` দেওয়াও যায়) |
| `AGENT_BROWSER_MAX_SESSIONS` / `AGENT_BROWSER_SESSION_TTL_MS` | `8` / `1800000` | সর্বোচ্চ সমান্তরাল সেশন ও নিষ্ক্রিয় সেশনের TTL |
| `AGENT_BROWSER_UPLOAD_DIR` / `AGENT_BROWSER_DOWNLOAD_DIR` | ফাঁকা | ফাইল আপলোড, ডাউনলোড ও PDF সংরক্ষণের jailed ফোল্ডার |
| `AGENT_BROWSER_TRACE_DIR` / `AGENT_BROWSER_WORKFLOW_DIR` | `./traces` / `./workflows` | Playwright trace `.zip` ও `.workflow.json` সংরক্ষণের jailed ফোল্ডার |
| `AGENT_BROWSER_LLM_API_KEY` / `URL` / `MODEL` | ফাঁকা | Autonomous Agent v2 planner ও research সারাংশের জন্য ঐচ্ছিক LLM |

## পরীক্ষা (Tests)

```sh
npm --prefix agentbrowser test
```
