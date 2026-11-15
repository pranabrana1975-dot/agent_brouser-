// inspector.mjs — In-page & CDP "F12 DevTools" panels for agents:
//   - Elements, Box Model, Computed CSS, & Clickability/Occlusion diagnosis (browser_inspect)
//   - Full ARIA / Accessibility tree (browser_a11y)
//   - Snapshot/DOM Diff + MutationObserver Toast/Alert catcher (browser_diff)
//   - Core Web Vitals, Resource waterfall, DOM stats & CDP Memory/Layout metrics (browser_perf)
//   - Mini-Lighthouse Accessibility + SEO + Security + Reliability Audit (browser_audit)
//   - Application Storage Inspector & selective clearer (browser_storage)
//   - Security, TLS, Security-Header grading & Third-Party tracker report (browser_security)
//   - Device Toolbar & Media/Geo/Timezone emulation presets (browser_emulate)
//   - Set-of-Mark `[eN]` visual overlay for annotated screenshots (browser_screenshot annotate)

const SENSITIVE_STORAGE_KEY_RE = /(passw(or)?d|secret|token|api[-_]?key|auth|credential|private[-_]?key|session|jwt|bearer|csrf|xsrf)/i;

export const DEVICE_PRESETS = {
  desktop: {
    name: 'desktop',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    mobile: false,
    userAgent: '',
  },
  'desktop-hd': {
    name: 'desktop-hd',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    mobile: false,
    userAgent: '',
  },
  'iphone-15': {
    name: 'iphone-15',
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    mobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
  'pixel-8': {
    name: 'pixel-8',
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36',
  },
  ipad: {
    name: 'ipad',
    viewport: { width: 820, height: 1180 },
    deviceScaleFactor: 2,
    mobile: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
};

export const SECURITY_HEADER_SPECS = [
  { name: 'content-security-policy', label: 'Content-Security-Policy', severity: 'warning', why: 'mitigates XSS and injection' },
  { name: 'strict-transport-security', label: 'Strict-Transport-Security', severity: 'warning', why: 'enforces HTTPS (HSTS)', httpsOnly: true },
  { name: 'x-content-type-options', label: 'X-Content-Type-Options', severity: 'warning', why: 'prevents MIME sniffing' },
  { name: 'x-frame-options', label: 'X-Frame-Options', severity: 'info', why: 'prevents clickjacking' },
  { name: 'referrer-policy', label: 'Referrer-Policy', severity: 'info', why: 'controls referrer leakage' },
  { name: 'permissions-policy', label: 'Permissions-Policy', severity: 'info', why: 'restricts sensitive browser APIs' },
  { name: 'cross-origin-opener-policy', label: 'Cross-Origin-Opener-Policy', severity: 'info', why: 'isolates browsing context (COOP)' },
];

// Lightweight init script installed on every page to capture ephemeral toasts/alerts
// (that vanish in 1-2s before a snapshot runs) plus LCP and CLS Web Vitals.
export const DEVTOOLS_INIT_SCRIPT = () => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  } catch {}

  try {
    if (window.__abDevtools) return;
    const state = { toasts: [], seen: [], lcpMs: null, cls: 0 };
    Object.defineProperty(window, '__abDevtools', { value: state, configurable: false, enumerable: false });

    const TOAST_SEL = '[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"], '
      + '.toast, .snackbar, [data-sonner-toast], [data-testid*="toast" i], [class*="toast-" i], [class*="-toast" i]';

    const recordToast = (el) => {
      if (!el || el.nodeType !== 1) return;
      const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (text.length < 2) return;
      const now = Date.now();
      // Deduplicate identical messages raised within 3 seconds.
      if (state.toasts.some((t) => t.text === text && now - t.at < 3000)) return;
      const role = el.getAttribute?.('role') || el.getAttribute?.('aria-live') || 'toast';
      state.toasts.push({ text, role, at: now });
      if (state.toasts.length > 30) state.toasts.shift();
    };

    const startObserver = () => {
      const target = document.documentElement || document.body;
      if (!target || typeof MutationObserver === 'undefined') return;
      const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'childList') {
            for (const node of m.addedNodes) {
              if (!node || node.nodeType !== 1) continue;
              try {
                if (node.matches?.(TOAST_SEL)) recordToast(node);
                node.querySelectorAll?.(TOAST_SEL).forEach(recordToast);
              } catch {}
            }
          } else if (m.type === 'characterData' && m.target?.parentElement) {
            try {
              const host = m.target.parentElement.closest?.(TOAST_SEL);
              if (host) recordToast(host);
            } catch {}
          }
        }
      });
      mo.observe(target, { childList: true, subtree: true, characterData: true });
    };

    if (document.documentElement) startObserver();
    else document.addEventListener('DOMContentLoaded', startObserver, { once: true });

    if (typeof PerformanceObserver !== 'undefined') {
      try {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          if (last) state.lcpMs = Math.round(last.renderTime || last.loadTime || last.startTime || 0);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {}
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (!e.hadRecentInput && typeof e.value === 'number') {
              state.cls = Math.round((state.cls + e.value) * 10000) / 10000;
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {}
    }
  } catch {}
};

// Read captured ephemeral toast/alert messages from the active page.
export async function readToasts(page, { clear = false } = {}) {
  if (!page?.evaluate) return [];
  try {
    return await page.evaluate((shouldClear) => {
      const st = window.__abDevtools;
      if (!st || !Array.isArray(st.toasts)) return [];
      const copy = st.toasts.slice();
      if (shouldClear) st.toasts.length = 0;
      return copy;
    }, Boolean(clear));
  } catch {
    return [];
  }
}

// ---------- 1) Elements + Box Model + Computed CSS + Clickability Doctor ----------
export async function inspectElement(page, { ref = '', selector = '', frame = '' } = {}) {
  if (!ref && !selector) throw new Error('ref or selector required');
  const data = await page.evaluate(({ ref, selector, frame }) => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const num = (v) => Math.round((parseFloat(v) || 0) * 100) / 100;

    const findInRoots = (root, sel, depth = 0) => {
      if (!root || depth > 6) return null;
      try {
        const direct = root.querySelector(sel);
        if (direct) return direct;
      } catch {
        return null;
      }
      let all = [];
      try { all = Array.from(root.querySelectorAll('*')); } catch {}
      for (const node of all) {
        if (node.shadowRoot) {
          const found = findInRoots(node.shadowRoot, sel, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };

    let ownerDoc = document;
    let ownerWin = window;
    let frameOffset = { x: 0, y: 0 };

    if (frame) {
      const iframe = document.querySelector(`iframe[data-agent-frame="${frame}"]`);
      if (iframe?.contentDocument && iframe?.contentWindow) {
        const fr = iframe.getBoundingClientRect();
        frameOffset = { x: fr.left || fr.x || 0, y: fr.top || fr.y || 0 };
        ownerDoc = iframe.contentDocument;
        ownerWin = iframe.contentWindow;
      }
    }

    const query = ref ? `[data-agent-ref="${ref}"]` : selector;
    const el = findInRoots(ownerDoc, query, 0);
    if (!el) return null;

    const domPathOf = (node) => {
      const parts = [];
      let cur = node;
      let steps = 0;
      while (cur && cur.nodeType === 1 && steps < 8) {
        let seg = cur.tagName.toLowerCase();
        if (cur.id) {
          seg += `#${cur.id}`;
          parts.unshift(seg);
          break;
        }
        const cls = Array.from(cur.classList || []).slice(0, 2).join('.');
        if (cls) seg += `.${cls}`;
        else if (cur.parentElement) {
          const siblings = Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName);
          if (siblings.length > 1) seg += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
        }
        parts.unshift(seg);
        cur = cur.parentElement;
        steps++;
      }
      return parts.join(' > ');
    };

    const tag = el.tagName.toLowerCase();
    const isPassword = tag === 'input' && (el.getAttribute('type') || el.type || '').toLowerCase() === 'password';

    const attributes = {};
    for (const attr of Array.from(el.attributes || [])) {
      if (attr.name === 'data-agent-ref') continue;
      if (isPassword && attr.name.toLowerCase() === 'value') {
        attributes[attr.name] = '[REDACTED]';
      } else {
        attributes[attr.name] = String(attr.value || '').slice(0, 300);
      }
    }

    // Safe outerHTML preview (redact any password input values).
    let htmlSnippet = '';
    try {
      const clone = el.cloneNode(true);
      if (clone.tagName === 'INPUT' && (clone.getAttribute('type') || '').toLowerCase() === 'password' && clone.hasAttribute('value')) {
        clone.setAttribute('value', '[REDACTED]');
      }
      clone.querySelectorAll?.('input[type="password"][value]').forEach((p) => p.setAttribute('value', '[REDACTED]'));
      clone.removeAttribute?.('data-agent-ref');
      htmlSnippet = String(clone.outerHTML || '').slice(0, 600);
    } catch {}

    const r = el.getBoundingClientRect();
    const left = (Number.isFinite(r.left) ? r.left : (r.x || 0));
    const top = (Number.isFinite(r.top) ? r.top : (r.y || 0));
    const width = r.width || 0;
    const height = r.height || 0;
    const cs = ownerWin.getComputedStyle(el);

    const margin = {
      top: num(cs.marginTop), right: num(cs.marginRight),
      bottom: num(cs.marginBottom), left: num(cs.marginLeft),
    };
    const border = {
      top: num(cs.borderTopWidth), right: num(cs.borderRightWidth),
      bottom: num(cs.borderBottomWidth), left: num(cs.borderLeftWidth),
    };
    const padding = {
      top: num(cs.paddingTop), right: num(cs.paddingRight),
      bottom: num(cs.paddingBottom), left: num(cs.paddingLeft),
    };

    const boxModel = {
      x: Math.round(left + frameOffset.x),
      y: Math.round(top + frameOffset.y),
      width: Math.round(width),
      height: Math.round(height),
      top: Math.round(top + frameOffset.y),
      right: Math.round(left + width + frameOffset.x),
      bottom: Math.round(top + height + frameOffset.y),
      left: Math.round(left + frameOffset.x),
      content: {
        width: Math.max(0, Math.round(width - padding.left - padding.right - border.left - border.right)),
        height: Math.max(0, Math.round(height - padding.top - padding.bottom - border.top - border.bottom)),
      },
      padding,
      border,
      margin,
    };

    const styles = {
      display: cs.display || '',
      visibility: cs.visibility || '',
      opacity: cs.opacity || '1',
      position: cs.position || '',
      zIndex: cs.zIndex || 'auto',
      overflow: cs.overflow || '',
      pointerEvents: cs.pointerEvents || 'auto',
      cursor: cs.cursor || '',
      color: cs.color || '',
      backgroundColor: cs.backgroundColor || '',
      fontSize: cs.fontSize || '',
      fontWeight: cs.fontWeight || '',
      fontFamily: String(cs.fontFamily || '').slice(0, 120),
      lineHeight: cs.lineHeight || '',
    };

    const vw = ownerWin.innerWidth || 1280;
    const vh = ownerWin.innerHeight || 800;
    const hiddenByCss = cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.opacity || '1') === 0;
    const zeroSize = width < 1 || height < 1;
    const visible = !hiddenByCss && !zeroSize;
    const inViewport = visible && top < vh && (top + height) > 0 && left < vw && (left + width) > 0;
    const disabled = Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');
    const readonly = Boolean(el.readOnly || el.getAttribute('aria-readonly') === 'true');
    const required = Boolean(el.required || el.getAttribute('aria-required') === 'true');
    const checked = tag === 'input' && ['checkbox', 'radio'].includes((el.type || '').toLowerCase())
      ? Boolean(el.checked)
      : (el.getAttribute('aria-checked') === 'true' ? true : el.getAttribute('aria-checked') === 'false' ? false : null);
    const expanded = el.getAttribute('aria-expanded') === 'true' ? true : el.getAttribute('aria-expanded') === 'false' ? false : null;
    const focused = ownerDoc.activeElement === el;

    // Clickability & occlusion diagnosis (why did a click fail?)
    const reasons = [];
    if (cs.display === 'none') reasons.push('display is none');
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') reasons.push(`visibility is ${cs.visibility}`);
    if (parseFloat(cs.opacity || '1') === 0) reasons.push('opacity is 0 (transparent)');
    if (zeroSize) reasons.push(`zero/tiny dimensions (${Math.round(width)}x${Math.round(height)})`);
    if (cs.pointerEvents === 'none') reasons.push('pointer-events is none');
    if (disabled) reasons.push('element is disabled');
    if (visible && !inViewport) reasons.push('element is outside current viewport (scroll into view)');

    const cx = Math.round(left + width / 2);
    const cy = Math.round(top + height / 2);
    let occludedBy = null;
    let hitTarget = null;

    if (inViewport && typeof ownerDoc.elementFromPoint === 'function') {
      try {
        const hit = ownerDoc.elementFromPoint(cx, cy);
        if (hit) {
          hitTarget = domPathOf(hit);
          const sameOrRelated = hit === el || el.contains(hit) || hit.contains(el)
            || (hit.tagName === 'LABEL' && hit.control === el);
          if (!sameOrRelated) {
            const hs = ownerWin.getComputedStyle(hit);
            occludedBy = {
              tag: hit.tagName.toLowerCase(),
              id: hit.id || '',
              classes: Array.from(hit.classList || []).slice(0, 4),
              role: hit.getAttribute('role') || '',
              text: clean(hit.innerText || hit.textContent).slice(0, 100),
              domPath: hitTarget,
              zIndex: hs.zIndex || 'auto',
              position: hs.position || '',
            };
            reasons.push(`covered/occluded at center (${cx},${cy}) by ${hitTarget}`);
          }
        }
      } catch {}
    }

    const accessibleName = clean(
      el.getAttribute('aria-label')
      || el.labels?.[0]?.innerText
      || el.getAttribute('placeholder')
      || el.innerText
      || el.textContent
      || el.getAttribute('title')
      || el.getAttribute('alt')
      || '',
    ).slice(0, 160);

    return {
      ref: el.getAttribute('data-agent-ref') || ref || null,
      frame: frame || null,
      tag,
      id: el.id || '',
      classes: Array.from(el.classList || []),
      role: el.getAttribute('role') || tag,
      accessibleName,
      domPath: domPathOf(el),
      text: clean(el.innerText || el.textContent).slice(0, 300),
      value: isPassword ? (el.value ? '[REDACTED]' : '') : (typeof el.value === 'string' ? el.value.slice(0, 200) : null),
      childCount: el.children ? el.children.length : 0,
      attributes,
      htmlSnippet,
      boxModel,
      styles,
      states: { visible, inViewport, disabled, readonly, required, checked, expanded, focused },
      clickability: {
        clickable: reasons.length === 0,
        reasons,
        centerPoint: { x: cx + Math.round(frameOffset.x), y: cy + Math.round(frameOffset.y) },
        hitTarget,
        occludedBy,
      },
    };
  }, { ref, selector, frame });

  if (!data) throw new Error(`element not found: ${ref || selector}`);
  return data;
}

// ---------- 2) Full Accessibility / ARIA Tree ----------
export async function captureA11yTree(page, { locator = null, selector = '', ref = '', maxChars = 16000 } = {}) {
  const cap = Math.min(100_000, Math.max(200, Math.trunc(Number(maxChars) || 16000)));
  const url = page.url?.() || '';
  const title = (await page.title?.().catch(() => '')) || '';

  // Prefer Playwright's native ARIA snapshot when available, with a pure-DOM fallback
  // (works in JSDOM and custom engines too).
  let targetLoc = locator;
  if (!targetLoc && typeof page.locator === 'function') {
    if (ref) targetLoc = page.locator(`[data-agent-ref="${ref}"]`).first();
    else if (selector) targetLoc = page.locator(selector).first();
    else targetLoc = page.locator('body');
  }

  if (targetLoc && typeof targetLoc.ariaSnapshot === 'function') {
    try {
      const rawTree = await targetLoc.ariaSnapshot({ timeout: 8000 });
      if (typeof rawTree === 'string' && rawTree.trim()) {
        const truncated = rawTree.length > cap;
        return {
          url,
          title,
          source: 'ariaSnapshot',
          truncated,
          tree: truncated ? rawTree.slice(0, cap) : rawTree,
        };
      }
    } catch {}
  }

  // Fallback semantic ARIA walker
  const walked = await page.evaluate(({ ref, selector, cap }) => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const IMPLICIT_ROLES = {
      MAIN: 'main', NAV: 'navigation', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary',
      SECTION: 'region', ARTICLE: 'article', FORM: 'form', DIALOG: 'dialog',
      H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
      A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img',
      UL: 'list', OL: 'list', LI: 'listitem', TABLE: 'table', TR: 'row', TH: 'columnheader', TD: 'cell',
      SUMMARY: 'button',
    };
    const roleFor = (el) => {
      const r = clean(el.getAttribute?.('role')).toLowerCase();
      if (r) return r;
      if (el.tagName === 'INPUT') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'hidden') return '';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'search') return 'searchbox';
        if (['submit', 'button', 'reset'].includes(t)) return 'button';
        return 'textbox';
      }
      if (el.tagName === 'A' && !el.hasAttribute('href')) return '';
      return IMPLICIT_ROLES[el.tagName] || '';
    };
    const labelFor = (el) => clean(
      el.getAttribute?.('aria-label')
      || el.labels?.[0]?.textContent
      || el.getAttribute?.('alt')
      || el.getAttribute?.('placeholder')
      || (['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'A', 'BUTTON', 'SUMMARY', 'TH', 'LABEL'].includes(el.tagName) ? el.textContent : '')
      || el.getAttribute?.('title')
      || '',
    ).slice(0, 120);

    const root = ref
      ? document.querySelector(`[data-agent-ref="${ref}"]`)
      : (selector ? document.querySelector(selector) : document.body);
    if (!root) return null;

    const lines = [];
    let count = 0;
    const walk = (el, depth) => {
      if (!el || el.nodeType !== 1 || count > 600 || depth > 14) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) return;
      try {
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
      } catch {}

      const role = roleFor(el);
      let nextDepth = depth;
      if (role && role !== 'presentation' && role !== 'none') {
        const name = labelFor(el);
        const attrs = [];
        if (/^H[1-6]$/.test(el.tagName)) attrs.push(`level=${el.tagName[1]}`);
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') attrs.push('disabled');
        if (el.required || el.getAttribute('aria-required') === 'true') attrs.push('required');
        if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes((el.type || '').toLowerCase())) {
          attrs.push(el.checked ? 'checked' : 'unchecked');
        }
        const exp = el.getAttribute('aria-expanded');
        if (exp === 'true') attrs.push('expanded');
        else if (exp === 'false') attrs.push('collapsed');
        const aref = el.getAttribute('data-agent-ref');
        if (aref) attrs.push(`ref=${aref}`);
        const badge = attrs.length ? ` [${attrs.join(', ')}]` : '';
        lines.push(`${'  '.repeat(depth)}- ${role}${name ? ` ${JSON.stringify(name)}` : ''}${badge}`);
        count++;
        nextDepth = depth + 1;
      }
      for (const child of Array.from(el.children || [])) walk(child, nextDepth);
    };
    walk(root, 0);
    const full = lines.join('\n');
    return { tree: full.slice(0, cap), truncated: full.length > cap };
  }, { ref, selector, cap });

  if (!walked) throw new Error(`accessibility root not found: ${ref || selector || 'body'}`);
  return { url, title, source: 'dom-aria', truncated: walked.truncated, tree: walked.tree };
}

// ---------- 3) Snapshot / DOM Diff ----------
function boxKey(b) {
  return `${b.role}::${(b.name || '').toLowerCase()}::${b.href || ''}::${b.frame || ''}`;
}

function stateSig(b) {
  const parts = [];
  if (b.value) parts.push(`value=${JSON.stringify(b.value)}`);
  if (b.checked !== undefined && b.checked !== null) parts.push(b.checked === true ? 'checked' : b.checked === false ? 'unchecked' : `checked=${b.checked}`);
  if (b.disabled) parts.push('disabled');
  if (b.expanded === true) parts.push('expanded');
  else if (b.expanded === false) parts.push('collapsed');
  return parts.join(', ') || 'default';
}

export function diffSnapshots(before, after, toasts = []) {
  if (!before && !after) {
    return {
      hasBaseline: false,
      changed: toasts.length > 0,
      urlChanged: null,
      titleChanged: null,
      added: [],
      removed: [],
      modified: [],
      addedText: [],
      removedText: [],
      toasts,
      summary: toasts.length ? `Toasts:\n${toasts.map((t) => `! [${t.role}] ${t.text}`).join('\n')}` : '(no baseline snapshot yet)',
    };
  }

  if (!before) {
    return {
      hasBaseline: false,
      changed: true,
      urlChanged: { from: '', to: after.meta?.url || '' },
      titleChanged: { from: '', to: after.meta?.title || '' },
      added: (after.boxes || []).slice(0, 40).map((b) => ({ ref: b.ref, role: b.role, name: b.name })),
      removed: [],
      modified: [],
      addedText: (after.textBits || []).slice(0, 10),
      removedText: [],
      toasts,
      summary: `Initial snapshot at ${after.meta?.url || ''} (${after.boxes?.length || 0} controls)`,
    };
  }

  const urlChanged = before.meta?.url !== after.meta?.url
    ? { from: before.meta?.url || '', to: after.meta?.url || '' }
    : null;
  const titleChanged = before.meta?.title !== after.meta?.title
    ? { from: before.meta?.title || '', to: after.meta?.title || '' }
    : null;

  const prevMap = new Map();
  for (const b of before.boxes || []) {
    const k = boxKey(b);
    if (!prevMap.has(k)) prevMap.set(k, []);
    prevMap.get(k).push(b);
  }

  const added = [];
  const modified = [];
  for (const b of after.boxes || []) {
    const k = boxKey(b);
    const bucket = prevMap.get(k);
    if (!bucket || !bucket.length) {
      added.push({ ref: b.ref, role: b.role, name: b.name });
    } else {
      const old = bucket.shift();
      const fromState = stateSig(old);
      const toState = stateSig(b);
      if (fromState !== toState) {
        modified.push({ ref: b.ref, role: b.role, name: b.name, from: fromState, to: toState });
      }
    }
  }

  const removed = [];
  for (const bucket of prevMap.values()) {
    for (const old of bucket) {
      removed.push({ role: old.role, name: old.name });
    }
  }

  const prevTexts = new Set(before.textBits || []);
  const nextTexts = new Set(after.textBits || []);
  const addedText = [...nextTexts].filter((t) => !prevTexts.has(t)).slice(0, 12);
  const removedText = [...prevTexts].filter((t) => !nextTexts.has(t)).slice(0, 12);

  const lines = [];
  if (urlChanged) lines.push(`[url] ${urlChanged.from} → ${urlChanged.to}`);
  if (titleChanged) lines.push(`[title] ${JSON.stringify(titleChanged.from)} → ${JSON.stringify(titleChanged.to)}`);
  for (const t of toasts) lines.push(`! toast[${t.role}] ${JSON.stringify(t.text)}`);
  for (const m of modified.slice(0, 30)) lines.push(`~ ${m.ref} ${m.role} ${JSON.stringify(m.name)}: ${m.from} → ${m.to}`);
  for (const a of added.slice(0, 30)) lines.push(`+ ${a.ref} ${a.role} ${JSON.stringify(a.name)}`);
  for (const r of removed.slice(0, 30)) lines.push(`- ${r.role} ${JSON.stringify(r.name)}`);
  for (const t of addedText.slice(0, 8)) lines.push(`+ text: ${t.slice(0, 160)}`);
  for (const t of removedText.slice(0, 8)) lines.push(`- text: ${t.slice(0, 160)}`);

  const changed = Boolean(urlChanged || titleChanged || added.length || removed.length || modified.length || addedText.length || removedText.length || toasts.length);

  return {
    hasBaseline: true,
    changed,
    urlChanged,
    titleChanged,
    added: added.slice(0, 50),
    removed: removed.slice(0, 50),
    modified: modified.slice(0, 50),
    addedText,
    removedText,
    toasts,
    summary: lines.length ? lines.join('\n') : '(no visible DOM changes)',
  };
}

// ---------- 4) Performance, Web Vitals & CDP Memory/Layout Metrics ----------
export async function collectPerformance(page, { cdp = null } = {}) {
  const inPage = await page.evaluate(() => {
    const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
    let nav = null;
    let paints = [];
    let resources = [];
    try { nav = performance.getEntriesByType?.('navigation')?.[0] || null; } catch {}
    try { paints = performance.getEntriesByType?.('paint') || []; } catch {}
    try { resources = performance.getEntriesByType?.('resource') || []; } catch {}

    const fcp = paints.find((p) => p.name === 'first-contentful-paint');
    const fp = paints.find((p) => p.name === 'first-paint');
    const dt = window.__abDevtools || {};

    const vitals = {
      ttfbMs: nav ? round(nav.responseStart - nav.startTime) : null,
      fpMs: fp ? round(fp.startTime) : null,
      fcpMs: fcp ? round(fcp.startTime) : null,
      lcpMs: typeof dt.lcpMs === 'number' ? dt.lcpMs : null,
      cls: typeof dt.cls === 'number' ? dt.cls : 0,
      domInteractiveMs: nav ? round(nav.domInteractive - nav.startTime) : null,
      domContentLoadedMs: nav ? round(nav.domContentLoadedEventEnd - nav.startTime) : null,
      loadMs: nav && nav.loadEventEnd > 0 ? round(nav.loadEventEnd - nav.startTime) : null,
      transferBytes: nav?.transferSize || 0,
      decodedBytes: nav?.decodedBodySize || 0,
    };

    const byType = {};
    let totalTransferBytes = nav?.transferSize || 0;
    const resItems = [];
    for (const r of resources) {
      const type = r.initiatorType || 'other';
      byType[type] = (byType[type] || 0) + 1;
      const bytes = r.transferSize || r.encodedBodySize || 0;
      totalTransferBytes += bytes;
      resItems.push({
        url: String(r.name || '').slice(0, 300),
        type,
        durationMs: round(r.duration) ?? 0,
        transferBytes: bytes,
      });
    }
    resItems.sort((a, b) => b.durationMs - a.durationMs);

    const elements = document.querySelectorAll('*').length;
    const dom = {
      elements,
      forms: document.forms?.length || 0,
      scripts: document.scripts?.length || 0,
      stylesheets: document.styleSheets?.length || 0,
      images: document.images?.length || 0,
      iframes: document.querySelectorAll('iframe').length,
      links: document.links?.length || 0,
    };

    const perfMem = performance.memory;
    const memory = perfMem ? {
      jsHeapUsedBytes: perfMem.usedJSHeapSize || 0,
      jsHeapTotalBytes: perfMem.totalJSHeapSize || 0,
      jsHeapLimitBytes: perfMem.jsHeapSizeLimit || 0,
    } : null;

    return {
      url: location.href,
      title: document.title || '',
      vitals,
      dom,
      resources: {
        total: resources.length,
        totalTransferBytes,
        byType,
        slowest: resItems.slice(0, 10),
      },
      memory,
    };
  });

  // Enrich with Chrome DevTools Protocol Performance.getMetrics when available.
  let cdpMetrics = null;
  if (cdp?.send) {
    try {
      await cdp.send('Performance.enable');
      const { metrics } = await cdp.send('Performance.getMetrics');
      if (Array.isArray(metrics)) {
        const map = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
        cdpMetrics = {
          nodes: map.Nodes ?? null,
          documents: map.Documents ?? null,
          frames: map.Frames ?? null,
          jsEventListeners: map.JSEventListeners ?? null,
          layoutCount: map.LayoutCount ?? null,
          recalcStyleCount: map.RecalcStyleCount ?? null,
          layoutDurationMs: map.LayoutDuration !== undefined ? Math.round(map.LayoutDuration * 1000) : null,
          recalcStyleDurationMs: map.RecalcStyleDuration !== undefined ? Math.round(map.RecalcStyleDuration * 1000) : null,
          scriptDurationMs: map.ScriptDuration !== undefined ? Math.round(map.ScriptDuration * 1000) : null,
          taskDurationMs: map.TaskDuration !== undefined ? Math.round(map.TaskDuration * 1000) : null,
          jsHeapUsedBytes: map.JSHeapUsedSize ?? null,
          jsHeapTotalBytes: map.JSHeapTotalSize ?? null,
        };
        if (!inPage.memory && map.JSHeapUsedSize !== undefined) {
          inPage.memory = {
            jsHeapUsedBytes: map.JSHeapUsedSize,
            jsHeapTotalBytes: map.JSHeapTotalSize ?? 0,
          };
        }
      }
    } catch {}
  }

  return { ...inPage, cdpMetrics };
}

// ---------- 5) Application / Storage Inspector ----------
export function inspectSecurityHeaders(headers = {}, isHttps = true) {
  const lower = {};
  for (const [k, v] of Object.entries(headers || {})) lower[k.toLowerCase()] = String(v ?? '');
  const present = {};
  const missing = [];
  for (const spec of SECURITY_HEADER_SPECS) {
    if (spec.httpsOnly && !isHttps) continue;
    if (lower[spec.name]) {
      present[spec.name] = lower[spec.name].slice(0, 512);
    } else {
      // frame-ancestors inside CSP supersedes X-Frame-Options
      if (spec.name === 'x-frame-options' && /frame-ancestors/i.test(lower['content-security-policy'] || '')) {
        continue;
      }
      missing.push({ header: spec.label, severity: spec.severity, why: spec.why });
    }
  }
  return { present, missing };
}

export async function inspectStorage(page, ctx, { includeValues = false } = {}) {
  const pageUrl = page.url?.() || '';
  let rawCookies = [];
  if (typeof ctx?.cookies === 'function') {
    try {
      rawCookies = pageUrl.startsWith('http') ? await ctx.cookies(pageUrl) : await ctx.cookies();
    } catch {}
  }

  const cookies = rawCookies.slice(0, 150).map((c) => {
    const val = String(c.value ?? '');
    return {
      name: c.name,
      domain: c.domain || '',
      path: c.path || '/',
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: c.sameSite || 'None',
      session: !c.expires || c.expires < 0,
      expires: c.expires && c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null,
      size: String(c.name || '').length + val.length,
      value: includeValues ? val.slice(0, 200) : '[REDACTED]',
    };
  });

  const webStorage = await page.evaluate(({ includeValues, sensitivePattern }) => {
    const sensitiveRe = new RegExp(sensitivePattern, 'i');
    const dumpArea = (store) => {
      try {
        if (!store) return { count: 0, totalBytes: 0, entries: [] };
        const entries = [];
        let totalBytes = 0;
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (key === null) continue;
          const val = String(store.getItem(key) ?? '');
          const bytes = (key.length + val.length) * 2;
          totalBytes += bytes;
          if (entries.length < 100) {
            const redact = !includeValues && sensitiveRe.test(key);
            entries.push({
              key: key.slice(0, 160),
              bytes,
              valuePreview: redact ? '[REDACTED]' : val.slice(0, 160),
            });
          }
        }
        return { count: store.length, totalBytes, entries };
      } catch {
        return { count: 0, totalBytes: 0, entries: [], unavailable: true };
      }
    };

    const collectAsync = async () => {
      let indexedDBList = [];
      try {
        if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
          const dbs = await indexedDB.databases();
          indexedDBList = (dbs || []).slice(0, 50).map((d) => ({ name: d.name || '', version: d.version ?? null }));
        }
      } catch {}

      let serviceWorkers = [];
      try {
        if (navigator.serviceWorker?.getRegistrations) {
          const regs = await navigator.serviceWorker.getRegistrations();
          serviceWorkers = (regs || []).slice(0, 20).map((r) => ({
            scope: r.scope || '',
            scriptURL: r.active?.scriptURL || r.waiting?.scriptURL || r.installing?.scriptURL || '',
            state: r.active?.state || r.waiting?.state || r.installing?.state || 'unknown',
          }));
        }
      } catch {}

      let cacheBuckets = [];
      try {
        if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
          cacheBuckets = (await caches.keys()).slice(0, 50);
        }
      } catch {}

      return {
        origin: location.origin || '',
        url: location.href || '',
        localStorage: dumpArea(window.localStorage),
        sessionStorage: dumpArea(window.sessionStorage),
        indexedDB: indexedDBList,
        serviceWorkers,
        cacheStorage: cacheBuckets,
      };
    };

    return collectAsync();
  }, { includeValues: Boolean(includeValues), sensitivePattern: SENSITIVE_STORAGE_KEY_RE.source });

  return {
    origin: webStorage.origin,
    url: webStorage.url,
    cookies: {
      count: rawCookies.length,
      httpOnlyCount: cookies.filter((c) => c.httpOnly).length,
      secureCount: cookies.filter((c) => c.secure).length,
      entries: cookies,
    },
    localStorage: webStorage.localStorage,
    sessionStorage: webStorage.sessionStorage,
    indexedDB: webStorage.indexedDB,
    serviceWorkers: webStorage.serviceWorkers,
    cacheStorage: webStorage.cacheStorage,
  };
}

export async function clearStorage(page, ctx, targets = ['cookies', 'localStorage', 'sessionStorage']) {
  const allowed = new Set(['cookies', 'localStorage', 'sessionStorage', 'indexedDB', 'caches']);
  const list = (Array.isArray(targets) ? targets : ['cookies', 'localStorage', 'sessionStorage'])
    .filter((t) => allowed.has(t));
  const cleared = [];

  if (list.includes('cookies') && typeof ctx?.clearCookies === 'function') {
    await ctx.clearCookies();
    cleared.push('cookies');
  }

  const pageTargets = list.filter((t) => t !== 'cookies');
  if (pageTargets.length && page?.evaluate) {
    const done = await page.evaluate(async (items) => {
      const out = [];
      if (items.includes('localStorage')) {
        try { window.localStorage?.clear(); out.push('localStorage'); } catch {}
      }
      if (items.includes('sessionStorage')) {
        try { window.sessionStorage?.clear(); out.push('sessionStorage'); } catch {}
      }
      if (items.includes('indexedDB') && typeof indexedDB !== 'undefined' && indexedDB.databases) {
        try {
          const dbs = await indexedDB.databases();
          for (const d of dbs || []) {
            if (d?.name) indexedDB.deleteDatabase(d.name);
          }
          out.push('indexedDB');
        } catch {}
      }
      if (items.includes('caches') && typeof caches !== 'undefined' && caches.keys) {
        try {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
          out.push('caches');
        } catch {}
      }
      return out;
    }, pageTargets).catch(() => []);
    cleared.push(...done);
  }

  return { cleared };
}

// ---------- 6) Security & Third-Party Domain Report ----------
export async function inspectSecurity(page, ctx, tabDevtools) {
  const pageUrl = page.url?.() || '';
  let protocol = '';
  let origin = '';
  try {
    const u = new URL(pageUrl);
    protocol = u.protocol;
    origin = u.origin;
  } catch {}
  const isHttps = protocol === 'https:';

  const mainDoc = tabDevtools?.mainDocument || null;
  const headerReport = inspectSecurityHeaders(mainDoc?.headers || {}, isHttps);
  const mixedContent = tabDevtools ? tabDevtools.mixedContentRequests() : [];
  const thirdParty = tabDevtools ? tabDevtools.thirdPartySummary() : [];

  let cookies = [];
  if (typeof ctx?.cookies === 'function') {
    try { cookies = pageUrl.startsWith('http') ? await ctx.cookies(pageUrl) : await ctx.cookies(); } catch {}
  }
  const insecureCookies = cookies
    .filter((c) => (isHttps && !c.secure) || (!c.httpOnly && SENSITIVE_STORAGE_KEY_RE.test(c.name || '')))
    .slice(0, 25)
    .map((c) => ({ name: c.name, secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly), sameSite: c.sameSite || '' }));

  const pageFlags = await page.evaluate(() => ({
    isSecureContext: Boolean(window.isSecureContext),
    passwordInputs: document.querySelectorAll('input[type="password"]').length,
    insecureForms: Array.from(document.forms || [])
      .filter((f) => String(f.getAttribute('action') || '').trim().toLowerCase().startsWith('http://'))
      .map((f) => f.getAttribute('action').slice(0, 200))
      .slice(0, 10),
  })).catch(() => ({ isSecureContext: isHttps, passwordInputs: 0, insecureForms: [] }));

  return {
    url: pageUrl,
    origin,
    protocol,
    isHttps,
    isSecureContext: pageFlags.isSecureContext,
    mainStatus: mainDoc?.status ?? null,
    tls: mainDoc?.securityDetails || null,
    securityHeaders: headerReport,
    mixedContent,
    insecureForms: pageFlags.insecureForms,
    passwordOnInsecureOrigin: !isHttps && protocol === 'http:' && pageFlags.passwordInputs > 0,
    cookies: {
      total: cookies.length,
      secure: cookies.filter((c) => c.secure).length,
      httpOnly: cookies.filter((c) => c.httpOnly).length,
      flagged: insecureCookies,
    },
    thirdParty: {
      domainCount: thirdParty.length,
      totalRequests: thirdParty.reduce((n, d) => n + d.requests, 0),
      domains: thirdParty.slice(0, 40),
    },
  };
}

// ---------- 7) Mini-Lighthouse One-Call Audit ----------
export async function runPageAudit(page, { tabDevtools = null, cdp = null } = {}) {
  const domFindings = await page.evaluate(() => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const shortEl = (el) => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += `#${el.id}`;
      else if (el.getAttribute?.('name')) s += `[name="${el.getAttribute('name')}"]`;
      else if (el.getAttribute?.('src')) s += `[src="${el.getAttribute('src').slice(0, 60)}"]`;
      else if (el.getAttribute?.('href')) s += `[href="${el.getAttribute('href').slice(0, 60)}"]`;
      const ref = el.getAttribute?.('data-agent-ref');
      return ref ? `${s} (${ref})` : s;
    };

    // Images: missing alt & broken loads
    const imgs = Array.from(document.querySelectorAll('img'));
    const missingAlt = imgs
      .filter((img) => !img.hasAttribute('alt') && img.getAttribute('role') !== 'presentation' && img.getAttribute('aria-hidden') !== 'true')
      .map(shortEl);
    const brokenImages = imgs
      .filter((img) => img.getAttribute('src') && img.complete && typeof img.naturalWidth === 'number' && img.naturalWidth === 0 && !img.getAttribute('src').startsWith('data:'))
      .map(shortEl);

    // Unlabeled form controls
    const controls = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea'));
    const unlabeledInputs = controls.filter((el) => {
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (clean(el.getAttribute('aria-label'))) return false;
      if (clean(el.getAttribute('aria-labelledby'))) return false;
      if (el.labels && el.labels.length > 0 && clean(el.labels[0].textContent)) return false;
      if (el.id && document.querySelector(`label[for="${el.id.replace(/["\\]/g, '\\$&')}"]`)) return false;
      if (el.closest?.('label')) return false;
      if (clean(el.getAttribute('title'))) return false;
      return true;
    }).map(shortEl);

    // Empty interactive buttons & links
    const clickables = Array.from(document.querySelectorAll('button, a[href], [role="button"]'));
    const emptyButtons = clickables.filter((el) => {
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (clean(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title'))) return false;
      if (clean(el.innerText || el.textContent)) return false;
      if (el.querySelector('img[alt]:not([alt=""]), svg[aria-label], svg title')) return false;
      return true;
    }).map(shortEl);

    // Duplicate IDs
    const idCounts = new Map();
    document.querySelectorAll('[id]').forEach((el) => {
      if (el.id) idCounts.set(el.id, (idCounts.get(el.id) || 0) + 1);
    });
    const duplicateIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => `#${id}`);

    // Document metadata / SEO
    const lang = clean(document.documentElement?.getAttribute('lang'));
    const title = clean(document.title);
    const metaDesc = clean(document.querySelector('meta[name="description" i]')?.getAttribute('content'));
    const viewport = clean(document.querySelector('meta[name="viewport" i]')?.getAttribute('content'));
    const canonical = clean(document.querySelector('link[rel="canonical" i]')?.getAttribute('href'));
    const robots = clean(document.querySelector('meta[name="robots" i]')?.getAttribute('content'));
    const h1Count = document.querySelectorAll('h1').length;
    const passwordOnHttp = location.protocol === 'http:' && document.querySelectorAll('input[type="password"]').length > 0;
    const domSize = document.querySelectorAll('*').length;

    return {
      url: location.href,
      protocol: location.protocol,
      title,
      lang,
      metaDesc,
      viewport,
      canonical,
      robots,
      h1Count,
      domSize,
      passwordOnHttp,
      missingAlt,
      brokenImages,
      unlabeledInputs,
      emptyButtons,
      duplicateIds,
    };
  });

  const perf = await collectPerformance(page, { cdp }).catch(() => null);
  const issues = [];
  const deduct = { accessibility: 0, seo: 0, security: 0, reliability: 0 };

  const addIssue = (category, severity, code, message, items = [], penalty = 8) => {
    deduct[category] = Math.min(100, deduct[category] + penalty);
    issues.push({
      category,
      severity,
      code,
      message,
      count: items.length || 1,
      ...(items.length ? { examples: items.slice(0, 6) } : {}),
    });
  };

  // Accessibility checks
  if (!domFindings.lang) addIssue('accessibility', 'warning', 'missing-html-lang', '<html> element is missing a lang attribute', [], 10);
  if (domFindings.missingAlt.length) addIssue('accessibility', 'error', 'img-missing-alt', `${domFindings.missingAlt.length} image(s) missing alt text`, domFindings.missingAlt, 15);
  if (domFindings.unlabeledInputs.length) addIssue('accessibility', 'error', 'input-missing-label', `${domFindings.unlabeledInputs.length} form control(s) missing accessible label`, domFindings.unlabeledInputs, 18);
  if (domFindings.emptyButtons.length) addIssue('accessibility', 'warning', 'empty-control', `${domFindings.emptyButtons.length} link(s)/button(s) have no accessible name`, domFindings.emptyButtons, 12);
  if (domFindings.duplicateIds.length) addIssue('accessibility', 'warning', 'duplicate-id', `${domFindings.duplicateIds.length} duplicate element ID(s) found`, domFindings.duplicateIds, 8);

  // SEO checks
  if (!domFindings.title) addIssue('seo', 'error', 'missing-title', 'Document is missing a <title>', [], 25);
  else if (domFindings.title.length < 10 || domFindings.title.length > 70) {
    addIssue('seo', 'info', 'title-length', `Title length (${domFindings.title.length} chars) is outside the typical 10–70 char range`, [], 5);
  }
  if (!domFindings.metaDesc) addIssue('seo', 'warning', 'missing-meta-description', 'Missing <meta name="description">', [], 15);
  if (!domFindings.viewport) addIssue('seo', 'warning', 'missing-viewport', 'Missing <meta name="viewport">', [], 15);
  if (!domFindings.canonical) addIssue('seo', 'info', 'missing-canonical', 'Missing <link rel="canonical">', [], 8);
  if (domFindings.h1Count === 0) addIssue('seo', 'warning', 'missing-h1', 'Page has no <h1> heading', [], 12);
  else if (domFindings.h1Count > 1) addIssue('seo', 'info', 'multiple-h1', `Page has ${domFindings.h1Count} <h1> headings`, [], 5);
  if (/noindex/i.test(domFindings.robots)) addIssue('seo', 'warning', 'robots-noindex', 'Page specifies robots noindex', [], 10);

  // Security checks
  const isHttps = domFindings.protocol === 'https:';
  if (domFindings.protocol === 'http:') addIssue('security', 'warning', 'insecure-http', 'Page is served over unencrypted HTTP', [], 25);
  if (domFindings.passwordOnHttp) addIssue('security', 'error', 'password-over-http', 'Password field present on non-HTTPS page', [], 35);
  if (tabDevtools) {
    const mixed = tabDevtools.mixedContentRequests();
    if (mixed.length) addIssue('security', 'error', 'mixed-content', `${mixed.length} insecure HTTP subresource(s) on HTTPS page`, mixed.map((m) => m.url), 25);
    if (tabDevtools.mainDocument) {
      const secHeaders = inspectSecurityHeaders(tabDevtools.mainDocument.headers, isHttps);
      if (secHeaders.missing.length) {
        addIssue('security', 'info', 'missing-security-headers', `${secHeaders.missing.length} recommended security header(s) missing`, secHeaders.missing.map((h) => h.header), Math.min(30, secHeaders.missing.length * 6));
      }
    }
  }

  // Reliability & Performance checks
  if (domFindings.brokenImages.length) addIssue('reliability', 'error', 'broken-images', `${domFindings.brokenImages.length} broken image(s) failed to decode`, domFindings.brokenImages, 15);
  if (domFindings.domSize > 1500) addIssue('reliability', 'warning', 'large-dom', `Large DOM tree (${domFindings.domSize} elements)`, [], 10);
  if (perf?.vitals?.lcpMs && perf.vitals.lcpMs > 2500) addIssue('reliability', 'warning', 'slow-lcp', `Slow LCP (${perf.vitals.lcpMs}ms > 2500ms)`, [], 12);
  if (perf?.vitals?.cls && perf.vitals.cls > 0.1) addIssue('reliability', 'warning', 'high-cls', `High cumulative layout shift (CLS ${perf.vitals.cls} > 0.1)`, [], 12);

  if (tabDevtools) {
    const errs = tabDevtools.console.filter((c) => c.level === 'error' || c.level === 'pageerror');
    if (errs.length) addIssue('reliability', 'error', 'console-errors', `${errs.length} console/JS error(s) recorded`, errs.map((e) => e.text.slice(0, 120)), 20);
    const failedNet = tabDevtools.requests.filter((r) => r.failed && !/ERR_ABORTED/i.test(r.failureText || ''));
    if (failedNet.length) {
      addIssue('reliability', 'error', 'failed-requests', `${failedNet.length} failed network request(s)`, failedNet.map((r) => `${r.status || 'ERR'} ${r.url.slice(0, 100)}`), 20);
    }
  }

  const scores = {
    accessibility: Math.max(0, 100 - deduct.accessibility),
    seo: Math.max(0, 100 - deduct.seo),
    security: Math.max(0, 100 - deduct.security),
    reliability: Math.max(0, 100 - deduct.reliability),
  };
  scores.overall = Math.round((scores.accessibility + scores.seo + scores.security + scores.reliability) / 4);

  return {
    url: domFindings.url,
    title: domFindings.title,
    scores,
    issueCount: issues.length,
    issues,
  };
}

// ---------- 8) Gated Safe Console Expression Evaluator ----------
export async function evaluateExpression(page, expression, { timeoutMs = 5000 } = {}) {
  const code = String(expression || '').trim();
  if (!code) throw new Error('expression required');
  if (code.length > 8000) throw new Error('expression exceeds 8000 character limit');
  const limitMs = Math.min(15_000, Math.max(100, Math.trunc(Number(timeoutMs) || 5000)));

  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`evaluation timed out after ${limitMs}ms`)), limitMs);
    timer.unref?.();
  });

  try {
    const res = await Promise.race([
      page.evaluate(async (src) => {
        const formatVal = (val, depth = 0, seen = new WeakSet()) => {
          if (val === undefined) return { type: 'undefined', value: null, preview: 'undefined' };
          if (val === null) return { type: 'null', value: null, preview: 'null' };
          if (typeof val === 'boolean' || typeof val === 'number') return { type: typeof val, value: val, preview: String(val) };
          if (typeof val === 'bigint') return { type: 'bigint', value: val.toString(), preview: `${val}n` };
          if (typeof val === 'string') return { type: 'string', value: val.slice(0, 16000), preview: JSON.stringify(val.slice(0, 200)) };
          if (typeof val === 'function') return { type: 'function', value: null, preview: `[Function ${val.name || 'anonymous'}]` };
          if (val instanceof Error) return { type: 'error', value: { name: val.name, message: val.message, stack: String(val.stack || '').slice(0, 1000) }, preview: `${val.name}: ${val.message}` };
          if (typeof Element !== 'undefined' && val instanceof Element) {
            const id = val.id ? `#${val.id}` : '';
            const cls = val.classList?.length ? `.${Array.from(val.classList).slice(0, 2).join('.')}` : '';
            const desc = `<${val.tagName.toLowerCase()}${id}${cls}>`;
            return { type: 'element', value: desc, preview: desc };
          }
          if (depth > 4) return { type: typeof val, value: '[MaxDepth]', preview: '[MaxDepth]' };
          if (typeof val === 'object') {
            if (seen.has(val)) return { type: 'object', value: '[Circular]', preview: '[Circular]' };
            seen.add(val);
            if (Array.isArray(val)) {
              const arr = val.slice(0, 100).map((x) => formatVal(x, depth + 1, seen).value);
              return { type: 'array', value: arr, preview: `Array(${val.length})` };
            }
            const obj = {};
            for (const k of Object.keys(val).slice(0, 80)) {
              obj[k] = formatVal(val[k], depth + 1, seen).value;
            }
            const json = JSON.stringify(obj);
            return { type: 'object', value: json.length > 32000 ? json.slice(0, 32000) : obj, preview: json.slice(0, 240) };
          }
          return { type: typeof val, value: String(val), preview: String(val) };
        };

        try {
          const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
          let value;
          try {
            value = await new AsyncFn(`return (\n${src}\n);`)();
          } catch (syntaxErr) {
            if (syntaxErr instanceof SyntaxError) {
              value = await new AsyncFn(src)();
            } else {
              throw syntaxErr;
            }
          }
          return { ok: true, ...formatVal(value) };
        } catch (err) {
          return {
            ok: false,
            error: String(err?.message || err).slice(0, 500),
            stack: String(err?.stack || '').slice(0, 1200),
          };
        }
      }, code),
      timeoutPromise,
    ]);
    if (!res?.ok) throw new Error(res?.error || 'evaluation failed');
    return { type: res.type, value: res.value, preview: res.preview };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------- 9) Set-of-Mark `[eN]` Visual Overlay for Annotated Screenshots ----------
export async function withAnnotatedOverlay(page, boxes, captureFn) {
  const visibleBoxes = (boxes || []).filter((b) => b.v && b.w >= 4 && b.h >= 4).slice(0, 90);
  if (!visibleBoxes.length || !page?.evaluate) {
    return captureFn();
  }

  await page.evaluate((items) => {
    document.getElementById('__agentbrowser_som__')?.remove();
    const root = document.createElement('div');
    root.id = '__agentbrowser_som__';
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;font:bold 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;';

    const colorFor = (role) => {
      if (['textbox', 'searchbox', 'password', 'combobox', 'checkbox', 'radio', 'switch', 'file'].includes(role)) return '#d97706';
      if (role === 'link') return '#2563eb';
      return '#059669';
    };

    for (const b of items) {
      const color = colorFor(b.role);
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;border:2px solid ${color};border-radius:3px;box-sizing:border-box;background:${color}14;`;
      const tag = document.createElement('span');
      const labelTop = b.y >= 15 ? -15 : 0;
      tag.textContent = b.ref;
      tag.style.cssText = `position:absolute;left:-2px;top:${labelTop}px;background:${color};color:#fff;padding:1px 4px;border-radius:2px;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.35);`;
      box.appendChild(tag);
      root.appendChild(box);
    }
    document.documentElement.appendChild(root);
  }, visibleBoxes).catch(() => {});

  try {
    return await captureFn();
  } finally {
    await page.evaluate(() => {
      document.getElementById('__agentbrowser_som__')?.remove();
    }).catch(() => {});
  }
}
