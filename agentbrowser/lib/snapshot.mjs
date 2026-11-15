// snapshot.mjs — the core of an agent-native browser: turn a live page into a
// compact, addressable "Agent Document" instead of pixels.
//
// Why: a human needs 1920x1080 pixels. An agent needs ~50 lines of text it can
// act on deterministically. Every actionable element gets a short ref (e1..eN);
// the agent never needs CSS selectors, XPath or coordinates.

const PAGE_PROBE = (startRef = 0) => {
  document.querySelectorAll('[data-agent-ref]').forEach((el) => el.removeAttribute('data-agent-ref'));

  const MAX_ACTIONS = 90;
  const MAX_HEADINGS = 12;
  const MAX_TEXT = 14;

  const nodes = [];
  let n = startRef;
  let count = 0;

  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return null;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) return null;
    if (r.width >= innerWidth && r.height >= innerHeight) return null; // layout wrappers
    return r;
  };

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const nameOf = (el) => {
    let s = clean(el.getAttribute('aria-label'));
    if (!s) s = clean(el.getAttribute('placeholder'));
    if (!s && el.tagName === 'INPUT' && el.type !== 'password') s = clean(el.value);
    if (!s) s = clean(el.innerText);
    if (!s) s = clean(el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '');
    return s.slice(0, 110);
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'search') return 'searchbox';
      if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'password') return 'password';
      if (t === 'hidden') return 'hidden';
      return 'textbox';
    }
    return tag;
  };

  const push = (el, kind, extra) => {
    if (count >= MAX_ACTIONS) return;
    const r = rectOf(el);
    if (!r) return;
    const ref = 'e' + ++n;
    count++;
    el.setAttribute('data-agent-ref', ref);
    nodes.push({
      ref,
      role: roleOf(el),
      name: nameOf(el),
      value: el.tagName === 'INPUT' && el.type === 'password' ? '••••••' : clean(el.value || '').slice(0, 80),
      href: el.tagName === 'A' ? clean(el.getAttribute('href') || '').slice(0, 160) : '',
      kind,
      inViewport: r.top < innerHeight && r.bottom > 0,
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      ...(extra || {}),
    });
  };

  // 1) actionable elements, in DOM order (approximates visual reading order)
  const ACTIONABLE = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=searchbox]', '[role=textbox]', '[role=combobox]',
    '[role=tab]', '[role=menuitem]', '[role=checkbox]', '[role=switch]', '[contenteditable=true]',
  ].join(',');

  const seen = new Set();
  for (const el of document.querySelectorAll(ACTIONABLE)) {
    if (seen.has(el)) continue;
    // skip controls that only wrap other controls (label > input)
    if (el.querySelector(ACTIONABLE) && el.tagName !== 'BUTTON' && el.tagName !== 'A' && el.tagName !== 'SELECT') continue;
    seen.add(el);
    push(el, 'act');
  }

  // 2) headings give the agent the page's skeleton
  let hn = 0;
  for (const el of document.querySelectorAll('h1,h2,h3')) {
    if (hn >= MAX_HEADINGS) break;
    const r = rectOf(el);
    if (!r) continue;
    const t = clean(el.innerText);
    if (t.length < 2) continue;
    hn++;
    nodes.push({ ref: '', role: el.tagName.toLowerCase(), name: t.slice(0, 120), kind: 'head', value: '', href: '',
      inViewport: r.top < innerHeight, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
  }

  // 3) a little readable text so the agent can answer without a second call
  const textBits = [];
  let tn = 0;
  for (const el of document.querySelectorAll('main p, article p, p, li, blockquote')) {
    if (tn >= MAX_TEXT) break;
    const r = rectOf(el);
    if (!r) continue;
    const t = clean(el.innerText);
    if (t.length < 60 || t.length > 600) continue;
    tn++;
    textBits.push(t);
  }

  const bodyText = clean(document.body.innerText).slice(0, 12000);

  return {
    url: location.href,
    title: document.title,
    vw: innerWidth,
    vh: innerHeight,
    scrollY: Math.round(scrollY),
    docHeight: Math.round(document.documentElement.scrollHeight),
    htmlBytes: document.documentElement.outerHTML.length,
    nodes,
    textBits,
    bodyText,
  };
};

const tokenEstimate = (s) => Math.round(s.length / 4); // rough but honest, chars/4

export function renderDoc(raw) {
  const lines = [];
  lines.push(`[url] ${raw.url}`);
  lines.push(`[title] ${raw.title}`);
  lines.push(`[viewport] ${raw.vw}x${raw.vh}  scrollY=${raw.scrollY}/${Math.max(0, raw.docHeight - raw.vh)}`);

  for (const nd of raw.nodes) {
    if (nd.kind === 'head') {
      lines.push(`${nd.role}[${nd.inViewport ? 'v' : '·'}] ${JSON.stringify(nd.name)}`);
      continue;
    }
    const bits = [`${nd.role}`, JSON.stringify(nd.name)];
    if (nd.value) bits.push(`value=${JSON.stringify(nd.value)}`);
    if (nd.href) bits.push(`→ ${nd.href.startsWith('http') ? nd.href : nd.href.slice(0, 80)}`);
    if (!nd.inViewport) bits.push('(offscreen)');
    lines.push(`${nd.ref} ${bits.join(' ')}`);
  }
  if (raw.textBits.length) {
    lines.push('');
    lines.push('-- text --');
    for (const t of raw.textBits) lines.push('· ' + t);
  }
  const text = lines.join('\n');
  const boxes = raw.nodes.filter((nd) => nd.ref).map((nd) => ({
    ref: nd.ref, role: nd.role, name: nd.name,
    x: nd.x, y: nd.y, w: nd.w, h: nd.h, v: nd.inViewport,
  }));
  return {
    text,
    boxes,
    tokens: tokenEstimate(text),
    htmlBytes: raw.htmlBytes,
    meta: { url: raw.url, title: raw.title, vw: raw.vw, vh: raw.vh, scrollY: raw.scrollY, docHeight: raw.docHeight },
    bodyText: raw.bodyText,
    textBits: raw.textBits,
  };
}

export async function takeSnapshot(page, startRef = 0) {
  const raw = await page.evaluate(PAGE_PROBE, startRef);
  return renderDoc(raw);
}
