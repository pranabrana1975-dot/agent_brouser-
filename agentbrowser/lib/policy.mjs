// policy.mjs — Guardrails for an agent-only browser: protocol validation,
// domain allow/block lists, private-network (SSRF) filtering, and human
// approval checks for high-impact actions.

import dns from 'node:dns/promises';
import net from 'node:net';

const RED_ZONE = [
  {
    id: 'destructive',
    re: /\b(delete|erase|destroy|remove|wipe|reset|purge|drop)\b|(?<![\p{L}\p{M}\p{N}])(মুছে ফেলুন|ডিলিট|রিসেট)(?![\p{L}\p{M}\p{N}])/iu,
    why: 'data loss',
  },
  {
    id: 'financial',
    re: /\b(pay|payment|purchase|buy now|buy|checkout|place order|complete order|transfer|wire|donate|subscribe now|add to cart|confirm order)\b|(?<![\p{L}\p{M}\p{N}])(পেমেন্ট|পরিশোধ|কিনুন|ক্রয় করুন|অর্ডার করুন|চেকআউট|দান করুন)(?![\p{L}\p{M}\p{N}])/iu,
    why: 'money movement',
  },
  {
    id: 'irreversible',
    re: /\b(cancel account|close account|delete account|deactivate|unsubscribe|revoke|terminate)\b|(?<![\p{L}\p{M}\p{N}])(অ্যাকাউন্ট বন্ধ|আনসাবস্ক্রাইব|বাতিল করুন)(?![\p{L}\p{M}\p{N}])/iu,
    why: 'hard to undo',
  },
  {
    id: 'publish',
    re: /\b(post|publish|tweet|reply|post comment|submit comment|add comment|comment|send message|send email|send)\b|(?<![\p{L}\p{M}\p{N}])(পোস্ট করুন|প্রকাশ করুন|মন্তব্য করুন|বার্তা পাঠান|পাঠান)(?![\p{L}\p{M}\p{N}])/iu,
    why: 'speaks as the user in public',
    skipPlainLinks: true,
  },
];

const RISKY_HREF_RE = /(?:^|\/)(delete|destroy|erase|wipe|unsubscribe|checkout|pay|payment|purchase|place-order|cancel-account|close-account|deactivate|revoke)(?:[/?#]|$)/i;
const SEARCH_LABEL_RE = /\b(search|find|query|filter|lookup|look up)\b|(?<![\p{L}\p{M}\p{N}])(খুঁজুন|অনুসন্ধান)(?![\p{L}\p{M}\p{N}])/iu;
const SUBMIT_CONTROL_RE = /\b(submit|confirm|save|send|continue|apply|proceed|ok|done|sign in|log in|login|register|sign up)\b|(?<![\p{L}\p{M}\p{N}])(জমা দিন|নিশ্চিত করুন|সংরক্ষণ|পাঠান|লগ ইন|সাইন ইন)(?![\p{L}\p{M}\p{N}])/iu;
const PASSIVE_LINK_RE = /\b(how to|what is|why|guide|docs|documentation|tutorial|article|read more|learn more|faq|help|wiki|review|news)\b/i;

const PRIVATE_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  '.localdomain',
  '.lan',
  '.corp',
  '.intranet',
];

const PRIVATE_EXACT_HOSTS = new Set([
  'localhost',
  'localdomain',
  'broadcasthost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'wpad',
]);

export const DEFAULT_BLOCKED_HOSTS = ['*.bank', 'bank.*', '*.bank.*', 'accounts.google.com'];
export const MIN_ACTION_INTERVAL_MS = Number(process.env.AGENT_BROWSER_MIN_INTERVAL_MS ?? 350);
export const MAX_ACTIONS_PER_TASK = Number(process.env.AGENT_BROWSER_MAX_TASK_ACTIONS ?? 40);
export const MAX_ACTIONS_PER_SESSION = Number(process.env.AGENT_BROWSER_MAX_ACTIONS ?? 2000);
export const DEFAULT_APPROVAL_TIMEOUT_MS = Number(process.env.AGENT_BROWSER_APPROVAL_TIMEOUT_MS ?? 120_000);

function parseIpv4Octets(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function isPrivateIpv4Octets([a, b, c]) {
  if (a === 0) return true;                                  // 0.0.0.0/8 (this network)
  if (a === 10) return true;                                 // 10.0.0.0/8 (RFC 1918)
  if (a === 100 && b >= 64 && b <= 127) return true;         // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true;                                // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true;                   // 169.254.0.0/16 (link-local + cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;          // 172.16.0.0/12 (RFC 1918)
  if (a === 192 && b === 0 && c === 0) return true;          // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && b === 0 && c === 2) return true;          // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true;                   // 192.168.0.0/16 (RFC 1918)
  if (a === 198 && (b === 18 || b === 19)) return true;      // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && c === 100) return true;       // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true;        // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true;                                 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function parseIpv6Groups(raw) {
  let s = raw.toLowerCase();
  // Embedded dotted IPv4 tail, e.g. ::ffff:127.0.0.1
  const lastColon = s.lastIndexOf(':');
  if (lastColon >= 0 && s.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4Octets(s.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - (left.length + right.length);
  if (halves.length === 2 && missing < 1) return null;
  const full = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (full.length !== 8) return null;
  const groups = [];
  for (const g of full) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  return groups;
}

function embeddedV4Octets(hi, lo) {
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

export function isPrivateOrReservedIp(input) {
  if (!input || typeof input !== 'string') return false;
  let s = input.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (s.includes('%')) return true; // zone-scoped IPv6 is link-local

  const kind = net.isIP(s);
  if (kind === 4) {
    const octets = parseIpv4Octets(s);
    return octets ? isPrivateIpv4Octets(octets) : true;
  }
  if (kind === 6) {
    const g = parseIpv6Groups(s);
    if (!g) return true;
    // ::/96 covers :: (unspecified), ::1 (loopback), and IPv4-compatible ::a.b.c.d
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      if (g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true;
      return isPrivateIpv4Octets(embeddedV4Octets(g[6], g[7]));
    }
    // ::ffff:0:0/96 IPv4-mapped
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
      return isPrivateIpv4Octets(embeddedV4Octets(g[6], g[7]));
    }
    // ::ffff:0:0:0/96 IPv4-translated
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) {
      return isPrivateIpv4Octets(embeddedV4Octets(g[6], g[7]));
    }
    // 64:ff9b::/96 NAT64 well-known prefix
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      return isPrivateIpv4Octets(embeddedV4Octets(g[6], g[7]));
    }
    // 64:ff9b:1::/48 local-use NAT64
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0x0001) return true;
    // 2002::/16 6to4 embeds IPv4 in g[1..2]
    if (g[0] === 0x2002) return isPrivateIpv4Octets(embeddedV4Octets(g[1], g[2]));
    // 100::/64 discard prefix
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
    // 2001:db8::/32 documentation
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
    // fc00::/7 unique local (ULA)
    if ((g[0] & 0xfe00) === 0xfc00) return true;
    // fe80::/10 link-local
    if ((g[0] & 0xffc0) === 0xfe80) return true;
    // ff00::/8 multicast
    if ((g[0] & 0xff00) === 0xff00) return true;
    return false;
  }
  return false;
}

export function isLoopbackHost(host) {
  if (!host || typeof host !== 'string') return false;
  const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (bare === 'localhost' || bare === '::1') return true;
  if (net.isIP(bare) === 4) {
    const octets = parseIpv4Octets(bare);
    return !!octets && octets[0] === 127;
  }
  if (net.isIP(bare) === 6) {
    const g = parseIpv6Groups(bare);
    return !!g && g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1;
  }
  return false;
}

export function isPrivateHostname(hostname) {
  const bare = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!bare) return true;
  if (PRIVATE_EXACT_HOSTS.has(bare)) return true;
  if (PRIVATE_HOST_SUFFIXES.some((suf) => bare.endsWith(suf))) return true;
  if (isPrivateOrReservedIp(bare)) return true;
  return false;
}

function escapeRegex(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

export function matchHostPattern(hostname, pattern) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const pat = String(pattern || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || !pat) return false;
  if (pat === '*') return true;

  // Plain domain (e.g. "example.com" or "accounts.google.com") matches itself and subdomains.
  if (!pat.includes('*')) {
    return host === pat || host.endsWith('.' + pat);
  }

  // Leading subdomain wildcard only: "*.example.com" matches example.com + sub.example.com;
  // "*.bank" (single TLD label) matches foo.bank + a.foo.bank without matching databank.org.
  if (pat.startsWith('*.') && !pat.slice(2).includes('*')) {
    const base = pat.slice(2);
    if (!base) return false;
    if (base.includes('.')) return host === base || host.endsWith('.' + base);
    return host.endsWith('.' + base);
  }

  // General label-aware glob:
  // - a whole label "*" matches one or more complete labels
  // - an in-label "*" (e.g. "*paypal*") stays within a single label (no dot crossing)
  const labels = pat.split('.');
  const parts = labels.map((lbl) => {
    if (lbl === '*') return '[^.]+(?:\\.[^.]+)*';
    return escapeRegex(lbl).replace(/\*/g, '[^.]*');
  });
  // Allow subdomains when the first label is an exact literal (e.g. "bank.*" -> "www.bank.com").
  const prefix = labels[0].includes('*') ? '^' : '^(?:[^.]+\\.)*';
  return new RegExp(prefix + parts.join('\\.') + '$', 'i').test(host);
}

export function normalizeHostList(value) {
  let raw;
  if (Array.isArray(value)) raw = value;
  else if (typeof value === 'string') raw = value.split(/[\n,]/);
  else return null;
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const cleaned = item.trim().toLowerCase().replace(/\.$/, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

export function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

export class Policy {
  constructor(opts = {}) {
    this.approvalsEnabled = typeof opts.approvalsEnabled === 'boolean' ? opts.approvalsEnabled : true;
    this.allowPrivateNetworks = typeof opts.allowPrivateNetworks === 'boolean'
      ? opts.allowPrivateNetworks
      : envFlag('ALLOW_PRIVATE_NETWORKS', false);
    this.approvalTimeoutMs = Number.isFinite(opts.approvalTimeoutMs) && opts.approvalTimeoutMs > 0
      ? opts.approvalTimeoutMs
      : DEFAULT_APPROVAL_TIMEOUT_MS;
    this.blockedHosts = normalizeHostList(opts.blockedHosts) ?? [...DEFAULT_BLOCKED_HOSTS];
    this.allowedHosts = normalizeHostList(opts.allowedHosts) ?? [];
    this.notes = [];
    this._dnsCache = new Map();
    this._dnsTtlMs = Number.isFinite(opts.dnsTtlMs) ? opts.dnsTtlMs : 10_000;
  }

  update(patch = {}) {
    if (typeof patch.approvalsEnabled === 'boolean') this.approvalsEnabled = patch.approvalsEnabled;
    if (typeof patch.allowPrivateNetworks === 'boolean') {
      this.allowPrivateNetworks = patch.allowPrivateNetworks;
      this._dnsCache.clear();
    }
    if (Number.isFinite(patch.approvalTimeoutMs) && patch.approvalTimeoutMs >= 0) {
      this.approvalTimeoutMs = patch.approvalTimeoutMs;
    }
    if (patch.blockedHosts !== undefined) {
      const list = normalizeHostList(patch.blockedHosts);
      if (!list) throw new Error('blockedHosts must be a string or array of strings');
      this.blockedHosts = list;
    }
    if (patch.allowedHosts !== undefined) {
      const list = normalizeHostList(patch.allowedHosts);
      if (!list) throw new Error('allowedHosts must be a string or array of strings');
      this.allowedHosts = list;
    }
    return this.toJSON();
  }

  toJSON() {
    return {
      approvalsEnabled: this.approvalsEnabled,
      allowPrivateNetworks: this.allowPrivateNetworks,
      approvalTimeoutMs: this.approvalTimeoutMs,
      blockedHosts: [...this.blockedHosts],
      allowedHosts: [...this.allowedHosts],
    };
  }

  hostAllowed(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return { ok: false, reason: 'invalid url' }; }
    if (parsed.protocol === 'about:' && parsed.href === 'about:blank') return { ok: true };
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, reason: 'only HTTP and HTTPS are allowed' };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, reason: 'credentials in URL are not allowed' };
    }

    const rawHost = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const host = rawHost.replace(/^\[|\]$/g, '');
    if (!host) return { ok: false, reason: 'invalid host' };

    for (const pat of this.blockedHosts) {
      if (matchHostPattern(host, pat)) {
        return { ok: false, reason: `host blocked by policy: ${pat}` };
      }
    }

    if (!this.allowPrivateNetworks && isPrivateHostname(host)) {
      return { ok: false, reason: `private or loopback network blocked: ${host}` };
    }

    if (this.allowedHosts.length && !this.allowedHosts.some((p) => matchHostPattern(host, p))) {
      return { ok: false, reason: 'host not in allowlist' };
    }
    return { ok: true };
  }

  async resolveAllowed(url, { lookup = dns.lookup } = {}) {
    const basic = this.hostAllowed(url);
    if (!basic.ok) return basic;
    if (this.allowPrivateNetworks) return basic;

    let parsed;
    try { parsed = new URL(url); } catch { return { ok: false, reason: 'invalid url' }; }
    if (parsed.protocol === 'about:') return basic;

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (net.isIP(host)) return basic; // already checked by hostAllowed

    const now = Date.now();
    const cached = this._dnsCache.get(host);
    if (cached && cached.expiresAt > now) return cached.result;

    let result = { ok: true };
    try {
      const records = await lookup(host, { all: true, verbatim: true });
      const list = Array.isArray(records) ? records : [records];
      for (const rec of list) {
        const addr = typeof rec === 'string' ? rec : rec?.address;
        if (addr && isPrivateOrReservedIp(addr)) {
          result = { ok: false, reason: `host resolves to private/reserved address: ${host}` };
          break;
        }
      }
    } catch {
      // Unresolvable hosts fail naturally in browser navigation; don't cache transient failures.
      return { ok: true, unresolved: true };
    }

    if (this._dnsCache.size >= 256) {
      const oldestKey = this._dnsCache.keys().next().value;
      this._dnsCache.delete(oldestKey);
    }
    this._dnsCache.set(host, { result, expiresAt: now + this._dnsTtlMs });
    return result;
  }

  matchRedZone(text, { isPlainLink = false } = {}) {
    const s = String(text || '').trim();
    if (!s) return null;
    for (const rule of RED_ZONE) {
      if (isPlainLink && rule.skipPlainLinks) continue;
      const m = s.match(rule.re);
      if (m) {
        return {
          reason: `${rule.why} — matched "${m[0]}"`,
          rule: rule.id,
        };
      }
    }
    return null;
  }

  isSearchField({ role = '', inputType = '', name = '' } = {}) {
    if (role === 'searchbox' || inputType === 'search') return true;
    return SEARCH_LABEL_RE.test(String(name || ''));
  }

  isSubmitControl({ role = '', inputType = '', name = '' } = {}) {
    if (inputType === 'submit') return true;
    if (role && !['button', 'link', 'menuitem'].includes(role)) return false;
    return SUBMIT_CONTROL_RE.test(String(name || ''));
  }

  inspect(action = {}) {
    const {
      op = '',
      role = '',
      inputType = '',
      name = '',
      href = '',
      text = '',
      detail = '',
      dirtyRisk = null,
      hasPassword = false,
    } = action;

    // Typing into a search box should never block normal informational queries
    // such as "how to delete a git branch" or "buy laptop review".
    if (op === 'type' && this.isSearchField({ role, inputType, name })) {
      return { requireApproval: false };
    }

    // Submitting populated credentials requires approval (without blocking unrelated buttons/links).
    if (hasPassword) {
      const submittingCredentials =
        (op === 'type' && action.submit)
        || op === 'press'
        || (op === 'click' && this.isSubmitControl({ role, inputType, name }));
      if (submittingCredentials) {
        return {
          requireApproval: this.approvalsEnabled,
          reason: 'credential submission — password field populated',
          rule: 'credentials',
        };
      }
    }

    // Prevent split `type(submit: false)` + `click("Submit")` or `press("Enter")` bypass.
    if (dirtyRisk && (op === 'press' || (op === 'click' && this.isSubmitControl({ role, inputType, name })))) {
      return {
        requireApproval: this.approvalsEnabled,
        reason: dirtyRisk.reason,
        rule: dirtyRisk.rule,
      };
    }

    const isPlainLink = role === 'link' && !!href && !/^javascript:/i.test(href);

    // Passive informational/article links (e.g. "How to delete a branch" -> /blog/post/123)
    // should not trigger destructive/publish heuristics unless the URL itself is an action endpoint.
    let hrefHit = null;
    if (href) {
      let pathPart = href;
      try { pathPart = new URL(href, 'https://placeholder.invalid').pathname; } catch {}
      const hm = pathPart.match(RISKY_HREF_RE);
      if (hm) hrefHit = { reason: `high-impact endpoint — matched "/${hm[1]}"`, rule: 'endpoint' };
    }

    if (isPlainLink && PASSIVE_LINK_RE.test(name) && !hrefHit) {
      return { requireApproval: false };
    }

    // Check control label / detail (and typed text only for non-click operations,
    // never inspecting unrelated URL slugs like `/blog/post/42` against publish keywords).
    const candidates = [name, detail];
    if (op !== 'click') candidates.push(text);
    const labelHit = this.matchRedZone(candidates.filter(Boolean).join(' '), { isPlainLink });
    const hit = labelHit || hrefHit;
    if (hit) {
      return {
        requireApproval: this.approvalsEnabled,
        reason: hit.reason,
        rule: hit.rule,
      };
    }

    return { requireApproval: false };
  }
}
