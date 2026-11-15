import TurndownService from 'turndown';

// Extraction runs in the page, but never executes user-supplied JavaScript.
export async function extractPage(page, format = 'text', maxChars = 20000) {
  if (!['text', 'html', 'markdown', 'links', 'forms'].includes(format)) throw new Error('unsupported extraction format');
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 200000) throw new Error('maxChars must be an integer between 1 and 200000');
  const raw = await page.evaluate(({ format, maxChars }) => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const meta = { url: location.href, title: document.title };
    if (format === 'links') {
      const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 500).map(a => ({ text: clean(a.innerText).slice(0, 300), url: a.href.slice(0, 2048) }));
      return { ...meta, links };
    }
    if (format === 'forms') {
      const forms = Array.from(document.forms).slice(0, 100).map(f => ({
        action: f.action, method: f.method,
        fields: Array.from(f.elements).slice(0, 200).map(e => ({ name: e.name, type: e.type, label: clean(e.labels?.[0]?.innerText || e.getAttribute('aria-label') || e.placeholder || ''), required: e.required, disabled: e.disabled, ref: e.getAttribute('data-agent-ref') || null }))
      }));
      return { ...meta, forms };
    }
    if (format === 'text') return { ...meta, content: (document.body?.innerText || '').slice(0, maxChars) };
    // Clone before removing non-content nodes; never mutate the live page.
    const root = document.querySelector('main, article, [role="main"]') || document.body;
    if (!root) return { ...meta, content: '' };
    if (format === 'html') return { ...meta, content: document.documentElement.outerHTML.slice(0, maxChars) };
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, template, svg, iframe').forEach(el => el.remove());
    for (const el of clone.querySelectorAll('a[href], img[src]')) {
      const attr = el.tagName === 'A' ? 'href' : 'src';
      try { el.setAttribute(attr, new URL(el.getAttribute(attr), location.href).href); } catch {}
    }
    return { ...meta, content: clone.innerHTML.slice(0, maxChars * 4) };
  }, { format, maxChars });
  if (format === 'markdown') raw.content = new TurndownService().turndown(raw.content).slice(0, maxChars);
  return { format, ...raw };
}
