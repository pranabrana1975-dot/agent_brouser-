// agent.mjs — the built-in demo planner.
//
// It is intentionally deterministic (no API key needed) but it uses exactly the
// same primitives an LLM planner would use: snapshot() → pick a ref → act().
// Swap `runTask`'s search/extract steps for a model call and nothing else in the
// browser has to change.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EN_STOP = new Set(('a an the of in on at to for is are was were be been it its this that these those and or but if then than with '
  + 'how what when where who why which whom do does did done can could should would will just more most very also as by from into over '
  + 'about after before between during out up down not no yes you your we our they their he she his her i me my please search find tell '
  + 'show explain summarize summarise give list current latest').split(/\s+/));

const BN_STOP = new Set(['কত', 'কী', 'কি', 'কীভাবে', 'কোথায়', 'কখন', 'কোন', 'কোনটি', 'এবং', 'ও', 'বা', 'এর', 'একটি', 'একটা', 'সালে',
  'সাল', 'হয়', 'হয়েছিল', 'হয়েছে', 'করে', 'করা', 'থেকে', 'জন্য', 'কিন্তু', 'আছে', 'ছিল', 'আমি', 'আমার', 'বলো', 'খুঁজে', 'দাও', 'দেখাও', 'আমাকে']);

const TRUST = /(wikipedia\.org|britannica\.com|\.gov|\.edu|\.ac\.|who\.int|un\.org|reuters\.com|bbc\.(com|co\.uk)|apnews\.com|nature\.com|sciencedirect|arxiv\.org|github\.com|developer\.mozilla\.org|stackoverflow\.com)/i;
const JUNK = /(tiktok|pinterest|quora|answers\.|coupon|casino|betting|download-?free)/i;

const words = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []);
const isStop = (w) => EN_STOP.has(w) || BN_STOP.has(w);
const stems = (w) => [w, w.slice(0, Math.max(3, Math.min(5, w.length - 0)))];

export function queryFrom(goal) {
  return (goal
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s*(please\s+)?(can you\s+)?(search( for)?|find( me)?|look ?up|tell me|show me|explain|summari[sz]e|check)\b/i, ' ')
    .replace(/\s+/g, ' ')
    .trim()) || goal.trim();
}

export function urlIn(goal) {
  const m = goal.match(/https?:\/\/[^\s"'<>]+/i);
  if (!m) return null;
  let u = m[0].replace(/[.,;:!?]+$/, '');
  // keep trailing ")" only when the parens are balanced (e.g. /wiki/Foo_(bar))
  while (u.endsWith(')') && (u.split('(').length < u.split(')').length)) u = u.slice(0, -1);
  return u;
}

function relevant(sentence, stemsList) {
  const s = sentence.toLowerCase();
  return stemsList.some((st) => s.includes(st));
}

const NAV_JUNK = /(jump to content|main menu|create account|log in|sign in|privacy policy|terms of use|cookie|subscribe|newsletter|all rights reserved|translate this result|random article|contact us|about wikipedia|disclaimer|mobile view|toggle the table of contents|বিষয়শ্রেণী|প্রধান মেনু|অ্যাকাউন্ট তৈরি|দান করুন|অনুসন্ধান দান করুন|পরিভ্রমণ|উইকিপিডিয়ায় স্বাগতম|মুদ্রণ|যোগাযোগ করুন|গোপনীয়তার নীতি|আমাদের সম্পর্কে)/i;

export function summarize(text, query, n = 5) {
  const qWords = words(query).filter((w) => !isStop(w) && w.length > 2);
  const stemList = qWords.flatMap(stems);

  const cleanText = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 40)
    .filter((l) => !NAV_JUNK.test(l))
    .join(' ');

  const sentences = cleanText
    .split(/(?<=[.!?।])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 45)
    .filter((s) => !/[›»]/.test(s))          // breadcrumbs
    .filter((s) => !NAV_JUNK.test(s))
    .filter((s) => !/…\s*$/.test(s))         // truncated snippet tails
    .filter((s) => !/^\d{1,2}\s\w{3}\s\d{4}/.test(s)); // "Sep 29, 2026 ·"

  if (!sentences.length) return [];

  const freq = new Map();
  for (const w of words(cleanText)) if (!isStop(w)) freq.set(w, (freq.get(w) || 0) + 1);

  const scored = sentences.map((s, i) => {
    const ws = words(s).filter((w) => !isStop(w));
    let score = 0;
    for (const w of ws) {
      score += 0.35 * Math.min(6, freq.get(w) || 0);
      if (qWords.includes(w)) score += 7;
      else if (stemList.some((st) => w.startsWith(st) && st.length >= 4)) score += 4;
    }
    score = score / Math.sqrt(ws.length + 4);
    score += Math.max(0, 2.5 - i * 0.3);
    if (/\d/.test(s)) score += 1.0;                                  // numbers = facts
    if (/কোটি|লক্ষ|million|billion|population|জনসংখ্যা/i.test(s)) score += 1.4;
    return { s, i, score, hit: relevant(s, stemList) };
  });

  const hits = scored.filter((x) => x.hit);
  const pool = hits.length >= 2 ? hits : scored;
  return pool.sort((a, b) => b.score - a.score).slice(0, n).sort((a, b) => a.i - b.i).map((x) => x.s);
}

function scoreResult(r, qWords, stemList) {
  const title = (r.title || '').toLowerCase();
  const snip = (r.snippet || '').toLowerCase();
  let s = 0;
  for (const w of qWords) {
    if (title.includes(w)) s += 4;
    else if (snip.includes(w)) s += 1.5;
    else if (stemList.some((st) => st.length >= 4 && (title + snip).includes(st))) s += 1;
  }
  // the *subject* of the question (first content word) must appear in the title,
  // otherwise "list of countries by population" beats the actual Tokyo article
  const subject = qWords[0];
  if (subject) {
    const st = subject.slice(0, Math.max(3, Math.min(5, subject.length)));
    if (title.includes(st)) s += 6;
    else if (snip.includes(st)) s += 1;
  }
  if (/[?؟]/.test(r.title)) s -= 2;                       // question-aggregator pages
  if (TRUST.test(r.url)) s += 4;
  if (JUNK.test(r.url) || JUNK.test(r.title)) s -= 5;
  if (!r.snippet) s -= 1;
  return s;
}

function findField(snap, wantSearch) {
  if (!snap) return null;
  const fields = snap.boxes.filter((b) => ['searchbox', 'textbox', 'combobox'].includes(b.role));
  if (!fields.length) return null;
  if (wantSearch) {
    const s = fields.find((f) => /search/i.test(f.name) || f.role === 'searchbox');
    if (s) return s;
  }
  return fields[0];
}

export async function runTask(session, goal, { emit } = {}) {
  session.stats.taskRuns++;
  const note = (text, meta) => session.addLog('agent', text, meta);
  const act = async (action) => {
    const result = await session.act(action);
    if (result?.blocked || result?.error) throw new Error(result.reason || result.error);
    return result;
  };
  const step = async (s) => { session.setAgentStatus(s); await sleep(120); };

  note(`task received · ${JSON.stringify(goal)}`);
  const target = urlIn(goal);
  const q = queryFrom(goal);
  const qWords = words(q).filter((w) => !isStop(w) && w.length > 2);
  const stemList = qWords.flatMap(stems);
  const answer = { question: goal, bullets: [], sources: [], extractedFrom: [] };

  try {
    if (target) {
      /* ---------- read mode: open a URL and extract ---------- */
      note(`plan: read mode · url detected → ${target}`, { plan: 1 });
      await step('reading');
      const r = (await act({ op: 'open', url: target })).snapshot || (await session.snap());
      const txt = await session.pageText();
      answer.sources.push({ title: txt.title || target, url: txt.url });
      answer.extractedFrom.push(txt.url);
      const bullets = summarize(txt.text + '\n' + r.bodyText, q, 5);
      answer.bullets = bullets.length ? bullets : [r.text.split('\n').slice(0, 8).join(' ')];
      note(`read ${Math.round(txt.text.length / 1000)}k chars · compressed to a ${r.tokens}-token Agent Document`);
    } else {
      /* ---------- search mode: type into a real search box ---------- */
      note(`plan: search mode · query=${JSON.stringify(q)}`, { plan: 1 });
      await step('navigating');
      let snap = (await act({ op: 'open', url: 'https://www.bing.com' })).snapshot;
      const field = findField(snap, true);
      if (field) {
        note(`search box found · ${field.ref} (${field.role} "${field.name}") · typing it like a user`);
        const res = await act({ op: 'type', ref: field.ref, text: q, submit: true });
        snap = res.snapshot || snap;
      } else {
        note('no search box exposed · falling back to the URL form');
        snap = (await act({ op: 'open', url: `https://www.bing.com/search?q=${encodeURIComponent(q)}` })).snapshot;
      }

      await step('reading results');
      // SERPs hydrate late — poll the DOM instead of trusting one snapshot
      let results = [];
      for (let i = 0; i < 14; i++) {
        results = await session.results();
        if (results.length >= 2) break;
        await sleep(450);
      }
      if (!results.length) {
        note('no result cards found · falling back to the readable page text');
        const txt = await session.pageText();
        const fb = summarize(txt.text, q, 4);
        answer.bullets = fb;
        if (txt.url && !/bing\.com/.test(txt.url)) answer.sources.push({ title: txt.title, url: txt.url });
      }
      if (results.length) note(`result cards detected · ${results.length} candidates`);

      const ranked = results
        .map((r) => ({ ...r, score: scoreResult(r, qWords, stemList) }))
        .sort((a, b) => b.score - a.score);
      for (const r of ranked.slice(0, 3)) {
        note(`  candidate [${r.score.toFixed(1)}] ${r.title.slice(0, 64)} — ${r.url.slice(0, 70)}`);
      }

      // snippets are cheap; use the ones that actually mention the query
      const goodSnips = ranked.filter((r) => r.snippet && relevant(r.snippet, stemList)).map((r) => r.snippet);
      let bullets = summarize(goodSnips.join(' '), q, 3);

      // then open the best source and read it properly — this is where answers come from
      const best = ranked.find((r) => r.url && /^https?:/.test(r.url) && !/bing\.com/.test(r.url));
      if (best) {
        note(`opening best source to verify · ${best.url.slice(0, 90)}`);
        await step('verifying');
        const opened = await act({ op: 'open', url: best.url });
        const txt = await session.pageText();
        if (txt.url) { answer.extractedFrom.push(txt.url); answer.sources.unshift({ title: txt.title || best.title, url: txt.url }); }
        const deeper = summarize(txt.text + '\n' + (opened.snapshot?.bodyText || ''), q, 5);
        if (deeper.length >= 2) bullets = deeper;              // page text wins over snippets
        else bullets = dedupe([...deeper, ...bullets]);
        note(`verified · page gave ${deeper.length} passages · Agent Document was ${opened.snapshot?.tokens ?? '—'} tokens`);
      }

      if (!answer.sources.length) {
        for (const r of ranked.slice(0, 3)) answer.sources.push({ title: r.title, url: r.url });
      }
      answer.bullets = dedupe(bullets).slice(0, 5);
    }

    session.setAgentStatus('done');
    note(`task complete · ${answer.bullets.length} findings · ${answer.sources.length} sources`);
    answer.ok = true;
  } catch (e) {
    session.setAgentStatus('error');
    note(`task failed · ${e.message.slice(0, 200)}`);
    answer.ok = false;
    answer.error = e.message;
  }

  session.emit('answer', { answer });
  session.emit('state', { state: session.state() });
  return answer;
}

function dedupe(list) {
  const out = [];
  const seen = new Set();
  for (const s of list) {
    const k = s.toLowerCase().replace(/\W/g, '').slice(0, 70);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}
