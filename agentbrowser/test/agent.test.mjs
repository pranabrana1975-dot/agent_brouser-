import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupe,
  stems,
  urlIn,
  queryFrom,
  summarize,
  scoreResult,
  buildSearchEngines,
  runTask,
} from '../lib/agent.mjs';
import { Policy } from '../lib/policy.mjs';

test('dedupe preserves distinct Bangla and Unicode sentences while removing true duplicates', () => {
  const input = [
    'কলকাতা ভারতের পশ্চিমবঙ্গ রাজ্যের রাজধানী এবং বৃহত্তম শহর।',
    'কলকাতা ভারতের পশ্চিমবঙ্গ রাজ্যের রাজধানী এবং বৃহত্তম শহর!', // punctuation-only duplicate
    '২০১১ সালের জনগণনা অনুযায়ী কলকাতা মহানগরের জনসংখ্যা প্রায় ১.৪১ কোটি।',
    'হুগলি নদীর পূর্ব তীরে অবস্থিত এই শহরটি ভারতের অন্যতম প্রধান বন্দর।',
  ];
  const out = dedupe(input);
  assert.equal(out.length, 3);
  assert.match(out[1], /১\.৪১ কোটি/);
  assert.match(out[2], /হুগলি নদীর/);
});

test('Bangla tokenization, suffix stemming, and extractive summarize handle matras accurately', () => {
  assert.ok(stems('কলকাতার').includes('কলকাতা'));
  assert.ok(stems('মানুষদের').includes('মানুষ'));

  const article = [
    'প্রধান মেনু অ্যাকাউন্ট তৈরি লগ ইন উইকিপিডিয়ায় স্বাগতম।',
    'কলকাতা ভারতের পশ্চিমবঙ্গ রাজ্যের রাজধানী এবং পূর্ব ভারতের প্রধান বাণিজ্যিক ও সাংস্কৃতিক কেন্দ্র।',
    '২০১১ সালের আদমশুমারি অনুসারে কলকাতা শহরের জনসংখ্যা ৪৫ লক্ষ এবং বৃহত্তর মহানগরের জনসংখ্যা ১.৪১ কোটি।',
    'শহরটি হুগলি নদীর পূর্ব তীরে অবস্থিত এবং এখানে ভারতের প্রাচীনতম পাতালরেল ব্যবস্থা চালু আছে।',
  ].join('\n');

  const bullets = summarize(article, 'কলকাতার জনসংখ্যা কত', 3);
  assert.ok(bullets.length >= 2);
  assert.ok(bullets.some((b) => b.includes('১.৪১ কোটি')));
  assert.ok(bullets.every((b) => !b.includes('প্রধান মেনু')));
});

test('urlIn, queryFrom, scoreResult, and buildSearchEngines handle edge cases', () => {
  assert.equal(
    urlIn('Summarize https://en.wikipedia.org/wiki/Python_(programming_language).'),
    'https://en.wikipedia.org/wiki/Python_(programming_language)',
  );
  assert.equal(
    urlIn('(see https://example.com/docs)'),
    'https://example.com/docs',
  );
  assert.equal(
    urlIn('এই পেজটি পড়ো https://bn.wikipedia.org/wiki/কলকাতা।'),
    'https://bn.wikipedia.org/wiki/কলকাতা',
  );
  assert.equal(queryFrom('Please search for Tokyo metro population'), 'Tokyo metro population');

  const hi = scoreResult(
    { title: 'Tokyo - Wikipedia', url: 'https://en.wikipedia.org/wiki/Tokyo', snippet: 'Tokyo population exceeds 14 million.' },
    ['tokyo', 'population'],
    ['tokyo', 'popul'],
  );
  const lo = scoreResult(
    { title: 'What is a city? - Quora', url: 'https://www.quora.com/city', snippet: '' },
    ['tokyo', 'population'],
    ['tokyo', 'popul'],
  );
  assert.ok(hi > lo);

  const engines = buildSearchEngines({ searxngUrl: 'https://searx.example.org/', engineOrder: 'duckduckgo,brave' });
  assert.deepEqual(engines.map((e) => e.name), ['searxng', 'duckduckgo', 'brave']);
});

function createFakeTaskSession(handlers) {
  const logs = [];
  const events = [];
  return {
    stats: { taskRuns: 0 },
    policy: new Policy(),
    addLog: (kind, text) => logs.push({ kind, text }),
    setAgentStatus: () => {},
    emit: (type, data) => events.push({ type, data }),
    state: () => ({}),
    logs,
    events,
    ...handlers,
  };
}

test('runTask falls back across search engines and verifies backup source when primary fails', async () => {
  let currentUrl = '';
  const session = createFakeTaskSession({
    act: async (a) => {
      if (a.op === 'open') {
        if (a.url.includes('duckduckgo.com')) return { error: 'load problem: timeout' };
        if (a.url.includes('bing.com')) { currentUrl = a.url; return { ok: true, snapshot: { boxes: [], tokens: 20 } }; }
        if (a.url.includes('brave.com')) { currentUrl = a.url; return { ok: true, snapshot: { boxes: [], tokens: 40 } }; }
        if (a.url === 'https://dead.example.org/nodejs') return { error: 'load problem: HTTP 503' };
        if (a.url === 'https://nodejs.org/en/about') {
          currentUrl = a.url;
          return { ok: true, snapshot: { tokens: 85, bodyText: '' } };
        }
      }
      return { ok: true, snapshot: { boxes: [], tokens: 10 } };
    },
    results: async () => {
      if (currentUrl.includes('bing.com')) return []; // e.g. CAPTCHA page
      if (currentUrl.includes('brave.com')) {
        return [
          { title: 'Node.js guide', url: 'https://dead.example.org/nodejs', snippet: 'Node.js runtime overview and release cadence details.' },
          { title: 'About Node.js', url: 'https://nodejs.org/en/about', snippet: 'Node.js is an open-source, cross-platform JavaScript runtime built on V8.' },
        ];
      }
      return [];
    },
    pageText: async () => ({
      title: 'About Node.js',
      url: currentUrl,
      text: [
        'Node.js is an open-source and cross-platform JavaScript runtime environment built on Chrome V8 engine.',
        'Node.js runs an event-driven, non-blocking I/O architecture that handles thousands of concurrent connections efficiently.',
      ].join('\n'),
    }),
  });

  const answer = await runTask(session, 'Explain Node.js runtime architecture', {
    engineOrder: 'duckduckgo,bing,brave',
    pollAttempts: 1,
    pollDelayMs: 0,
    stepDelayMs: 0,
  });

  assert.equal(answer.ok, true);
  assert.equal(answer.engine, 'brave');
  assert.deepEqual(answer.extractedFrom, ['https://nodejs.org/en/about']);
  assert.ok(answer.bullets.some((b) => b.includes('non-blocking I/O')));
});

test('runTask enforces per-task action budget and supports optional LLM synthesis with fallback', async () => {
  const overBudgetSession = createFakeTaskSession({
    act: async () => ({ ok: true, snapshot: { boxes: [], tokens: 10 } }),
    results: async () => [],
    pageText: async () => ({ title: '', url: '', text: '' }),
  });
  const failed = await runTask(overBudgetSession, 'Find quantum computing papers', {
    engineOrder: 'duckduckgo,bing,brave',
    maxActions: 2,
    pollAttempts: 1,
    pollDelayMs: 0,
    stepDelayMs: 0,
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /budget/);

  // Optional LLM synthesis succeeds when configured.
  const readSession = createFakeTaskSession({
    act: async ({ url }) => ({ ok: true, snapshot: { tokens: 50, bodyText: '', text: url } }),
    pageText: async () => ({
      title: 'Solar Report',
      url: 'https://example.org/solar',
      text: 'Global solar capacity surpassed 2,000 gigawatts in 2025 due to rapid utility-scale installations worldwide.',
    }),
  });
  const synthesized = await runTask(readSession, 'Summarize https://example.org/solar', {
    stepDelayMs: 0,
    llm: { apiKey: 'test-key', baseUrl: 'https://llm.example.test/v1', model: 'test-model' },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ bullets: ['Global solar capacity exceeded 2,000 GW in 2025.'] }) } }],
      }),
    }),
  });
  assert.equal(synthesized.ok, true);
  assert.equal(synthesized.synthesizedBy, 'llm');
  assert.deepEqual(synthesized.bullets, ['Global solar capacity exceeded 2,000 GW in 2025.']);

  // Falls back gracefully to deterministic summary when LLM endpoint errors.
  const fallback = await runTask(readSession, 'Summarize https://example.org/solar', {
    stepDelayMs: 0,
    llm: { apiKey: 'test-key', baseUrl: 'https://llm.example.test/v1' },
    fetch: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.synthesizedBy, undefined);
  assert.ok(fallback.bullets[0].includes('2,000 gigawatts'));
});
