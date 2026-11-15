// policy.mjs — "Guardrails": the part that makes an agent-only browser safe.
// Humans do not browse here; they only approve red-zone actions.

const RED_ZONE = [
  { id: 'destructive', re: /\b(delete|erase|destroy|remove|wipe|reset)\b/i, why: 'data loss' },
  { id: 'financial', re: /\b(pay|payment|purchase|buy|checkout|place order|transfer|wire|donate|subscribe now|add to cart)\b/i, why: 'money movement' },
  { id: 'irreversible', re: /\b(cancel account|close account|deactivate|unsubscribe|revoke|terminate)\b/i, why: 'hard to undo' },
  { id: 'publish', re: /\b(post|publish|tweet|reply|comment|send message)\b/i, why: 'speaks as the user in public' },
];

export class Policy {
  constructor() {
    this.approvalsEnabled = true;
    this.blockedHosts = ['*.bank*', 'accounts.google.com'];
    this.allowedHosts = []; // empty = everything allowed (still red-zone checked)
    this.notes = [];
  }

  hostAllowed(url) {
    let host = '';
    try { host = new URL(url).hostname; } catch { return { ok: false, reason: 'invalid url' }; }
    if (url.startsWith('file:')) return { ok: false, reason: 'file:// is not reachable from the agent' };
    for (const pat of this.blockedHosts) {
      const rx = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
      if (rx.test(host)) return { ok: false, reason: `host blocked by policy: ${pat}` };
    }
    if (this.allowedHosts.length && !this.allowedHosts.some((p) => host.endsWith(p))) {
      return { ok: false, reason: `host not in allowlist` };
    }
    return { ok: true };
  }

  inspect(action) {
    const blob = [action.name, action.href, action.text, action.detail].filter(Boolean).join(' ');
    for (const rule of RED_ZONE) {
      const m = blob.match(rule.re);
      if (m) {
        return {
          requireApproval: this.approvalsEnabled,
          reason: `${rule.why} — matched "${m[0]}"`,
          rule: rule.id,
        };
      }
    }
    return { requireApproval: false };
  }
}

export const MIN_ACTION_INTERVAL_MS = 350; // politeness / anti-hammering
export const MAX_ACTIONS_PER_TASK = 40;
