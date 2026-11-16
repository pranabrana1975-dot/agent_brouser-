import TurndownService from 'turndown';

export const EXTRACT_FORMATS = [
  'text', 'html', 'markdown', 'links', 'forms', 'tables', 'metadata', 'items', 'schema',
];

const SAFE_ATTR_RE = /^(text|innerText|textContent|html|innerHTML|href|src|alt|title|datetime|content|aria-label|role|id|class|data-[a-z0-9_-]{1,60})$/i;
const ALLOWED_FIELD_TYPES = new Set(['string', 'number', 'boolean', 'url', 'list']);

export function normalizeExtractSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('schema object required when format="schema" (expected { container?, fields: { ... } })');
  }
  const fieldsRaw = schema.fields;
  if (!fieldsRaw || typeof fieldsRaw !== 'object' || Array.isArray(fieldsRaw)) {
    throw new Error('schema.fields must be a non-empty object mapping field names to CSS selectors');
  }
  const entries = Object.entries(fieldsRaw);
  if (!entries.length || entries.length > 40) {
    throw new Error('schema.fields must contain between 1 and 40 fields');
  }
  const fields = {};
  for (const [key, spec] of entries) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(key)) {
      throw new Error(`invalid schema field name: "${key}"`);
    }
    if (typeof spec === 'string') {
      if (!spec.trim() || spec.length > 300) throw new Error(`invalid selector for schema field "${key}"`);
      fields[key] = { selector: spec.trim(), attr: 'text', type: 'string', multiple: false };
    } else if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      const selector = String(spec.selector || '').trim();
      if (!selector || selector.length > 300) throw new Error(`invalid selector for schema field "${key}"`);
      const attr = String(spec.attr || 'text').trim();
      if (!SAFE_ATTR_RE.test(attr)) {
        throw new Error(`disallowed attribute "${attr}" in schema field "${key}" (form values are never exposed)`);
      }
      const type = String(spec.type || (spec.multiple ? 'list' : 'string')).toLowerCase();
      if (!ALLOWED_FIELD_TYPES.has(type)) {
        throw new Error(`invalid type "${type}" in schema field "${key}"`);
      }
      fields[key] = {
        selector,
        attr,
        type,
        multiple: Boolean(spec.multiple || type === 'list'),
      };
    } else {
      throw new Error(`schema field "${key}" must be a selector string or { selector, attr?, type?, multiple? }`);
    }
  }
  const container = schema.container ? String(schema.container).trim().slice(0, 300) : '';
  const limit = schema.limit !== undefined
    ? Math.min(500, Math.max(1, Math.trunc(Number(schema.limit) || 100)))
    : 100;
  return { container, fields, limit };
}

// Structured extraction runs in the page, never executes user-supplied JS, and
// never exposes form input values (passwords/tokens).
export async function extractPage(page, format = 'text', maxCharsOrOpts = 20000, extraOpts = {}) {
  const opts = typeof maxCharsOrOpts === 'object' && maxCharsOrOpts !== null
    ? maxCharsOrOpts
    : { maxChars: maxCharsOrOpts, ...extraOpts };
  const maxChars = opts.maxChars ?? 20000;

  if (!EXTRACT_FORMATS.includes(format)) {
    throw new Error(`unsupported extraction format: ${format}`);
  }
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 200000) {
    throw new Error('maxChars must be an integer between 1 and 200000');
  }

  const normalizedSchema = format === 'schema' ? normalizeExtractSchema(opts.schema) : null;
  const itemSelector = opts.selector ? String(opts.selector).trim().slice(0, 300) : '';

  const raw = await page.evaluate(({ format, maxChars, schema, itemSelector }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const absUrl = (href) => {
      if (!href) return '';
      try { return new URL(href, location.href).href.slice(0, 2048); } catch { return String(href).slice(0, 2048); }
    };
    const meta = { url: location.href, title: document.title || '' };

    // Detect next-page control/link for structured scrapers (items / schema / tables).
    const detectNextPage = () => {
      const relNext = document.querySelector('a[rel~="next" i][href], link[rel~="next" i][href]');
      if (relNext) {
        return {
          url: absUrl(relNext.getAttribute('href')),
          text: clean(relNext.innerText || relNext.textContent || 'Next').slice(0, 80),
          ref: relNext.getAttribute('data-agent-ref') || null,
        };
      }
      const NEXT_TEXT_RE = /^(next|next page|more|load more|older|older posts|পরবর্তী|আরও|›|»|→|next\s*[›»→])$/i;
      const NEXT_ARIA_RE = /\b(next page|go to next|next results|পরবর্তী পাতা|পরবর্তী)\b/i;
      const controls = Array.from(document.querySelectorAll('a[href], button:not([disabled])'));
      for (const el of controls) {
        const txt = clean(el.innerText || el.textContent);
        const aria = clean(el.getAttribute('aria-label') || el.getAttribute('title') || '');
        const cls = String(el.className || '');
        if (el.getAttribute('aria-disabled') === 'true' || /\bdisabled\b/i.test(cls)) continue;
        if (NEXT_TEXT_RE.test(txt) || NEXT_ARIA_RE.test(aria)) {
          const href = el.tagName === 'A' ? el.getAttribute('href') : '';
          const resolved = href && !href.startsWith('#') && !/^javascript:/i.test(href) ? absUrl(href) : '';
          return {
            url: resolved || null,
            text: (txt || aria || 'Next').slice(0, 80),
            ref: el.getAttribute('data-agent-ref') || null,
          };
        }
      }
      return null;
    };

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
      return { ...meta, tables, nextPage: detectNextPage() };
    }

    // Automatic repeated-card / listing extractor (products, jobs, pricing, articles, repos, search results)
    if (format === 'items') {
      const PRICE_RE = /(?:[$€£¥₹৳]|USD|EUR|GBP|INR|BDT)\s?\d[\d,]*(?:\.\d{1,2})?(?:\s*\/\s*(?:mo|month|yr|year))?/i;

      const parseCard = (el) => {
        const heading = el.querySelector('h1, h2, h3, h4, h5, [role="heading"], [class*="title" i], [class*="name" i]');
        const primaryLink = heading?.closest('a[href]')
          || heading?.querySelector('a[href]')
          || el.querySelector('a[href]');
        const title = clean(
          heading?.innerText || heading?.textContent
          || primaryLink?.innerText || primaryLink?.textContent || '',
        ).slice(0, 240);
        const url = primaryLink ? absUrl(primaryLink.getAttribute('href')) : '';
        const img = el.querySelector('img[src]');
        const image = img ? absUrl(img.getAttribute('src')) : '';
        const timeEl = el.querySelector('time, [datetime], [class*="date" i]');
        const date = clean(timeEl?.getAttribute?.('datetime') || timeEl?.textContent || '').slice(0, 80);
        const priceEl = el.querySelector('[class*="price" i], [data-price], [itemprop="price"]');
        const fullText = clean(el.innerText || el.textContent);
        const priceMatch = clean(priceEl?.textContent || '').match(PRICE_RE) || fullText.match(PRICE_RE);
        const price = priceMatch ? priceMatch[0].trim() : '';
        const authorEl = el.querySelector('[rel="author"], [itemprop="author"], [class*="author" i], [class*="company" i]');
        const author = clean(authorEl?.textContent || '').slice(0, 120);
        const badgeEl = el.querySelector('[class*="badge" i], [class*="tag" i], [class*="rating" i]');
        const badge = clean(badgeEl?.textContent || '').slice(0, 80);

        const para = el.querySelector('p, [class*="desc" i], [class*="summary" i], [class*="snippet" i]');
        let summary = clean(para?.innerText || para?.textContent || '');
        if (!summary && fullText.length > title.length + 10) {
          summary = clean(fullText.replace(title, '')).slice(0, 320);
        } else {
          summary = summary.slice(0, 320);
        }

        if (!title && !summary) return null;
        const item = { title: title || summary.slice(0, 100) };
        if (url) item.url = url;
        if (price) item.price = price;
        if (summary && summary !== item.title) item.summary = summary;
        if (date) item.date = date;
        if (author && author !== item.title) item.author = author;
        if (badge && badge !== item.title && badge !== price) item.badge = badge;
        if (image) item.image = image;
        const ref = primaryLink?.getAttribute('data-agent-ref') || el.getAttribute('data-agent-ref');
        if (ref) item.ref = ref;
        return item;
      };

      let elements = [];
      if (itemSelector) {
        elements = Array.from(document.querySelectorAll(itemSelector));
      } else {
        // Score candidate containers hosting >=2 structurally similar cards/rows (outside nav/footer).
        const root = document.querySelector('main, [role="main"]') || document.body;
        let bestGroup = [];
        let bestScore = 0;

        if (root) {
          // Direct semantic articles first
          const articles = Array.from(root.querySelectorAll('article')).filter((a) => !a.closest('nav, header, footer'));
          if (articles.length >= 2) {
            bestGroup = articles;
            bestScore = articles.length * 14;
          }

          const parents = Array.from(root.querySelectorAll('ul, ol, section, div, main'));
          for (const parent of parents.slice(0, 250)) {
            if (parent.closest('nav, header, footer')) continue;
            const kids = Array.from(parent.children).filter((c) => {
              const tag = c.tagName;
              return !['SCRIPT', 'STYLE', 'TEMPLATE', 'NAV', 'HEADER', 'FOOTER', 'HR', 'BR'].includes(tag);
            });
            if (kids.length < 2 || kids.length > 200) continue;

            // Group children by tag + primary class signature
            const buckets = new Map();
            for (const kid of kids) {
              const firstCls = String(kid.className || '').trim().split(/\s+/)[0] || '';
              const sig = `${kid.tagName}.${firstCls}`;
              if (!buckets.has(sig)) buckets.set(sig, []);
              buckets.get(sig).push(kid);
            }

            for (const group of buckets.values()) {
              if (group.length < 2) continue;
              let richCount = 0;
              for (const el of group.slice(0, 12)) {
                const txtLen = clean(el.textContent).length;
                if (txtLen < 12) continue;
                const hasHead = Boolean(el.querySelector('h1, h2, h3, h4, h5, [class*="title" i], [class*="name" i]'));
                const hasLink = Boolean(el.querySelector('a[href]'));
                const hasPriceOrDesc = Boolean(el.querySelector('p, [class*="price" i], [class*="desc" i], time'));
                if (hasHead || (hasLink && hasPriceOrDesc)) richCount += 1;
              }
              if (richCount < 2) continue;
              const ratio = richCount / Math.min(group.length, 12);
              const score = group.length * ratio * 10 + (group[0].tagName === 'ARTICLE' ? 15 : 0);
              if (score > bestScore) {
                bestScore = score;
                bestGroup = group;
              }
            }
          }
        }
        // Single-item fallback (e.g. final page of a paginated listing with 1 remaining card)
        if (!bestGroup.length && root) {
          const singles = Array.from(
            root.querySelectorAll('article, li[class*="card"], li[class*="item"], li[class*="product"], div[class*="card"], div[class*="product"], [role="listitem"]'),
          ).filter((el) => !el.closest('nav, header, footer') && Boolean(el.querySelector('h1, h2, h3, h4, a[href]')));
          if (singles.length) bestGroup = singles;
        }
        elements = bestGroup;
      }

      const items = elements.slice(0, 200).map(parseCard).filter(Boolean);
      return {
        ...meta,
        count: items.length,
        items,
        nextPage: detectNextPage(),
      };
    }

    // Declarative CSS/attribute schema extractor (eval-free, safe against secret leakage)
    if (format === 'schema' && schema) {
      const readAttr = (el, attr) => {
        if (!el) return null;
        // Never read form values
        const a = attr.toLowerCase();
        if (a === 'text' || a === 'innertext' || a === 'textcontent') {
          return clean(el.innerText || el.textContent).slice(0, 2000);
        }
        if (a === 'html' || a === 'innerhtml') {
          return String(el.innerHTML || '').trim().slice(0, 4000);
        }
        const rawVal = el.getAttribute(attr);
        if (rawVal === null) return null;
        if (a === 'href' || a === 'src') return absUrl(rawVal);
        return clean(rawVal).slice(0, 2000);
      };

      const coerce = (val, type) => {
        if (val === null || val === undefined) return null;
        if (type === 'number') {
          const cleaned = String(val).replace(/[^0-9.+-]/g, '');
          const n = Number(cleaned);
          return Number.isFinite(n) && cleaned !== '' ? n : null;
        }
        if (type === 'boolean') {
          if (typeof val === 'boolean') return val;
          const s = String(val).trim().toLowerCase();
          if (!s || s === 'false' || s === '0' || s === 'no') return false;
          return true;
        }
        if (type === 'url') return val ? absUrl(val) : null;
        return String(val);
      };

      const extractRecord = (scope) => {
        const rec = {};
        for (const [fieldName, spec] of Object.entries(schema.fields)) {
          if (spec.multiple) {
            const matched = Array.from(scope.querySelectorAll(spec.selector)).slice(0, 100);
            rec[fieldName] = matched
              .map((el) => coerce(readAttr(el, spec.attr), spec.type === 'list' ? 'string' : spec.type))
              .filter((v) => v !== null && v !== '');
          } else {
            const el = spec.selector === ':scope' ? scope : scope.querySelector(spec.selector);
            if (spec.type === 'boolean' && spec.attr === 'text') {
              rec[fieldName] = Boolean(el);
            } else {
              rec[fieldName] = el ? coerce(readAttr(el, spec.attr), spec.type) : null;
            }
          }
        }
        return rec;
      };

      if (schema.container) {
        const scopes = Array.from(document.querySelectorAll(schema.container)).slice(0, schema.limit);
        const items = scopes.map(extractRecord);
        return { ...meta, count: items.length, items, nextPage: detectNextPage() };
      }
      const data = extractRecord(document);
      return { ...meta, data, nextPage: detectNextPage() };
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
  }, { format, maxChars, schema: normalizedSchema, itemSelector });

  if (format === 'markdown') {
    raw.content = new TurndownService().turndown(raw.content).slice(0, maxChars);
  }
  return { format, ...raw };
}

// ---------- Multi-Page Auto-Pagination Scraper (honors SSRF policy + cycle guard) ----------
export async function paginateExtract(session, {
  format = 'items',
  maxPages = 1,
  maxChars = 20000,
  schema,
  selector,
  nextSelector,
  gen,
} = {}) {
  if (!['items', 'schema', 'tables', 'links'].includes(format)) {
    throw new Error(`auto-pagination supports items, schema, tables, or links (got "${format}")`);
  }
  const cap = Math.min(10, Math.max(1, Math.trunc(Number(maxPages) || 1)));
  const visitedUrls = new Set();
  const pageUrls = [];
  const allItems = [];
  const allTables = [];
  const allLinks = [];
  const seenItemKeys = new Set();
  let lastNextPage = null;

  for (let pageIdx = 0; pageIdx < cap; pageIdx++) {
    const page = session.activePage();
    if (!page) throw new Error('no active page');
    const curUrl = page.url?.() || '';
    visitedUrls.add(curUrl);
    pageUrls.push(curUrl);

    const extracted = await extractPage(page, format, { maxChars, schema, selector });
    lastNextPage = extracted.nextPage || null;

    if (format === 'items' || format === 'schema') {
      const list = Array.isArray(extracted.items) ? extracted.items : (extracted.data ? [extracted.data] : []);
      for (const item of list) {
        const dedupeKey = JSON.stringify(item);
        if (seenItemKeys.has(dedupeKey)) continue;
        seenItemKeys.add(dedupeKey);
        allItems.push({ ...item, _page: pageIdx + 1 });
      }
    } else if (format === 'tables') {
      for (const tbl of extracted.tables || []) {
        allTables.push({ ...tbl, _page: pageIdx + 1 });
      }
    } else if (format === 'links') {
      for (const lnk of extracted.links || []) {
        if (seenItemKeys.has(lnk.url)) continue;
        seenItemKeys.add(lnk.url);
        allLinks.push(lnk);
      }
    }

    if (pageIdx + 1 >= cap) break;

    // Resolve explicit nextSelector or auto-detected nextPage link/button.
    let nextTarget = lastNextPage;
    if (nextSelector) {
      nextTarget = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
        const href = el.tagName === 'A' ? el.getAttribute('href') : '';
        let url = null;
        if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) {
          try { url = new URL(href, location.href).href; } catch {}
        }
        return { url, ref: el.getAttribute('data-agent-ref') || null, text: (el.textContent || '').trim().slice(0, 60) };
      }, String(nextSelector).slice(0, 300)).catch(() => null);
    }

    if (!nextTarget) break;

    if (nextTarget.url) {
      if (visitedUrls.has(nextTarget.url)) break;
      const nav = await session.actNow({ op: 'open', url: nextTarget.url, compact: true, _skipRecord: true }, gen);
      if (nav?.error) break;
    } else if (nextTarget.ref) {
      const clicked = await session.actNow({ op: 'click', ref: nextTarget.ref, compact: true, _skipRecord: true }, gen);
      if (clicked?.error) break;
    } else {
      break;
    }
  }

  const base = {
    format,
    url: pageUrls[pageUrls.length - 1] || '',
    pageUrls,
    pagesVisited: pageUrls.length,
    hasMore: Boolean(lastNextPage?.url && !visitedUrls.has(lastNextPage.url)),
    nextPage: lastNextPage,
  };

  if (format === 'tables') return { ...base, count: allTables.length, tables: allTables };
  if (format === 'links') return { ...base, count: allLinks.length, links: allLinks };
  return { ...base, count: allItems.length, items: allItems };
}
