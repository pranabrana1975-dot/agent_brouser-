# AgentBrowser — শুধু এজেন্টের জন্য ব্রাউজার

**একটা ব্রাউজার, যেখানে মানুষ ব্রাউজ করতে পারে না।** Chromium ইঞ্জিন, কিন্তু ভেতরে কোনো "হিউম্যান ট্যাব, বুকমার্ক, পিক্সেল-প্রেম" নেই — শুধু এজেন্টের জন্য একটা মেশিন-রিডেবল সারফেস। মানুষ শুধু দেখে, অনুমোদন দেয়, আর দরকারে থামিয়ে দেয়।

```
                       ┌──────────────────────────────┐
                       │   LLM / agent (বা SDK)       │
                       └──────────────┬───────────────┘
                    open · snapshot · click · type · scroll
                                      │  JSON / SSE
                       ┌──────────────▼───────────────┐
                       │   AgentBrowser control plane  │   ← server.mjs
                       │  policy · approvals · tabs    │
                       └──────────────┬───────────────┘
                            CDP (real browser protocol)
                       ┌──────────────▼───────────────┐
                       │  Chromium 131 (headless shell)│
                       └──────────────┬───────────────┘
                                      │
                        Agent Document  (text, refs e1…eN)
                                      │
                    ┌─────────────────▼──────────────────┐
                    │  Oversight console (মানুষের জন্য)   │  ← শুধু দেখার/অনুমোদনের UI
                    └────────────────────────────────────┘
```

---

## ১. এটা কী, আর কী নয়

**এটা কী:**
- বাস্তব **Chromium** (headless shell 131.0.6778.33), CDP দিয়ে চালিত — টয় ব্রাউজার নয়, আসল ইঞ্জিন, আসল নেটওয়ার্ক, আসল JavaScript।
- এজেন্ট-ফার্স্ট সারফেস: পেজ পিক্সেল হিসেবে নয়, **Agent Document** হিসেবে আসে — `e1, e2, e3…` ref দিয়ে প্রতিটা অ্যাকশনযোগ্য এলিমেন্ট।
- একটা **guardrail layer**: টাকা/ডিলিট/পাবলিশ-জাতীয় অ্যাকশনে মানুষের অনুমোদন লাগে; dangerous host ব্লক করা যায়; এজেন্ট যেকোনো সময় pause করা যায়।
- একটা **built-in planner** (API key ছাড়াই চলে) — নিজেই সার্চ বক্সে টাইপ করে, Enter দেয়, রেজাল্ট কার্ড পড়ে, সোর্স খুলে যাচাই করে, তারপর উত্তর দেয়।

**এটা কী নয়:**
- এটা Chromium-এর সোর্স ফর্ক করা একটা `.exe`/`.dmg` ডিস্ট্রিবিউশন নয় (সেটার জন্য ৪০+ GB সোর্স + ঘণ্টা-খানেক বিল্ড লাগে, নিচে ৬ নম্বরে রাস্তা লেখা আছে)। এটা সেই ব্রাউজারের **product layer** — যা ডিস্ট্রিবিউশনের ভেতরেও বসানো যাবে।
- মানুষের জন্য Chrome-এর বিকল্প নয় — ইচ্ছাকৃতভাবেই।

---

## ২. চালানো

```bash
cd agentbrowser
npm install                    # playwright
npx playwright install chromium # ইঞ্জিন ডাউনলোড (~170 MB)
node server.mjs                 # → http://localhost:3000
```

প্রথমবার Linux-এ system lib লাগতে পারে:
```bash
sudo apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libxkbcommon0 libxdamage1 libxcomposite1 libxrandr2 libxfixes3 libpango-1.0-0 \
  libcairo2 libasound2t64 libatspi2.0-0 libgbm1
```

তারপর ব্রাউজারে `http://localhost:3000` খুলুন → **Oversight Console**।

---

## ৩. এজেন্টের চারটা (আর মাত্র চারটা) প্রিমিটিভ

| tool | API | কী হয় |
|---|---|---|
| `open(url)` | `POST /api/act {op:"open",url}` | নেভিগেট, পলিসি চেক, নতুন Agent Document |
| `snapshot()` | `GET /api/state` | পেজের কম্প্যাক্ট টেক্সট ভিউ + refs + box coords |
| `click(ref)` | `POST /api/act {op:"click",ref}` | ref-এ ক্লিক (guardrail চেক সহ) |
| `type(ref,text,submit)` | `POST /api/act {op:"type",…}` | ফিল্ডে টাইপ, দরকারে Enter |

যোগ হিসেবে: `scroll`, `back/forward/reload`, `GET /api/shot.jpg` (মানুষের চোখের জন্য), `POST /api/task` (পুরো টাস্ক), `GET /api/events` (SSE লাইভ স্ট্রিম)।

`Agent Document` এইরকম দেখতে:

```
[url] https://en.wikipedia.org/wiki/Headless_browser
[title] Headless browser - Wikipedia
[viewport] 1280x800  scrollY=0/2945
e1 link "" → /wiki/Main_Page
e2 searchbox "Search Wikipedia"
e3 button "Search"
e9 link "Use cases" → #Use_cases
h1[v] "Headless browser"
· A headless browser is a web browser without a graphical user interface.
```

পুরো HTML ছিল ~৫,০০,০০০ বাইট → ডকুমেন্ট ~১,৯৭৯ টোকেন। কনসোলে **ctx saved 98%** সেটাই দেখায়। এজেন্ট কখনো স্ক্রিনশট পড়ে না — পিক্সেল শুধু মানুষের জন্য।

**SDK** (অন্য এজেন্টকে দিতে):

```js
import { AgentBrowser } from './sdk.mjs';
const b = new AgentBrowser('http://localhost:3000');
await b.open('https://en.wikipedia.org/wiki/Headless_browser');
await b.type('e2', 'headless chrome', { submit: true });
console.log(await b.task('what is a headless browser?'));
```

---

## ৪. কনসোলে যা যা করা যায়

1. **টাস্ক দিন** (বাঁ দিক) → `run agent`. এজেন্ট নিজে ব্রাউজ করে; ডান দিকে *activity* ট্যাবে প্রতিটা স্টেপ দেখা যায়, *answer* ট্যাবে উত্তর + সোর্স।
2. **Ref overlay** — ভিউপোর্টের উপর সায়ান বক্স = `e`-ref। বক্সে ক্লিক করলে নিচের REPL-এ `click e7` বসে যায় → এজেন্ট-কমান্ড হিসেবে চালান।
3. **REPL** (নিচে): `open wikipedia.org`, `click e12`, `type e5 "tokyo" enter`, `scroll 800`, `back`, `snapshot`।
4. **Guardrail test**: *guardrails* সেকশনে **“test guardrail”** চাপুন → এজেন্ট নিজে একটা ডেমো-অ্যাকাউন্ট পেজে গিয়ে “Delete account permanently” চাপতে যায় → **HUMAN APPROVAL REQUIRED** মডাল: `data loss — matched "Delete"` → deny/approve। (ডেমো পেজটা এই সার্ভারই `/demo/risky`-তে সার্ভ করে — কোনো আসল সাইটে কিছু হয় না।)
5. **Human takeover** — উপরে ডানে ⏸। এজেন্ট পরের স্টেপে থেমে যায়; আপনি REPL দিয়ে নিজে চালাতে পারেন, তারপর ▶ resume।
6. **Tabs** — একাধিক পেজ, প্রতিটা আলাদা context নয়, একই session।

---

## ৫. Guardrails (কেন এটা শুধু এজেন্টের, তবু নিরাপদ)

`lib/policy.mjs`-এ:

- **Red zone**: `delete/destroy/pay/checkout/transfer/cancel account/publish/post…` প্যাটার্ন ধরা পড়লে অ্যাকশন থেমে যায়, মানুষের সিগনেচার লাগে। না দিলে এজেন্ট "denied by human" পেয়ে প্ল্যান বদলায়।
- **Host policy**: `*.bank*`, `accounts.google.com` ডিফল্ট ব্লকড; allowlist দিলে শুধু সেখানে যাবে; `file://` সবসময় বন্ধ।
- **Dialog auto-dismiss**: `alert/confirm/prompt` অটো-বাতিল + লগ (এজেন্ট যাতে ফেঁসে না যায়)।
- **Throttle + budget**: প্রতি অ্যাকশনে ≥350 ms গ্যাপ, টাস্কে অ্যাকশন-বাজেট।
- **Pause / kill**: paused থাকলে প্রতিটা অ্যাকশন ব্লক; `⟲` পুরো Chromium process নতুন করে তোলে।

---

## ৬. আসল Chromium ফর্ক করতে চাইলে রাস্তা

এই রিপোটা ইঞ্জিনের *উপরে* সারফেস বানায়। ফর্ক চাইলে তিন ধাপে:

1. **Shell replacement (সহজ, ১–২ দিন)** — `headless_shell` বাইনারিটার সাথে এই control plane জুড়ে দিন; নিজের WebView/UI-তে পিক্সেল দেখান (এখানে যেমন `shot.jpg` দেখানো হচ্ছে)।
2. **Patch layer (মাঝারি)** — `content/` + `chrome/`-এ ফ্ল্যাগ: ভিজ্যুয়াল কম্পোজিটিং বন্ধ, `Accessibility.getFullAXTree` + DOM snapshot-ই প্রাইমারি আউটপুট, থার্ড-পার্টি ট্র্যাকিং পিক্সেল লোড না করা, ডিফল্টে কুকি সেশন-স্কোপড। নাম দেওয়া যাক `--agent-mode`।
3. **Full fork (ভারী)** — `depot_tools fetch chromium` (≈৪০ GB), patch → `autoninja -C out/Release chrome`, তারপর উপরে এই app-টা preload/extension হিসেবে বসান। সাইনিং/আপডেট পাইপলাইন আলাদা কাজ।

মাঝপথের সৎ বিকল্প: **CEF** (Chromium Embedded Framework) — ফর্ক ছাড়াই নিজের ব্রাউজার বাইনারি, আর ইঞ্জিন আপগ্রেড ম্যানেজ করা সহজ।

---

## ৭. ফাইল ম্যাপ

```
agentbrowser/
├── server.mjs            # control plane: HTTP API, SSE, static, /demo/risky
├── lib/
│   ├── session.mjs       # Chromium session, tabs, actions, approvals, screenshots
│   ├── snapshot.mjs      # DOM → Agent Document (refs, tokens, boxes)
│   ├── agent.mjs         # built-in planner (search → read → verify → answer)
│   └── policy.mjs        # red-zone rules, host allow/block, budgets
├── public/index.html     # oversight console UI (single file, no CDN)
├── sdk.mjs               # 4-primitive client for other agents
└── console.png · console-approval.png
```

---

## ৮. সীমাবদ্ধতা (সৎভাবে)

- ডেমো planner **deterministic** — LLM ছাড়া heuristic দিয়ে প্ল্যান করে। `lib/agent.mjs`-এর `runTask`-এ মডেল বসালেই পুরো ਸਮਰਥা পাবেন; বাকি ব্রাউজার বদলাতে হবে না।
- SERP গুলো (Bing) rate-limit করে; ফলাফল না এলে কোড fallback হিসেবে পেজ-টেক্সট পড়ে।
- একটাই Chromium instance, memory অনুযায়ী ৩–৫ ট্যাব আরামে চলে।
- Bengali প্রশ্নে ভালো কাজ করে, তবে টোকেনাইজেশন heuristic — খুব সূক্ষ্ম প্রশ্নে উত্তর অসম্পূর্ণ হতে পারে (সোর্সের সঙ্গে সবসময় যাচাই করে নিন)।
