// workflow.mjs — Batch action executor, semantic workflow recorder, zero-LLM-token
// replay engine with {{variable}} templates, and Playwright *.spec.mjs codegen.

import fs from 'node:fs/promises';
import path from 'node:path';

export const WORKFLOW_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const TEMPLATE_VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]{0,63})\s*\}\}/g;
export const MAX_BATCH_STEPS = 25;
export const MAX_WORKFLOW_STEPS = 100;
export const MAX_MEMORY_WORKFLOWS = 50;

export const ALLOWED_BATCH_OPS = new Set([
  'open', 'snapshot', 'click', 'dblclick', 'rightclick', 'drag', 'type',
  'select', 'press', 'hover', 'scroll', 'wait', 'wait_for', 'clipboard',
  'extract', 'read', 'screenshot', 'back', 'forward', 'reload', 'navigate',
]);

export function validateWorkflowName(name) {
  const s = String(name ?? '').trim();
  if (!WORKFLOW_NAME_RE.test(s)) {
    throw new Error('invalid workflow name (use 1-64 alphanumeric, ".", "_", or "-" characters)');
  }
  return s;
}

export function interpolateTemplate(value, vars = {}) {
  if (typeof value !== 'string') return value;
  return value.replace(TEMPLATE_VAR_RE, (full, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined && vars[key] !== null) {
      return String(vars[key]);
    }
    throw new Error(`missing workflow variable: {{${key}}}`);
  });
}

export function extractTemplateVariables(steps = []) {
  const vars = new Set();
  const scan = (val, depth = 0) => {
    if (depth > 5 || val == null) return;
    if (typeof val === 'string') {
      for (const m of val.matchAll(TEMPLATE_VAR_RE)) vars.add(m[1]);
    } else if (Array.isArray(val)) {
      for (const item of val) scan(item, depth + 1);
    } else if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) {
        if (k === 'target' || k === 'targetTo') continue;
        scan(v, depth + 1);
      }
    }
  };
  scan(steps, 0);
  return [...vars];
}

// Capture a durable multi-strategy semantic locator for a box before an action runs.
export async function captureSemanticTarget(page, box) {
  if (!box) return null;
  const base = {
    role: box.role || '',
    name: box.name || '',
    ...(box.inputType ? { inputType: box.inputType } : {}),
    ...(box.href ? { href: box.href } : {}),
    ...(box.frame ? { frame: box.frame } : {}),
  };

  if (!page?.evaluate || box.frame) return base;
  try {
    const extra = await page.evaluate((ref) => {
      const el = document.querySelector(`[data-agent-ref="${CSS.escape(ref)}"]`);
      if (!el) return null;
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy') || '';
      const id = el.id || '';
      const nameAttr = el.getAttribute('name') || '';
      const placeholder = el.getAttribute('placeholder') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const label = clean(el.labels?.[0]?.innerText || ariaLabel);
      const tag = el.tagName.toLowerCase();

      // Build concise unique CSS selector fallback
      let css = '';
      if (id && !/^\d/.test(id)) {
        css = `#${CSS.escape(id)}`;
      } else if (testId) {
        css = `[data-testid="${CSS.escape(testId)}"]`;
      } else if (nameAttr) {
        css = `${tag}[name="${CSS.escape(nameAttr)}"]`;
      } else {
        const parts = [];
        let cur = el;
        let depth = 0;
        while (cur && cur.nodeType === 1 && cur !== document.body && depth < 4) {
          let seg = cur.tagName.toLowerCase();
          if (cur.id) {
            seg = `#${CSS.escape(cur.id)}`;
            parts.unshift(seg);
            break;
          }
          const parent = cur.parentElement;
          if (parent) {
            const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
            if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
          }
          parts.unshift(seg);
          cur = parent;
          depth += 1;
        }
        css = parts.join(' > ');
      }

      return {
        tag,
        ...(testId ? { testId: testId.slice(0, 120) } : {}),
        ...(id ? { id: id.slice(0, 120) } : {}),
        ...(nameAttr ? { nameAttr: nameAttr.slice(0, 120) } : {}),
        ...(label ? { label: label.slice(0, 160) } : {}),
        ...(placeholder ? { placeholder: placeholder.slice(0, 160) } : {}),
        ...(css ? { css: css.slice(0, 260) } : {}),
      };
    }, box.ref);
    if (extra) Object.assign(base, extra);
  } catch {}
  return base;
}

// Match a recorded semantic target against the current snapshot's boxes (role+name -> label -> href),
// falling back to DOM CSS/testId tagging so session.act() executes with full policy/approval checks!
export async function resolveSemanticRef(session, page, target) {
  if (!target || typeof target !== 'object') return null;
  if (!session.snapshot) await session.snap();
  const boxes = session.snapshot?.boxes || [];
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  const wantRole = norm(target.role);
  const wantName = norm(target.name || target.label || target.placeholder);

  // 1) Exact role + accessible name match
  if (wantRole && wantName) {
    const exact = boxes.find((b) => norm(b.role) === wantRole && norm(b.name) === wantName);
    if (exact) return exact.ref;
  }
  // 2) Exact accessible name match
  if (wantName) {
    const byName = boxes.find((b) => norm(b.name) === wantName);
    if (byName) return byName.ref;
    // Partial substring match on role + name
    if (wantRole) {
      const partial = boxes.find((b) => norm(b.role) === wantRole && norm(b.name).includes(wantName));
      if (partial) return partial.ref;
    }
  }
  // 3) DOM fallback via testId / id / nameAttr / css — find existing data-agent-ref on the matched element
  const selectors = [];
  if (target.testId) selectors.push(`[data-testid=${JSON.stringify(target.testId)}]`);
  if (target.id) selectors.push(`#${target.id.replace(/[^a-zA-Z0-9_-]/g, '\\$&')}`);
  if (target.tag && target.nameAttr) selectors.push(`${target.tag}[name=${JSON.stringify(target.nameAttr)}]`);
  if (target.css) selectors.push(target.css);

  if (selectors.length && page?.evaluate) {
    try {
      const matchedRef = await page.evaluate((sels) => {
        for (const sel of sels) {
          try {
            const el = document.querySelector(sel);
            if (!el) continue;
            const r = el.getAttribute('data-agent-ref');
            if (r) return r;
          } catch {}
        }
        return null;
      }, selectors);
      if (matchedRef && boxes.some((b) => b.ref === matchedRef)) return matchedRef;
    } catch {}
  }

  return null;
}

// ---------- Workflow Recorder & Jailed File/Memory Store ----------
export class WorkflowRecorder {
  constructor() {
    this.active = false;
    this.name = '';
    this.description = '';
    this.startedAt = null;
    this.startUrl = '';
    this.steps = [];
    this._secretIdx = 1;
  }

  start({ name, description = '', startUrl = '' } = {}) {
    const valid = validateWorkflowName(name || `workflow-${Date.now()}`);
    this.active = true;
    this.name = valid;
    this.description = String(description || '').slice(0, 400);
    this.startedAt = new Date().toISOString();
    this.startUrl = String(startUrl || '');
    this.steps = [];
    this._secretIdx = 1;
    return this.status();
  }

  record(step, { control = null, targetControl = null, snapshot = null } = {}) {
    if (!this.active || !step || this.steps.length >= MAX_WORKFLOW_STEPS) return;
    const clean = { ...step };
    const boxes = Array.isArray(snapshot?.boxes) ? snapshot.boxes : [];
    const ctrl = control || (clean.ref ? boxes.find((b) => b.ref === clean.ref) || null : null);
    const tgtCtrl = targetControl || (clean.targetRef ? boxes.find((b) => b.ref === clean.targetRef) || null : null);
    if (!clean.target && ctrl) clean.target = { role: ctrl.role, name: ctrl.name || '', inputType: ctrl.inputType || '' };
    if (!clean.targetTo && tgtCtrl) clean.targetTo = { role: tgtCtrl.role, name: tgtCtrl.name || '' };
    if (clean.op === 'type' && ctrl?.inputType === 'password') clean.secret = true;
    // Never store raw passwords or secrets in workflows — auto-convert to {{secret_N}} variable!
    if (clean.secret) {
      const varName = clean.secretVar || `secret_${this._secretIdx++}`;
      clean.text = `{{${varName}}}`;
      delete clean.secretVar;
    }
    this.steps.push(clean);
  }

  stop() {
    if (!this.active) throw new Error('no workflow recording in progress');
    const wf = {
      version: 1,
      name: this.name,
      description: this.description,
      createdAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      startUrl: this.startUrl || (this.steps.find((s) => s.op === 'open')?.url || ''),
      variables: extractTemplateVariables(this.steps),
      steps: [...this.steps],
    };
    this.active = false;
    this.steps = [];
    return wf;
  }

  status() {
    return {
      recording: this.active,
      ...(this.active ? {
        name: this.name,
        description: this.description,
        startedAt: this.startedAt,
        stepCount: this.steps.length,
      } : {}),
    };
  }
}

export class WorkflowStore {
  constructor(opts = {}) {
    const dir = typeof opts === 'string' ? opts : (opts?.workflowDir || opts?.dir || '');
    this.workflowDir = dir;
    this.memory = new Map();
  }

  normalize(wf) {
    if (!wf || typeof wf !== 'object' || Array.isArray(wf)) {
      throw new Error('workflow object required');
    }
    const name = validateWorkflowName(wf.name);
    if (!Array.isArray(wf.steps) || wf.steps.length === 0 || wf.steps.length > MAX_WORKFLOW_STEPS) {
      throw new Error(`workflow.steps must contain 1..${MAX_WORKFLOW_STEPS} steps`);
    }
    const steps = wf.steps.map((s, idx) => {
      if (!s || typeof s !== 'object' || typeof s.op !== 'string') {
        throw new Error(`invalid workflow step at index ${idx}`);
      }
      if (!ALLOWED_BATCH_OPS.has(s.op)) {
        throw new Error(`unsupported workflow step op "${s.op}" at index ${idx}`);
      }
      return { ...s };
    });
    return {
      version: 1,
      name,
      description: String(wf.description || '').slice(0, 400),
      createdAt: wf.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startUrl: String(wf.startUrl || steps.find((s) => s.op === 'open')?.url || ''),
      variables: extractTemplateVariables(steps),
      steps,
    };
  }

  async _filePath(name) {
    if (!this.workflowDir) return null;
    await fs.mkdir(this.workflowDir, { recursive: true });
    const rootReal = await fs.realpath(this.workflowDir);
    const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
    const target = path.resolve(rootReal, `${validateWorkflowName(name)}.workflow.json`);
    if (!target.startsWith(prefix)) throw new Error('workflow path escapes AGENT_BROWSER_WORKFLOW_DIR');
    return target;
  }

  async save(wf) {
    const clean = this.normalize(wf);
    if (this.memory.size >= MAX_MEMORY_WORKFLOWS && !this.memory.has(clean.name)) {
      const oldest = this.memory.keys().next().value;
      this.memory.delete(oldest);
    }
    this.memory.set(clean.name, clean);
    let savedPath = null;
    const fp = await this._filePath(clean.name);
    if (fp) {
      await fs.writeFile(fp, JSON.stringify(clean, null, 2), 'utf8');
      savedPath = fp;
    }
    return { workflow: clean, savedPath };
  }

  async get(name) {
    const valid = validateWorkflowName(name);
    if (this.memory.has(valid)) return this.memory.get(valid);
    const fp = await this._filePath(valid);
    if (fp) {
      try {
        const raw = JSON.parse(await fs.readFile(fp, 'utf8'));
        const clean = this.normalize(raw);
        this.memory.set(valid, clean);
        return clean;
      } catch {}
    }
    return null;
  }

  async list() {
    const items = new Map();
    for (const [k, wf] of this.memory.entries()) {
      items.set(k, {
        name: wf.name,
        description: wf.description,
        startUrl: wf.startUrl,
        stepCount: wf.steps.length,
        variables: wf.variables,
        updatedAt: wf.updatedAt || wf.createdAt,
      });
    }
    if (this.workflowDir) {
      try {
        const files = await fs.readdir(this.workflowDir);
        for (const f of files) {
          if (!f.endsWith('.workflow.json')) continue;
          const base = f.slice(0, -'.workflow.json'.length);
          if (items.has(base) || !WORKFLOW_NAME_RE.test(base)) continue;
          const wf = await this.get(base);
          if (wf) {
            items.set(wf.name, {
              name: wf.name,
              description: wf.description,
              startUrl: wf.startUrl,
              stepCount: wf.steps.length,
              variables: wf.variables,
              updatedAt: wf.updatedAt || wf.createdAt,
            });
          }
        }
      } catch {}
    }
    return [...items.values()];
  }

  async delete(name) {
    const valid = validateWorkflowName(name);
    let removed = this.memory.delete(valid);
    const fp = await this._filePath(valid);
    if (fp) {
      try {
        await fs.unlink(fp);
        removed = true;
      } catch {}
    }
    return removed;
  }
}

// ---------- Replay Engine (0 LLM tokens, preserves policy + approvals) ----------
export async function replayWorkflow(session, workflow, { vars = {}, stopOnError = true, gen } = {}) {
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  if (!steps.length) throw new Error('workflow has no steps to replay');

  const results = [];
  let stoppedEarly = false;
  let stopReason = null;

  // Suspend active recording while replaying so replay doesn't recursively record itself.
  const prevRecording = session.recorder.active;
  session.recorder.active = false;

  try {
    for (let i = 0; i < steps.length; i++) {
      const raw = steps[i];
      const step = { ...raw };
      try {
        if (step.url !== undefined) step.url = interpolateTemplate(step.url, vars);
        if (step.text !== undefined) step.text = interpolateTemplate(step.text, vars);
        if (step.value !== undefined) step.value = interpolateTemplate(step.value, vars);
        if (step.key !== undefined) step.key = interpolateTemplate(step.key, vars);
        if (step.selector !== undefined) step.selector = interpolateTemplate(step.selector, vars);

        const page = session.activePage();
        if (step.target && (!step.ref || !session.controls?.has?.(step.ref))) {
          const ref = await resolveSemanticRef(session, page, step.target);
          if (!ref) {
            throw new Error(`could not locate element (${step.target.role || 'el'} "${step.target.name || step.target.css || ''}")`);
          }
          step.ref = ref;
        }
        const dropMeta = step.toTarget || step.targetTo;
        if (dropMeta && (!step.targetRef || !session.controls?.has?.(step.targetRef))) {
          const toRef = await resolveSemanticRef(session, page, dropMeta);
          if (!toRef) {
            throw new Error(`could not locate drop target ("${dropMeta.name || dropMeta.css || ''}")`);
          }
          step.targetRef = toRef;
        }

        const action = normalizeStepAction(step);
        action._skipRecord = true;
        action.compact = true;
        const out = await session.actNow(action, gen);
        if (out?.blocked || out?.error) throw new Error(out.reason || out.error);
        results.push({
          step: i + 1,
          op: step.op,
          ok: true,
          ...(out.data ? { data: out.data } : {}),
          ...(out.article ? { article: { title: out.article.title, length: out.article.length } } : {}),
        });
      } catch (err) {
        const msg = String(err?.message || err).slice(0, 220);
        results.push({ step: i + 1, op: step.op, ok: false, error: msg });
        if (stopOnError) {
          stoppedEarly = true;
          stopReason = `step ${i + 1} (${step.op}) failed: ${msg}`;
          break;
        }
      }
    }
  } finally {
    session.recorder.active = prevRecording;
  }

  return {
    workflow: workflow.name,
    ok: results.every((r) => r.ok),
    completed: results.filter((r) => r.ok).length,
    total: steps.length,
    stoppedEarly,
    ...(stopReason ? { stopReason } : {}),
    results,
  };
}

// ---------- Batch Action Executor (single LLM round-trip) ----------
export function normalizeStepAction(step) {
  const op = String(step?.op || '').trim();
  if (!ALLOWED_BATCH_OPS.has(op)) {
    throw new Error(`action "${op}" is not allowed inside batch/workflow`);
  }
  const a = { ...step };
  delete a.target;
  delete a.toTarget;
  delete a.targetTo;
  if (op === 'navigate') {
    const dir = String(step.action || step.direction || 'reload');
    if (!['back', 'forward', 'reload'].includes(dir)) throw new Error(`invalid navigate action: ${dir}`);
    a.op = dir;
  } else if (op === 'dblclick') {
    a.op = 'click';
    a.doubleClick = true;
  } else if (op === 'rightclick') {
    a.op = 'click';
    a.button = 'right';
  } else if (op === 'wait_for') {
    a.op = 'wait';
  }
  return a;
}

export async function executeBatch(session, steps, { stopOnError = true, stopOnNavigation = false, gen } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('steps must be a non-empty array of actions');
  }
  if (steps.length > MAX_BATCH_STEPS) {
    throw new Error(`batch accepts at most ${MAX_BATCH_STEPS} steps`);
  }

  // Pre-capture semantic anchors for any refs taken from the pre-batch snapshot so subsequent steps
  // in the same batch seamlessly follow their target control across intermediate snapshot refreshes!
  const initPage = session.activePage();
  const initUrl = initPage?.url?.() || '';
  const initBoxes = new Map((session.snapshot?.boxes || []).map((b) => [b.ref, b]));
  const preTargets = await Promise.all(steps.map(async (s) => {
    const t = s?.ref && initBoxes.has(s.ref) ? await captureSemanticTarget(initPage, initBoxes.get(s.ref)) : null;
    const t2 = s?.targetRef && initBoxes.has(s.targetRef) ? await captureSemanticTarget(initPage, initBoxes.get(s.targetRef)) : null;
    return { target: t, toTarget: t2 };
  }));

  const results = [];
  let stoppedEarly = false;
  let stopReason = null;

  for (let i = 0; i < steps.length; i++) {
    const raw = steps[i];
    const page = session.activePage();
    const beforeUrl = page?.url?.() || '';
    try {
      const action = normalizeStepAction(raw);
      const anchor = preTargets[i];
      if (action.ref && !session.controls?.has?.(action.ref) && anchor?.target && beforeUrl === initUrl) {
        const rebound = await resolveSemanticRef(session, page, anchor.target);
        if (rebound) action.ref = rebound;
      }
      if (action.targetRef && !session.controls?.has?.(action.targetRef) && anchor?.toTarget && beforeUrl === initUrl) {
        const reboundTo = await resolveSemanticRef(session, page, anchor.toTarget);
        if (reboundTo) action.targetRef = reboundTo;
      }
      action.compact = true;
      const out = await session.actNow(action, gen);
      if (out?.blocked || out?.error) throw new Error(out.reason || out.error);

      const afterUrl = session.activePage()?.url?.() || '';
      const entry = {
        step: i + 1,
        op: raw.op,
        ok: true,
        ...(beforeUrl !== afterUrl ? { navigatedTo: afterUrl } : {}),
        ...(out.data ? { data: out.data } : {}),
        ...(out.article ? { article: out.article } : {}),
        ...(out.shot ? { shot: { mimeType: out.shot.mimeType, annotated: Boolean(out.shot.annotated) } } : {}),
      };
      results.push(entry);

      if (stopOnNavigation && raw.op !== 'open' && beforeUrl && afterUrl && beforeUrl !== afterUrl && i < steps.length - 1) {
        stoppedEarly = true;
        stopReason = `navigation detected after step ${i + 1} (${afterUrl})`;
        break;
      }
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 220);
      results.push({ step: i + 1, op: raw?.op || 'unknown', ok: false, error: msg });
      if (stopOnError) {
        stoppedEarly = true;
        stopReason = `step ${i + 1} (${raw?.op || 'unknown'}) failed: ${msg}`;
        break;
      }
    }
  }

  return {
    ok: results.every((r) => r.ok),
    completed: results.filter((r) => r.ok).length,
    total: steps.length,
    stoppedEarly,
    ...(stopReason ? { stopReason } : {}),
    results,
  };
}

// ---------- Playwright *.spec.mjs Code Generator ----------
function jsExprForString(value) {
  const s = String(value ?? '');
  const vars = [...s.matchAll(TEMPLATE_VAR_RE)];
  if (!vars.length) return JSON.stringify(s);
  if (vars.length === 1 && vars[0][0] === s) {
    const envName = vars[0][1].toUpperCase();
    return `process.env.${envName} ?? ''`;
  }
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(TEMPLATE_VAR_RE, (_, name) => `\${process.env.${name.toUpperCase()} ?? ''}`);
  return '`' + escaped + '`';
}

function locatorCode(target) {
  if (!target || typeof target !== 'object') return "page.locator('body')";
  if (target.testId) return `page.getByTestId(${JSON.stringify(target.testId)})`;
  const playwrightRoles = new Set([
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio',
    'combobox', 'menuitem', 'tab', 'switch', 'option', 'slider', 'heading',
  ]);
  if (target.role && playwrightRoles.has(target.role) && target.name) {
    return `page.getByRole(${JSON.stringify(target.role)}, { name: ${JSON.stringify(target.name)} })`;
  }
  if (target.label) return `page.getByLabel(${JSON.stringify(target.label)})`;
  if (target.placeholder) return `page.getByPlaceholder(${JSON.stringify(target.placeholder)})`;
  if (target.css) return `page.locator(${JSON.stringify(target.css)})`;
  if (target.name) return `page.getByText(${JSON.stringify(target.name)})`;
  return "page.locator('body')";
}

export function exportPlaywrightSpec(workflow, { testName } = {}) {
  if (!workflow || !Array.isArray(workflow.steps)) {
    throw new Error('valid workflow with steps required');
  }
  const title = String(testName || workflow.description || workflow.name || 'recorded workflow').slice(0, 140);
  const lines = [
    `// Generated by AgentBrowser from workflow "${workflow.name}"`,
    "import { test, expect } from '@playwright/test';",
    '',
  ];

  if (workflow.variables?.length) {
    lines.push(`// Template variables (pass via env): ${workflow.variables.map((v) => v.toUpperCase()).join(', ')}`);
  }
  lines.push(`test(${JSON.stringify(title)}, async ({ page }) => {`);

  for (const step of workflow.steps) {
    const loc = locatorCode(step.target);
    switch (step.op) {
      case 'open':
        lines.push(`  await page.goto(${jsExprForString(step.url)});`);
        break;
      case 'click':
        if (step.doubleClick) lines.push(`  await ${loc}.dblclick();`);
        else if (step.button && step.button !== 'left') lines.push(`  await ${loc}.click({ button: ${JSON.stringify(step.button)} });`);
        else lines.push(`  await ${loc}.click();`);
        break;
      case 'dblclick':
        lines.push(`  await ${loc}.dblclick();`);
        break;
      case 'rightclick':
        lines.push(`  await ${loc}.click({ button: 'right' });`);
        break;
      case 'drag':
        if (step.toTarget) {
          lines.push(`  await ${loc}.dragTo(${locatorCode(step.toTarget)});`);
        } else if (Number.isFinite(step.dx) || Number.isFinite(step.dy)) {
          lines.push(`  { const b = await ${loc}.boundingBox(); if (b) { await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await page.mouse.move(b.x + b.width / 2 + ${Number(step.dx || 0)}, b.y + b.height / 2 + ${Number(step.dy || 0)}, { steps: 10 }); await page.mouse.up(); } }`);
        }
        break;
      case 'type':
        lines.push(`  await ${loc}.fill(${jsExprForString(step.text)});`);
        if (step.submit) lines.push(`  await ${loc}.press('Enter');`);
        break;
      case 'select':
        lines.push(`  await ${loc}.selectOption(${jsExprForString(step.value)});`);
        break;
      case 'press':
        if (Array.isArray(step.keys)) {
          for (const k of step.keys) lines.push(`  await page.keyboard.press(${jsExprForString(k)});`);
        } else {
          lines.push(`  await page.keyboard.press(${jsExprForString(step.key)});`);
        }
        break;
      case 'hover':
        lines.push(`  await ${loc}.hover();`);
        break;
      case 'scroll': {
        const dy = Number(step.amount || 520) * (step.direction === 'up' ? -1 : 1);
        lines.push(`  await page.mouse.wheel(0, ${dy});`);
        break;
      }
      case 'wait':
      case 'wait_for':
        if (step.selector) lines.push(`  await page.locator(${jsExprForString(step.selector)}).first().waitFor({ state: 'visible' });`);
        else if (step.text) lines.push(`  await expect(page.getByText(${jsExprForString(step.text)}).first()).toBeVisible();`);
        else if (step.url) lines.push(`  await page.waitForURL(${JSON.stringify(`*${step.url}*`)});`);
        else lines.push(`  await page.waitForTimeout(${Math.max(0, Number(step.ms || 500))});`);
        break;
      case 'back':
        lines.push('  await page.goBack();');
        break;
      case 'forward':
        lines.push('  await page.goForward();');
        break;
      case 'reload':
        lines.push('  await page.reload();');
        break;
      case 'screenshot':
        lines.push(`  await page.screenshot({ fullPage: ${Boolean(step.fullPage)} });`);
        break;
      default:
        lines.push(`  // step: ${step.op}`);
        break;
    }
  }

  lines.push('  await expect(page).toHaveURL(/.+/);');
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}
