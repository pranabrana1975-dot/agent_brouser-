// snapshot.mjs — turn a live page into a compact, addressable "Agent Document".
//
// Every actionable control gets a short ref (e1..eN), accessible label, and
// state badges (disabled, checked, required, expanded, select options). Controls
// in active modals, the current viewport, and <main>/<article>/<form> are
// prioritized so large navigation headers never crowd out real page actions.

export const PAGE_PROBE = (rawOpts = 0) => {
  const opts = typeof rawOpts === 'number'
    ? { startRef: rawOpts }
    : (rawOpts && typeof rawOpts === 'object' ? rawOpts : {});
  const START_REF = Number.isInteger(opts.startRef) && opts.startRef >= 0 ? opts.startRef : 0;
  const MAX_ACTIONS = opts.maxActions || 100;
  const MAX_HEADINGS = opts.maxHeadings || 14;
  const MAX_TEXT = opts.maxText || 14;
  const MAX_OPTIONS = 12;
  const MAX_FRAMES = 6;
  const MAX_SHADOW_DEPTH = 6;

  const ACTIONABLE = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="searchbox"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="option"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
  ].join(',');

  const FORM_ROLES = new Set([
    'searchbox', 'textbox', 'password', 'combobox', 'checkbox', 'radio', 'switch', 'file',
  ]);

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  const clearRefsInRoot = (root, depth = 0) => {
    if (!root || depth > MAX_SHADOW_DEPTH) return;
    try {
      root.querySelectorAll('[data-agent-ref]').forEach((el) => el.removeAttribute('data-agent-ref'));
      root.querySelectorAll('[data-agent-frame]').forEach((el) => el.removeAttribute('data-agent-frame'));
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) clearRefsInRoot(el.shadowRoot, depth + 1);
      });
    } catch {}
  };

  clearRefsInRoot(document);

  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;

  const isInViewport = (r) => r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;

  const rectOf = (el, view = window, offset = { x: 0, y: 0 }, allowFullScreen = false) => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return null;
    try {
      const s = view.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.visibility === 'collapse' || s.display === 'none' || parseFloat(s.opacity) === 0) {
        return null;
      }
    } catch {}
    const tag = (el.tagName || '').toUpperCase();
    const isIntrinsicControl = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'IFRAME', 'DIALOG'].includes(tag);
    if (!allowFullScreen && !isIntrinsicControl && r.width >= vw && r.height >= vh) return null;
    const left = Number.isFinite(r.left) ? r.left : (r.x || 0);
    const top = Number.isFinite(r.top) ? r.top : (r.y || 0);
    const right = Number.isFinite(r.right) ? r.right : left + r.width;
    const bottom = Number.isFinite(r.bottom) ? r.bottom : top + r.height;
    return {
      x: left + offset.x,
      y: top + offset.y,
      left: left + offset.x,
      top: top + offset.y,
      right: right + offset.x,
      bottom: bottom + offset.y,
      width: r.width,
      height: r.height,
    };
  };

  const textOf = (el) => {
    if (!el) return '';
    return clean(typeof el.innerText === 'string' ? el.innerText : el.textContent || '');
  };

  const resolveLabelledBy = (el, ownerDoc) => {
    const raw = clean(el.getAttribute?.('aria-labelledby'));
    if (!raw) return '';
    const rootNode = typeof el.getRootNode === 'function' ? el.getRootNode() : ownerDoc;
    const parts = [];
    for (const id of raw.split(/\s+/)) {
      const target = (typeof rootNode?.getElementById === 'function' && rootNode.getElementById(id))
        || ownerDoc?.getElementById?.(id);
      if (target) {
        const t = textOf(target);
        if (t) parts.push(t);
      }
    }
    return clean(parts.join(' '));
  };

  const resolveHtmlLabel = (el, ownerDoc) => {
    const parts = [];
    if (el.labels && el.labels.length) {
      for (const lbl of el.labels) {
        const t = textOf(lbl);
        if (t) parts.push(t);
      }
    } else if (el.id && ownerDoc?.querySelectorAll) {
      try {
        const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id.replace(/["\\]/g, '\\$&');
        ownerDoc.querySelectorAll(`label[for="${escaped}"]`).forEach((lbl) => {
          const t = textOf(lbl);
          if (t) parts.push(t);
        });
      } catch {}
    }
    if (!parts.length && typeof el.closest === 'function') {
      const wrap = el.closest('label');
      if (wrap) {
        const clone = wrap.cloneNode(true);
        try { clone.querySelectorAll('input, select, textarea').forEach((c) => c.remove()); } catch {}
        const t = textOf(clone);
        if (t) parts.push(t);
      }
    }
    return clean(parts.join(' '));
  };

  const mediaFallbackName = (el) => {
    if (!el.querySelector) return '';
    const img = el.querySelector('img[alt]');
    if (img) {
      const alt = clean(img.getAttribute('alt'));
      if (alt) return alt;
    }
    const svg = el.querySelector('svg[aria-label], svg title');
    if (svg) {
      const t = svg.tagName?.toLowerCase() === 'title' ? textOf(svg) : clean(svg.getAttribute('aria-label'));
      if (t) return t;
    }
    return '';
  };

  const nameOf = (el, ownerDoc) => {
    const tag = (el.tagName || '').toUpperCase();
    const type = tag === 'INPUT' ? (el.getAttribute('type') || el.type || 'text').toLowerCase() : '';

    let s = clean(el.getAttribute?.('aria-label'));
    if (!s) s = resolveLabelledBy(el, ownerDoc);
    if (!s && ['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) s = resolveHtmlLabel(el, ownerDoc);
    if (!s) s = clean(el.getAttribute?.('placeholder') || el.getAttribute?.('aria-placeholder'));
    if (!s && tag === 'INPUT' && ['submit', 'button', 'reset'].includes(type)) s = clean(el.value);
    if (!s && tag !== 'SELECT' && tag !== 'INPUT' && tag !== 'TEXTAREA') s = textOf(el);
    if (!s) s = mediaFallbackName(el);
    if (!s) s = clean(el.getAttribute?.('title') || el.getAttribute?.('alt') || el.getAttribute?.('name') || '');
    if (!s && tag === 'INPUT' && type !== 'password' && type !== 'file') s = clean(el.value);
    if (!s && tag === 'SELECT' && el.selectedOptions?.length) s = clean(el.selectedOptions[0].text);
    return s.slice(0, 110);
  };

  const roleOf = (el) => {
    const explicit = clean(el.getAttribute?.('role')).toLowerCase();
    if (explicit) return explicit;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || el.type || 'text').toLowerCase();
      if (t === 'search') return 'searchbox';
      if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'password') return 'password';
      if (t === 'file') return 'file';
      if (t === 'hidden') return 'hidden';
      return 'textbox';
    }
    if (el.getAttribute?.('contenteditable') === 'true' || el.getAttribute?.('contenteditable') === '') {
      return 'textbox';
    }
    return tag;
  };

  const stateOf = (el, role) => {
    const tag = (el.tagName || '').toUpperCase();
    const inputType = tag === 'INPUT' ? (el.getAttribute('type') || el.type || 'text').toLowerCase() : '';
    const disabled = Boolean(el.disabled || el.getAttribute?.('aria-disabled') === 'true');
    const required = Boolean(el.required || el.getAttribute?.('aria-required') === 'true');
    const readonly = Boolean(el.readOnly || el.getAttribute?.('aria-readonly') === 'true');
    const selected = el.getAttribute?.('aria-selected') === 'true';

    let checked = null;
    if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)) {
      const ariaChecked = el.getAttribute?.('aria-checked');
      if (el.indeterminate || ariaChecked === 'mixed') checked = 'mixed';
      else if (tag === 'INPUT') checked = Boolean(el.checked);
      else if (ariaChecked === 'true') checked = true;
      else if (ariaChecked === 'false') checked = false;
    }

    let expanded = null;
    const ariaExpanded = el.getAttribute?.('aria-expanded');
    if (ariaExpanded === 'true') expanded = true;
    else if (ariaExpanded === 'false') expanded = false;
    else if (tag === 'SUMMARY' && el.parentElement?.tagName?.toUpperCase() === 'DETAILS') {
      expanded = Boolean(el.parentElement.open);
    }

    let value = '';
    if (tag === 'INPUT' && inputType === 'password') {
      value = el.value ? '••••••' : '';
    } else if (tag === 'SELECT') {
      const sel = el.selectedOptions ? Array.from(el.selectedOptions) : Array.from(el.options || []).filter((o) => o.selected);
      value = clean(sel.map((o) => o.text || o.value).join(', ')).slice(0, 80);
    } else if (tag === 'INPUT' && ['checkbox', 'radio', 'submit', 'button', 'reset', 'image'].includes(inputType)) {
      value = '';
    } else if (typeof el.value === 'string') {
      value = clean(el.value).slice(0, 80);
    }

    let options = null;
    let optionCount = 0;
    if (tag === 'SELECT' && el.options) {
      const all = Array.from(el.options);
      optionCount = all.length;
      options = all.slice(0, MAX_OPTIONS).map((o) => ({
        value: clean(o.value).slice(0, 60),
        label: clean(o.text || o.label || o.value).slice(0, 60),
        selected: Boolean(o.selected),
        ...(o.disabled ? { disabled: true } : {}),
      }));
    }

    return {
      inputType,
      disabled,
      required,
      readonly,
      checked,
      expanded,
      selected,
      value,
      options,
      optionCount,
    };
  };

  const hasClosest = (el, sel) => {
    try { return typeof el.closest === 'function' && Boolean(el.closest(sel)); } catch { return false; }
  };

  const scoreCandidate = ({ el, role, name, inViewport, inModal, state }) => {
    let score = 0;
    if (inModal) score += 100;
    if (inViewport) score += 40;
    if (FORM_ROLES.has(role)) score += 32;
    else if (role === 'button' || state.inputType === 'submit') score += 14;
    if (hasClosest(el, 'main, article, [role="main"], form, dialog, [role="dialog"]')) score += 26;
    if (role !== 'searchbox' && hasClosest(el, 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]')) {
      score -= 16;
    }
    if (!name && !FORM_ROLES.has(role)) score -= 14;
    if (state.disabled) score -= 6;
    return score;
  };

  const candidates = [];
  const headingCandidates = [];
  const textCandidates = [];
  const seenActionable = new Set();
  let order = 0;
  let frameSeq = 0;

  const collectFromRoot = (root, ownerDoc, view, offset, frameId, shadowDepth) => {
    if (!root || shadowDepth > MAX_SHADOW_DEPTH) return;

    // Detect if there is an active open modal dialog in this root
    let activeModals = [];
    try {
      activeModals = Array.from(root.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"], [aria-modal="true"]'))
        .filter((d) => Boolean(rectOf(d, view, offset, true)));
    } catch {}

    // 1) Actionable controls
    let actEls = [];
    try { actEls = Array.from(root.querySelectorAll(ACTIONABLE)); } catch {}
    for (const el of actEls) {
      if (seenActionable.has(el)) continue;
      const tag = (el.tagName || '').toUpperCase();
      // Skip option elements inside native <select> (captured via select.options instead)
      if (tag === 'OPTION' && hasClosest(el, 'select')) continue;
      // Skip wrapper controls that only wrap another control (e.g. role=button div containing a <button>)
      if (!['BUTTON', 'A', 'SELECT', 'INPUT', 'TEXTAREA', 'SUMMARY'].includes(tag)) {
        try { if (el.querySelector(ACTIONABLE)) continue; } catch {}
      }
      const r = rectOf(el, view, offset);
      if (!r) continue;
      seenActionable.add(el);

      const role = roleOf(el);
      if (role === 'hidden') continue;
      const name = nameOf(el, ownerDoc);
      const state = stateOf(el, role);
      const inViewport = isInViewport(r);
      const inModal = activeModals.some((m) => m === el || (typeof m.contains === 'function' && m.contains(el)));
      const href = tag === 'A' ? clean(el.getAttribute('href') || '').slice(0, 160) : '';
      const ord = order++;
      const priority = scoreCandidate({ el, role, name, inViewport, inModal, state });

      candidates.push({
        el,
        order: ord,
        priority,
        inModal,
        frame: frameId,
        role,
        name,
        href,
        inViewport,
        rect: r,
        state,
      });
    }

    // 2) Headings
    let headEls = [];
    try { headEls = Array.from(root.querySelectorAll('h1, h2, h3, h4')); } catch {}
    for (const el of headEls) {
      const r = rectOf(el, view, offset);
      if (!r) continue;
      const t = textOf(el);
      if (t.length < 2) continue;
      const inViewport = isInViewport(r);
      const inMain = hasClosest(el, 'main, article, [role="main"]');
      headingCandidates.push({
        order: order++,
        priority: (inMain ? 20 : 0) + (inViewport ? 10 : 0) + (el.tagName.toLowerCase() === 'h1' ? 8 : 0),
        role: el.tagName.toLowerCase(),
        name: t.slice(0, 120),
        inViewport,
        rect: r,
      });
    }

    // 3) Readable prose snippets (prioritize main/article, avoid nested duplication)
    let proseEls = [];
    try { proseEls = Array.from(root.querySelectorAll('p, li, blockquote')); } catch {}
    for (const el of proseEls) {
      const r = rectOf(el, view, offset);
      if (!r) continue;
      // Avoid duplicating <li> text when it wraps a <p> or nested <li>
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'LI' && el.querySelector?.('p, ul, ol')) continue;
      if (hasClosest(el, 'nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')) continue;
      const t = textOf(el);
      if (t.length < 50 || t.length > 650) continue;
      const inMain = hasClosest(el, 'main, article, [role="main"]');
      const inViewport = isInViewport(r);
      textCandidates.push({
        el,
        order: order++,
        priority: (inMain ? 30 : 0) + (inViewport ? 10 : 0),
        text: t,
      });
    }

    // 4) Open Shadow DOM roots
    let allEls = [];
    try { allEls = Array.from(root.querySelectorAll('*')); } catch {}
    for (const el of allEls) {
      if (el.shadowRoot) {
        collectFromRoot(el.shadowRoot, ownerDoc, view, offset, frameId, shadowDepth + 1);
      }
    }

    // 5) Accessible same-origin iframes (top-level document only to keep refs bounded)
    if (!frameId && frameSeq < MAX_FRAMES) {
      let iframes = [];
      try { iframes = Array.from(root.querySelectorAll('iframe')); } catch {}
      for (const frameEl of iframes) {
        if (frameSeq >= MAX_FRAMES) break;
        const fr = rectOf(frameEl, view, offset);
        if (!fr) continue;
        try {
          const childDoc = frameEl.contentDocument;
          const childWin = frameEl.contentWindow;
          if (!childDoc || !childDoc.documentElement || !childWin) continue;
          // Probe access (throws SecurityError on cross-origin frames)
          void childDoc.title;
          clearRefsInRoot(childDoc, 0);
          const fid = 'f' + ++frameSeq;
          frameEl.setAttribute('data-agent-frame', fid);
          collectFromRoot(childDoc, childDoc, childWin, { x: fr.left, y: fr.top }, fid, 0);
        } catch {}
      }
    }
  };

  collectFromRoot(document, document, window, { x: 0, y: 0 }, '', 0);

  // Select top MAX_ACTIONS by priority, then restore reading order (modals first)
  const totalActions = candidates.length;
  const chosenActions = candidates
    .slice()
    .sort((a, b) => (b.priority - a.priority) || (a.order - b.order))
    .slice(0, MAX_ACTIONS)
    .sort((a, b) => (Number(b.inModal) - Number(a.inModal)) || (a.order - b.order));

  const nodes = [];
  let refSeq = START_REF;
  for (const c of chosenActions) {
    const ref = 'e' + ++refSeq;
    try { c.el.setAttribute('data-agent-ref', ref); } catch {}
    const s = c.state;
    const node = {
      ref,
      role: c.role,
      name: c.name,
      value: s.value,
      href: c.href,
      kind: 'act',
      inViewport: c.inViewport,
      x: Math.round(c.rect.x),
      y: Math.round(c.rect.y),
      w: Math.round(c.rect.width),
      h: Math.round(c.rect.height),
    };
    if (c.frame) node.frame = c.frame;
    if (s.inputType && !['text', 'submit', 'button'].includes(s.inputType)) node.inputType = s.inputType;
    if (s.disabled) node.disabled = true;
    if (s.required) node.required = true;
    if (s.readonly) node.readonly = true;
    if (s.checked !== null) node.checked = s.checked;
    if (s.expanded !== null) node.expanded = s.expanded;
    if (s.selected) node.selected = true;
    if (s.options) {
      node.options = s.options;
      if (s.optionCount > s.options.length) node.optionCount = s.optionCount;
    }
    nodes.push(node);
  }

  // Select headings (prioritized, then reading order)
  const chosenHeadings = headingCandidates
    .slice()
    .sort((a, b) => (b.priority - a.priority) || (a.order - b.order))
    .slice(0, MAX_HEADINGS)
    .sort((a, b) => a.order - b.order);

  for (const h of chosenHeadings) {
    nodes.push({
      ref: '',
      role: h.role,
      name: h.name,
      kind: 'head',
      value: '',
      href: '',
      inViewport: h.inViewport,
      x: Math.round(h.rect.x),
      y: Math.round(h.rect.y),
      w: Math.round(h.rect.width),
      h: Math.round(h.rect.height),
    });
  }

  // Deduplicated readable prose snippets
  const chosenTexts = textCandidates
    .slice()
    .sort((a, b) => (b.priority - a.priority) || (a.order - b.order));
  const textBits = [];
  const seenTextKeys = new Set();
  for (const item of chosenTexts) {
    if (textBits.length >= MAX_TEXT) break;
    const key = item.text.toLowerCase().slice(0, 80);
    if (seenTextKeys.has(key)) continue;
    seenTextKeys.add(key);
    textBits.push({ order: item.order, text: item.text });
  }
  textBits.sort((a, b) => a.order - b.order);

  const bodyText = document.body ? textOf(document.body).slice(0, 12000) : '';

  // Avoid expensive full-DOM outerHTML serialization on large pages when Navigation Timing is available.
  let htmlBytes = 0;
  try {
    const nav = typeof performance !== 'undefined' && performance.getEntriesByType
      ? performance.getEntriesByType('navigation')[0]
      : null;
    htmlBytes = Number(nav?.decodedBodySize || nav?.transferSize || 0);
  } catch {}
  if (!htmlBytes) {
    htmlBytes = bodyText.length * 4 || (document.documentElement?.innerHTML?.length || 0);
  }

  const docHeight = Math.round(
    Math.max(
      document.documentElement?.scrollHeight || 0,
      document.body?.scrollHeight || 0,
      vh,
    ),
  );

  return {
    url: location.href,
    title: document.title || '',
    vw,
    vh,
    scrollY: Math.round(window.scrollY || 0),
    docHeight,
    htmlBytes,
    totalActions,
    truncatedActions: Math.max(0, totalActions - chosenActions.length),
    nodes,
    textBits: textBits.map((t) => t.text),
    bodyText,
  };
};

const tokenEstimate = (s) => Math.round(s.length / 4);

function formatFlags(nd) {
  const flags = [];
  if (nd.disabled) flags.push('disabled');
  if (nd.required) flags.push('required');
  if (nd.readonly) flags.push('readonly');
  if (nd.checked === 'mixed') flags.push('checked=mixed');
  else if (nd.checked === true) flags.push('checked');
  else if (nd.checked === false) flags.push('unchecked');
  if (nd.expanded === true) flags.push('expanded');
  else if (nd.expanded === false) flags.push('collapsed');
  if (nd.selected) flags.push('selected');
  if (nd.frame) flags.push(`frame=${nd.frame}`);
  return flags;
}

export function renderDoc(raw, { devtoolsBadge = '' } = {}) {
  const lines = [];
  lines.push(`[url] ${raw.url}`);
  lines.push(`[title] ${raw.title}`);
  lines.push(`[viewport] ${raw.vw}x${raw.vh}  scrollY=${raw.scrollY}/${Math.max(0, raw.docHeight - raw.vh)}`);
  if (devtoolsBadge) {
    lines.push(`[devtools] ${devtoolsBadge}`);
  }
  if (raw.truncatedActions > 0) {
    lines.push(`[actions] showing ${raw.nodes.filter((nd) => nd.ref).length} of ${raw.totalActions} (${raw.truncatedActions} lower-priority controls omitted)`);
  }

  for (const nd of raw.nodes) {
    if (nd.kind === 'head') {
      lines.push(`${nd.role}[${nd.inViewport ? 'v' : '·'}] ${JSON.stringify(nd.name)}`);
      continue;
    }
    const roleLabel = nd.inputType && nd.role === 'textbox' ? `textbox[${nd.inputType}]` : nd.role;
    const bits = [roleLabel, JSON.stringify(nd.name)];
    if (nd.value) bits.push(`value=${JSON.stringify(nd.value)}`);
    const flags = formatFlags(nd);
    if (flags.length) bits.push(`[${flags.join(',')}]`);
    if (Array.isArray(nd.options) && nd.options.length) {
      const optSummary = nd.options
        .slice(0, 8)
        .map((o) => (o.selected ? `*${JSON.stringify(o.label)}` : JSON.stringify(o.label)))
        .join(', ');
      const more = (nd.optionCount || nd.options.length) > 8 ? ', …' : '';
      bits.push(`options=[${optSummary}${more}]`);
    }
    if (nd.href) bits.push(`→ ${nd.href.startsWith('http') ? nd.href : nd.href.slice(0, 80)}`);
    if (!nd.inViewport) bits.push('(offscreen)');
    lines.push(`${nd.ref} ${bits.join(' ')}`);
  }

  if (raw.textBits?.length) {
    lines.push('');
    lines.push('-- text --');
    for (const t of raw.textBits) lines.push('· ' + t);
  }

  const text = lines.join('\n');
  const boxes = raw.nodes.filter((nd) => nd.ref).map((nd) => {
    const box = {
      ref: nd.ref,
      role: nd.role,
      name: nd.name,
      x: nd.x,
      y: nd.y,
      w: nd.w,
      h: nd.h,
      v: nd.inViewport,
    };
    if (nd.frame) box.frame = nd.frame;
    if (nd.value) box.value = nd.value;
    if (nd.inputType) box.inputType = nd.inputType;
    if (nd.href) box.href = nd.href;
    if (nd.disabled) box.disabled = true;
    if (nd.required) box.required = true;
    if (nd.readonly) box.readonly = true;
    if (nd.checked !== undefined) box.checked = nd.checked;
    if (nd.expanded !== undefined) box.expanded = nd.expanded;
    if (nd.options) box.options = nd.options;
    return box;
  });

  return {
    text,
    boxes,
    tokens: tokenEstimate(text),
    htmlBytes: raw.htmlBytes || 0,
    truncatedActions: raw.truncatedActions || 0,
    meta: {
      url: raw.url,
      title: raw.title,
      vw: raw.vw,
      vh: raw.vh,
      scrollY: raw.scrollY,
      docHeight: raw.docHeight,
    },
    bodyText: raw.bodyText || '',
    textBits: raw.textBits || [],
  };
}

export function toWireSnapshot(snap, { full = true, includeBody = false } = {}) {
  if (!snap) return null;
  const out = {
    text: snap.text,
    tokens: snap.tokens,
    htmlBytes: snap.htmlBytes,
    truncatedActions: snap.truncatedActions || 0,
    meta: snap.meta,
  };
  if (full) out.boxes = snap.boxes;
  if (includeBody) {
    out.bodyText = snap.bodyText;
    out.textBits = snap.textBits;
  }
  return out;
}

export async function takeSnapshot(page, startRefOrOpts = 0) {
  const devtoolsBadge = typeof startRefOrOpts === 'object' && startRefOrOpts
    ? String(startRefOrOpts.devtoolsBadge || '')
    : '';
  const raw = await page.evaluate(PAGE_PROBE, startRefOrOpts);
  return renderDoc(raw, { devtoolsBadge });
}
