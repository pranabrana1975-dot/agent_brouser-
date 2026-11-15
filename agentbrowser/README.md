# AgentBrowser

একটি headless browser control plane, মানুষের browsing UI নয়। Agent-রা HTTP API, JavaScript SDK অথবা MCP stdio bridge দিয়ে Chromium চালাতে পারে। পেজ থেকে সংক্ষিপ্ত text ও actionable `e1`, `e2` ref-সহ Agent Document পাওয়া যায়। Built-in research plannerটি heuristic, LLM নয়।

## চালানো

Node.js 18+ প্রয়োজন।

```sh
cd agentbrowser
npm ci
npx playwright install chromium  # Linux system dependencies-ও লাগতে পারে
npm start                        # ডিফল্ট: 127.0.0.1:3000
```

নেটওয়ার্কে প্রকাশ করতে হলে authentication token অবশ্যই দিন এবং TLS/reverse proxy ব্যবহার করুন:

```sh
HOST=0.0.0.0 PORT=3000 AGENT_BROWSER_TOKEN='a-long-random-secret' npm start
```

Token সেট করলে সব HTTP endpoint-এ `Authorization: Bearer <token>` প্রয়োজন। Browser service নিজে TLS সরবরাহ করে না। Token ছাড়া non-loopback bind নিষিদ্ধ। এটি একটিমাত্র shared browser session; trusted agents-দের মধ্যে ব্যবহার করুন।

## MCP agent সংযোগ

HTTP server আলাদাভাবে চালু রেখে MCP client-এ stdio command কনফিগার করুন (path নিজের checkout অনুযায়ী বদলান):

```json
{
  "mcpServers": {
    "agentbrowser": {
      "command": "node",
      "args": ["/absolute/path/to/agentbrowser/mcp.mjs"],
      "env": {
        "AGENT_BROWSER_URL": "http://127.0.0.1:3000",
        "AGENT_BROWSER_TOKEN": "your-token-if-enabled"
      }
    }
  }
}
```

MCP tools: `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_navigate`, `browser_tabs`, `browser_task`। `GET /api/tools`-এ একই tool catalogue পাওয়া যায়। MCP bridge কেবল tool transport; এটি browser server চালু করে না।

## JavaScript SDK

```js
import { AgentBrowser } from './sdk.mjs';
const browser = new AgentBrowser('http://127.0.0.1:3000', { token: process.env.AGENT_BROWSER_TOKEN });
const page = await browser.open('https://example.com');
console.log(page.text, page.boxes);
// await browser.click('e1'); // সবসময় সর্বশেষ snapshot-এর ref ব্যবহার করুন
```

অন্য integration-এর জন্য `POST /api/act`-এ `{ "op": "open", "url": "https://example.com" }` পাঠান। `GET /api/state`, `GET /api/events` (SSE), `POST /api/tab`, `POST /api/task`, `POST /api/policy`, `POST /api/pause`, `POST /api/reset` এবং `POST /api/approval` আছে। POST-এ JSON content type আবশ্যক। Action result-এ `blocked` বা `error` থাকতে পারে; SDK এগুলো exception হিসেবে প্রকাশ করে।

## Approval ও সীমাবদ্ধতা

কিছু বিপজ্জনক শব্দযুক্ত click বা submit approval-এর জন্য অপেক্ষা করে। আলাদা trusted supervisor `GET /api/state` বা SSE থেকে pending ID দেখে `POST /api/approval`-এ `{ "id": "a1", "allow": true }` পাঠাতে পারে। অনুমোদন না আসা পর্যন্ত সংশ্লিষ্ট action এবং তার পেছনের queued action অপেক্ষা করবে। এটিকে সম্পূর্ণ নিরাপত্তা ব্যবস্থা ভাববেন না: শব্দভিত্তিক heuristic সব বিপজ্জনক কাজ শনাক্ত করতে পারে না।

Host policy browser network request-এও প্রয়োগ করা হয়, তবে এটি **SSRF protection বা security sandbox নয়**: ডিফল্টে private network নিষিদ্ধ নয়, DNS rebinding ও অন্যান্য browser attack থেকে সুরক্ষার নিশ্চয়তা নেই। Untrusted agents বা websites-এর জন্য isolated container, network egress controls ও সঠিক access control ব্যবহার করুন। Chromium বর্তমানে `--no-sandbox` দিয়ে চলে। Page content ও লগে সংবেদনশীল তথ্য থাকতে পারে। Concurrent tab management ও task isolation সম্পূর্ণ নয়।

Tests: `npm test`. Browser end-to-end চালানোর জন্য Playwright Chromium install প্রয়োজন।
