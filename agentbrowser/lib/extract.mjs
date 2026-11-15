import TurndownService from 'turndown';

export const EXTRACT_FORMATS = ['text', 'html', 'markdown', 'links', 'forms', 'tables', 'metadata'];

// Structured extraction runs in the page, never executes user-supplied JS, and
// never exposes form input values (passwords/tokens).
export async function extractPage(page, format = 'text', maxChars = 20000) {
  if (!EXTRACT_FORMATS.includes(format)) {
    throw new Error(`unsupported extraction format: ${format}`);
  }
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 200000) {
    throw new Error('maxChars must be an integer between 1 and 200000');
  }

  const raw = await page.evaluate(({ format, maxChars }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const absUrl = (href) => {
      if (!href) return '';
      try { return new URL(href, location.href).href.slice(0, 2048); } catch { return String(href).slice(0, 2048); }
    };
    const meta = { url: location.href, title: document.title || '' };

    if (format === 'links') {
      const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 500).map((a) => ({
        text: clean(a.innerText || a.textContent).slice(0, 300),
        url: absUrl(a.getAttribute('href')),
        ...(a.getAttribute('data-agent-ref') ? { ref: a.getAttribute('data-agent-ref') } : {}),
      }));
      return { ...meta, links };
    }

    if (format === 'forms') {
      const forms = Array.from(document.forms).slice(0, 100).map((f) => ({
        action: f.action,
        method: f.method,
        fields: Array.from(f.elements).slice(0, 200).map((e) => ({
          name: e.name,
          type: e.type,
          label: clean(e.labels?.[0]?.innerText || e.getAttribute('aria-label') || e.placeholder || ''),
          required: e.required,
          disabled: e.disabled,
          ref: e.getAttribute('data-agent-ref') || null,
        })),
      }));
      return { ...meta, forms };
    }

    if (format === 'tables') {
      const tables = Array.from(document.querySelectorAll('table')).slice(0, 50).map((tbl) => {
        const caption = clean(tbl.querySelector('caption')?.textContent).slice(0, 200);
        const allRows = Array.from(tbl.querySelectorAll('tr')).slice(0, 201);
        let headers = [];
        let dataStart = 0;

        const theadRow = tbl.querySelector('thead tr');
        if (theadRow) {
          headers = Array.from(theadRow.querySelectorAll('th, td')).map((c) => clean(c.innerText || c.textContent).slice(0, 120));
          dataStart = allRows[0] === theadRow ? 1 : 0;
        } else if (allRows[0] && allRows[0].querySelectorAll('th').length > 0) {
          headers = Array.from(allRows[0].querySelectorAll('th, td')).map((c) => clean(c.innerText || c.textContent).slice(0, 120));
          dataStart = 1;
        }

        const bodyRows = allRows.slice(dataStart).filter((tr) => !theadRow || tr !== theadRow);
        const rows = bodyRows.slice(0, 200).map((tr) => {
          const cells = Array.from(tr.querySelectorAll('td, th')).map((c) => clean(c.innerText || c.textContent).slice(0, 300));
          if (headers.length && headers.some(Boolean)) {
            const obj = {};
            headers.forEach((h, idx) => {
              const key = h || `col_${idx + 1}`;
              obj[key] = cells[idx] ?? '';
            });
            return obj;
          }
          return cells;
        }).filter((r) => (Array.isArray(r) ? r.length > 0 : Object.keys(r).length > 0));

        return {
          ...(caption ? { caption } : {}),
          headers,
          rowCount: rows.length,
          rows,
        };
      });
      return { ...meta, tables };
    }

    if (format === 'metadata') {
      const getMeta = (sel) => clean(document.querySelector(sel)?.getAttribute('content')).slice(0, 600);
      const openGraph = {};
      const twitter = {};
      document.querySelectorAll('meta[property^="og:" i], meta[name^="og:" i]').forEach((m) => {
        const k = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
        const v = clean(m.getAttribute('content')).slice(0, 600);
        if (k && v) openGraph[k] = v;
      });
      document.querySelectorAll('meta[name^="twitter:" i], meta[property^="twitter:" i]').forEach((m) => {
        const k = (m.getAttribute('name') || m.getAttribute('property') || '').toLowerCase();
        const v = clean(m.getAttribute('content')).slice(0, 600);
        if (k && v) twitter[k] = v;
      });

      const jsonLd = [];
      document.querySelectorAll('script[type="application/ld+json" i]').forEach((s) => {
        if (jsonLd.length >= 20) return;
        const txt = (s.textContent || '').trim();
        if (!txt || txt.length > 100_000) return;
        try { jsonLd.push(JSON.parse(txt)); } catch {}
      });

      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4')).slice(0, 60).map((h) => ({
        level: Number(h.tagName[1]),
        text: clean(h.innerText || h.textContent).slice(0, 200),
      })).filter((h) => h.text);

      const feeds = Array.from(document.querySelectorAll('link[rel~="alternate" i][type*="xml" i], link[rel~="alternate" i][type*="rss" i], link[rel~="alternate" i][type*="atom" i]'))
        .slice(0, 10)
        .map((l) => ({
          title: clean(l.getAttribute('title')).slice(0, 120),
          type: clean(l.getAttribute('type')).slice(0, 80),
          url: absUrl(l.getAttribute('href')),
        }));

      return {
        ...meta,
        metadata: {
          title: meta.title,
          description: getMeta('meta[name="description" i]'),
          canonical: absUrl(document.querySelector('link[rel="canonical" i]')?.getAttribute('href') || ''),
          lang: clean(document.documentElement?.getAttribute('lang')),
          charset: document.characterSet || '',
          robots: getMeta('meta[name="robots" i]'),
          author: getMeta('meta[name="author" i]'),
          keywords: getMeta('meta[name="keywords" i]'),
          viewport: getMeta('meta[name="viewport" i]'),
          favicon: absUrl(document.querySelector('link[rel*="icon" i]')?.getAttribute('href') || ''),
          openGraph,
          twitter,
          jsonLd,
          headings,
          feeds,
        },
      };
    }

    if (format === 'text') {
      return { ...meta, content: (document.body?.innerText || '').slice(0, maxChars) };
    }
    if (format === 'html') {
      return { ...meta, content: (document.documentElement?.outerHTML || '').slice(0, maxChars) };
    }

    // Markdown: clone before stripping non-content nodes so live DOM is never mutated.
    const root = document.querySelector('main, article, [role="main"]') || document.body;
    if (!root) return { ...meta, content: '' };
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, template, svg, iframe').forEach((el) => el.remove());
    for (const el of clone.querySelectorAll('a[href], img[src]')) {
      const attr = el.tagName === 'A' ? 'href' : 'src';
      try { el.setAttribute(attr, new URL(el.getAttribute(attr), location.href).href); } catch {}
    }
    return { ...meta, content: clone.innerHTML.slice(0, maxChars * 4) };
  }, { format, maxChars });

  if (format === 'markdown') {
    raw.content = new TurndownService().turndown(raw.content).slice(0, maxChars);
  }
  return { format, ...raw };
}
