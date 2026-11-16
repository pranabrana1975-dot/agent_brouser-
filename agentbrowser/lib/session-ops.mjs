// session-ops.mjs — Modular handler for F12 DevTools, Batch, Workflows, Advanced UI
// (drag & clipboard), PDF/Download inspection, Visual Regression, and Human Takeover.

import { NETWORK_PRESETS } from './devtools.mjs';
import {
  DEVICE_PRESETS,
  readToasts,
  inspectElement,
  captureA11yTree,
  diffSnapshots,
  collectPerformance,
  inspectStorage,
  clearStorage,
  inspectSecurity,
  runPageAudit,
  evaluateExpression,
} from './inspector.mjs';
import {
  MAX_BASELINES_PER_SESSION,
  readPngDimensions,
  comparePngBuffers,
  generatePagePdf,
  inspectDownloadArtifact,
} from './visual.mjs';
import {
  validateWorkflowName,
  captureSemanticTarget,
  executeBatch,
  replayWorkflow,
  exportPlaywrightSpec,
} from './workflow.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAFE_KEY_CHORD_RE = /^(?:(?:Control|Shift|Alt|Meta|ControlOrMeta)\+)*[a-zA-Z0-9_.:-]{1,32}$/;

export function parseViewportSpec(input) {
  if (input && typeof input === 'object') {
    const width = Math.min(3840, Math.max(320, Math.trunc(Number(input.width) || 1280)));
    const height = Math.min(2160, Math.max(240, Math.trunc(Number(input.height) || 800)));
    return { width, height };
  }
  if (typeof input === 'string') {
    const m = input.trim().match(/^(\d{3,4})\s*[xX×,]\s*(\d{3,4})$/);
    if (m) {
      return {
        width: Math.min(3840, Math.max(320, Number(m[1]))),
        height: Math.min(2160, Math.max(240, Number(m[2]))),
      };
    }
  }
  return { width: 1280, height: 800 };
}

export function isValidKeyChord(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 80 && SAFE_KEY_CHORD_RE.test(key);
}

// Execute extended / DevTools / v2 operations. Returns null if op is not handled here.
export async function executeExtendedOp(session, tab, page, a, { wireOpts, gen }) {
  switch (a.op) {
    // ---------------- Advanced UI: Drag & Drop + Clipboard ----------------
    case 'drag': {
      const srcBox = session._findBox(a.ref || a.sourceRef);
      if (!srcBox) return { blocked: true, reason: `unknown source ref ${a.ref || a.sourceRef} — take a snapshot first` };
      if (srcBox.disabled) return { blocked: true, reason: `element ${srcBox.ref} is disabled` };

      const dstBox = a.targetRef ? session._findBox(a.targetRef) : null;
      if (a.targetRef && !dstBox) {
        return { blocked: true, reason: `unknown target ref ${a.targetRef} — take a snapshot first` };
      }

      const hasCoords = Number.isFinite(a.targetX) && Number.isFinite(a.targetY);
      const hasOffset = Number.isFinite(a.dx) || Number.isFinite(a.dy);
      if (!dstBox && !hasCoords && !hasOffset) {
        return { error: 'drag requires targetRef, (targetX, targetY), or (dx, dy)' };
      }

      const steps = Math.min(40, Math.max(2, Math.trunc(Number(a.steps) || 10)));
      const srcLoc = session._locatorFor(page, srcBox);

      if (session.recorder.active && !a._skipRecord) {
        const target = await captureSemanticTarget(page, srcBox);
        const toTarget = dstBox ? await captureSemanticTarget(page, dstBox) : null;
        session.recorder.record({
          op: 'drag',
          target,
          ...(toTarget ? { toTarget } : {}),
          ...(hasOffset ? { dx: Number(a.dx || 0), dy: Number(a.dy || 0) } : {}),
          ...(hasCoords ? { targetX: Number(a.targetX), targetY: Number(a.targetY) } : {}),
        });
      }

      try {
        await srcLoc.scrollIntoViewIfNeeded?.({ timeout: 3000 }).catch(() => {});
        if (dstBox) {
          const dstLoc = session._locatorFor(page, dstBox);
          await dstLoc.scrollIntoViewIfNeeded?.({ timeout: 3000 }).catch(() => {});
          session.addLog('act', `drag ${srcBox.ref} "${srcBox.name}" → ${dstBox.ref} "${dstBox.name}"`);
          if (typeof srcLoc.dragTo === 'function') {
            await srcLoc.dragTo(dstLoc, { timeout: 7000 });
          } else {
            const x1 = srcBox.x + srcBox.w / 2;
            const y1 = srcBox.y + srcBox.h / 2;
            const x2 = dstBox.x + dstBox.w / 2;
            const y2 = dstBox.y + dstBox.h / 2;
            await smoothMouseDrag(page, x1, y1, x2, y2, steps);
          }
        } else {
          const bb = (await srcLoc.boundingBox?.().catch(() => null))
            || { x: srcBox.x, y: srcBox.y, width: srcBox.w, height: srcBox.h };
          const x1 = Math.round(bb.x + bb.width / 2);
          const y1 = Math.round(bb.y + bb.height / 2);
          const x2 = hasCoords
            ? Math.round(Number(a.targetX))
            : Math.round(x1 + Number(a.dx || 0));
          const y2 = hasCoords
            ? Math.round(Number(a.targetY))
            : Math.round(y1 + Number(a.dy || 0));
          session.addLog('act', `drag ${srcBox.ref} "${srcBox.name}" (${x1},${y1}) → (${x2},${y2})`);
          await smoothMouseDrag(page, x1, y1, x2, y2, steps);
        }
        await sleep(200);
        const snap = await session.snap();
        return { ok: true, snapshot: session.formatWireSnapshot(snap, wireOpts) };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
      }
    }

    case 'clipboard': {
      const sub = String(a.sub || a.mode || (a.text !== undefined ? 'write' : 'read')).toLowerCase();
      try {
        if (sub === 'write') {
          const text = String(a.text ?? '');
          if (text.length > 100_000) return { error: 'clipboard text exceeds 100,000 characters' };
          session._clipboardText = text;
          await session.ctx.grantPermissions?.(['clipboard-read', 'clipboard-write']).catch(() => {});
          await page.evaluate(async (val) => {
            try { await navigator.clipboard?.writeText?.(val); } catch {}
          }, text).catch(() => {});
          session.addLog('act', `clipboard write (${text.length} chars)`);
          return { ok: true, data: { written: true, length: text.length } };
        }
        if (sub === 'clear') {
          session._clipboardText = '';
          await session.ctx.grantPermissions?.(['clipboard-write']).catch(() => {});
          await page.evaluate(async () => {
            try { await navigator.clipboard?.writeText?.(''); } catch {}
          }).catch(() => {});
          session.addLog('act', 'clipboard cleared');
          return { ok: true, data: { cleared: true } };
        }
        if (sub === 'read') {
          if (session.policy.approvalsEnabled) {
            const decision = await session.requestApproval({
              reason: 'read clipboard contents',
              detail: 'clipboard read requested by agent',
              rule: 'clipboard',
            });
            if (!decision.allow) return { blocked: true, reason: decision.reason };
          }
          await session.ctx.grantPermissions?.(['clipboard-read', 'clipboard-write']).catch(() => {});
          const nativeText = await page.evaluate(async () => {
            try {
              if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
            } catch {}
            return null;
          }).catch(() => null);
          const text = typeof nativeText === 'string' ? nativeText : (session._clipboardText || '');
          session.addLog('act', `clipboard read (${text.length} chars)`);
          return { ok: true, data: { text: text.slice(0, 50_000), length: text.length } };
        }
        return { error: `unknown clipboard operation: ${sub} (use write, read, or clear)` };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
      }
    }

    // ---------------- Batch Actions & Workflow Record/Replay/Codegen ----------------
    case 'batch': {
      session.metrics?.recordBatch?.();
      session.addLog('act', `batch start (${Array.isArray(a.steps) ? a.steps.length : 0} steps)`);
      try {
        const batchOut = await executeBatch(session, a.steps, {
          stopOnError: a.stopOnError !== false,
          stopOnNavigation: Boolean(a.stopOnNavigation),
          gen,
        });
        const snap = session.snapshot || (await session.snap());
        session.addLog('act', `batch finished · ${batchOut.completed}/${batchOut.total} ok`);
        return {
          ok: true,
          data: {
            ...batchOut,
            snapshot: session.formatWireSnapshot(snap, wireOpts),
          },
        };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
      }
    }

    case 'workflow': {
      const sub = String(a.sub || a.mode || 'list').toLowerCase();
      try {
        if (sub === 'status') {
          return { ok: true, data: session.recorder.status() };
        }
        if (sub === 'record_start' || sub === 'start') {
          const st = session.recorder.start({
            name: a.name,
            description: a.description,
            startUrl: page.url?.() || '',
          });
          session.addLog('act', `workflow recording started · "${st.name}"`);
          session.emit('state', { state: session.state() });
          return { ok: true, data: st };
        }
        if (sub === 'record_stop' || sub === 'stop') {
          const wf = session.recorder.stop();
          let savedPath = null;
          if (a.save !== false && wf.steps.length > 0) {
            const saved = await session.workflowStore.save(wf);
            savedPath = saved.savedPath;
          }
          session.addLog('act', `workflow recording stopped · "${wf.name}" (${wf.steps.length} steps)`);
          session.emit('state', { state: session.state() });
          return { ok: true, data: { workflow: wf, savedPath } };
        }
        if (sub === 'list') {
          const workflows = await session.workflowStore.list();
          return { ok: true, data: { recording: session.recorder.status(), workflows } };
        }
        if (sub === 'get') {
          if (!a.name) return { error: 'workflow name required' };
          const wf = await session.workflowStore.get(a.name);
          if (!wf) return { error: `unknown workflow: ${a.name}` };
          return { ok: true, data: { workflow: wf } };
        }
        if (sub === 'save') {
          const payload = a.workflow || { name: a.name, description: a.description, steps: a.steps };
          const saved = await session.workflowStore.save(payload);
          session.addLog('act', `workflow saved · "${saved.workflow.name}" (${saved.workflow.steps.length} steps)`);
          return { ok: true, data: saved };
        }
        if (sub === 'delete') {
          if (!a.name) return { error: 'workflow name required' };
          const deleted = await session.workflowStore.delete(a.name);
          if (deleted) session.addLog('act', `workflow deleted · "${a.name}"`);
          return { ok: true, data: { deleted, name: a.name } };
        }
        if (sub === 'replay' || sub === 'run') {
          const wf = a.workflow
            ? session.workflowStore.normalize(a.workflow)
            : await session.workflowStore.get(a.name);
          if (!wf) return { error: `unknown workflow: ${a.name}` };
          session.metrics?.recordWorkflowReplay?.();
          session.addLog('act', `workflow replay · "${wf.name}" (${wf.steps.length} steps)`);
          const rep = await replayWorkflow(session, wf, {
            vars: a.vars || {},
            stopOnError: a.stopOnError !== false,
            gen,
          });
          const snap = session.snapshot || (await session.snap());
          return {
            ok: true,
            data: {
              ...rep,
              snapshot: session.formatWireSnapshot(snap, wireOpts),
            },
          };
        }
        if (sub === 'export' || sub === 'codegen') {
          const wf = a.workflow
            ? session.workflowStore.normalize(a.workflow)
            : await session.workflowStore.get(a.name);
          if (!wf) return { error: `unknown workflow: ${a.name}` };
          const code = exportPlaywrightSpec(wf, { testName: a.testName });
          return {
            ok: true,
            data: {
              name: wf.name,
              filename: `${validateWorkflowName(wf.name)}.spec.mjs`,
              format: 'playwright-test',
              variables: wf.variables,
              code,
            },
          };
        }
        return { error: `unknown workflow operation: ${sub}` };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 200) };
      }
    }

    // ---------------- PDF & Download Artifact Inspector ----------------
    case 'pdf': {
      session.addLog('act', `pdf (${a.format || 'A4'}${a.landscape ? ', landscape' : ''})`);
      try {
        const data = await generatePagePdf(page, {
          format: a.format,
          landscape: a.landscape,
          printBackground: a.printBackground,
          scale: a.scale,
          margin: a.margin,
          pageRanges: a.pageRanges,
          save: Boolean(a.save),
          filename: a.filename,
          downloadDir: session.downloadDir,
          includeBase64: a.includeBase64 !== false,
        });
        if (data.savedPath) {
          const dl = session.registerArtifact({
            filename: data.savedPath.split(/[\\/]/).pop(),
            path: data.savedPath,
            url: data.url,
            kind: 'pdf',
            bytes: data.bytes,
            sha256: data.sha256,
          });
          data.downloadId = dl.id;
        }
        return { ok: true, data };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
      }
    }

    case 'downloads': {
      const sub = String(a.sub || a.mode || (a.id ? 'inspect' : 'list')).toLowerCase();
      try {
        if (sub === 'list') {
          return { ok: true, data: { downloads: [...session.downloads] } };
        }
        if (sub === 'inspect') {
          const rec = a.id
            ? session.downloads.find((d) => d.id === a.id || d.filename === a.id)
            : session.downloads[session.downloads.length - 1];
          if (!rec) return { error: a.id ? `unknown download: ${a.id}` : 'no downloads in session' };
          const data = await inspectDownloadArtifact(rec, {
            downloadDir: session.downloadDir,
            maxChars: a.maxChars,
            maxRows: a.maxRows,
          });
          return { ok: true, data };
        }
        return { error: `unknown downloads operation: ${sub}` };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
      }
    }

    // ---------------- Visual Regression Diff ----------------
    case 'visual_diff': {
      const sub = String(a.sub || a.mode || 'compare').toLowerCase();
      const name = validateWorkflowName(a.name || 'default');
      try {
        if (sub === 'list') {
          const baselines = [...session.visualBaselines.entries()].map(([k, v]) => ({
            name: k,
            url: v.url,
            width: v.width,
            height: v.height,
            bytes: v.buf.length,
            capturedAt: v.capturedAt,
          }));
          return { ok: true, data: { baselines } };
        }
        if (sub === 'delete') {
          const deleted = session.visualBaselines.delete(name);
          return { ok: true, data: { deleted, name } };
        }

        const captureTargetPng = async () => {
          if (a.selector && typeof page.locator === 'function') {
            const raw = await page.locator(String(a.selector).slice(0, 300)).first().screenshot({ type: 'png', timeout: 10000 });
            return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          }
          const raw = await page.screenshot({ type: 'png', fullPage: Boolean(a.fullPage), timeout: 10000 });
          return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        };

        if (sub === 'baseline' || sub === 'capture') {
          const buf = a.baselineBase64
            ? Buffer.from(String(a.baselineBase64), 'base64')
            : await captureTargetPng();
          const dims = readPngDimensions(buf);
          if (!dims) return { error: 'captured image is not a valid PNG' };
          if (session.visualBaselines.size >= MAX_BASELINES_PER_SESSION && !session.visualBaselines.has(name)) {
            const oldest = session.visualBaselines.keys().next().value;
            session.visualBaselines.delete(oldest);
          }
          const entry = {
            buf,
            url: page.url?.() || '',
            width: dims.width,
            height: dims.height,
            capturedAt: new Date().toISOString(),
          };
          session.visualBaselines.set(name, entry);
          session.addLog('devtools', `visual baseline "${name}" saved (${dims.width}×${dims.height})`);
          return {
            ok: true,
            data: {
              name,
              url: entry.url,
              width: entry.width,
              height: entry.height,
              bytes: buf.length,
              capturedAt: entry.capturedAt,
            },
          };
        }

        if (sub === 'compare') {
          let baseBuf = null;
          let baselineUrl = '';
          if (a.baselineBase64) {
            baseBuf = Buffer.from(String(a.baselineBase64), 'base64');
          } else {
            const stored = session.visualBaselines.get(name);
            if (!stored) {
              return { error: `no visual baseline named "${name}" — call visual_diff with op="baseline" first` };
            }
            baseBuf = stored.buf;
            baselineUrl = stored.url;
          }
          const curBuf = a.currentBase64
            ? Buffer.from(String(a.currentBase64), 'base64')
            : await captureTargetPng();

          const report = comparePngBuffers(baseBuf, curBuf, {
            threshold: a.threshold,
            maxDiffPercent: a.maxDiffPercent,
            includeDiffImage: a.includeDiffImage !== false,
          });

          if (a.updateBaseline) {
            const dims = readPngDimensions(curBuf) || { width: report.currentSize.width, height: report.currentSize.height };
            session.visualBaselines.set(name, {
              buf: curBuf,
              url: page.url?.() || '',
              width: dims.width,
              height: dims.height,
              capturedAt: new Date().toISOString(),
            });
          }

          session.addLog('devtools', `visual diff "${name}" · ${report.diffPercent}% changed (${report.passed ? 'PASS' : 'FAIL'})`);
          return {
            ok: true,
            data: {
              name,
              baselineUrl,
              currentUrl: page.url?.() || '',
              ...report,
            },
          };
        }

        return { error: `unknown visual_diff operation: ${sub} (use baseline, compare, list, or delete)` };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 200) };
      }
    }

    // ---------------- F12 Agent DevTools ----------------
    case 'network': {
      const dt = tab.devtools;
      const sub = String(a.sub || a.mode || 'list').toLowerCase();
      try {
        if (sub === 'list') {
          const sinceActionSeq = a.sinceLastAction ? session.lastMutatingActionSeq : null;
          return {
            ok: true,
            data: dt.listNetwork({
              resourceType: a.resourceType,
              status: a.status,
              url: a.url,
              sinceActionSeq,
              limit: a.limit,
            }),
          };
        }
        if (sub === 'get') {
          if (!a.id) return { error: 'request id required (e.g. r1)' };
          const entry = dt.getNetworkEntry(a.id, { maxChars: a.maxChars });
          if (!entry) return { error: `unknown request id: ${a.id}` };
          return { ok: true, data: entry };
        }
        if (sub === 'websockets') {
          return { ok: true, data: dt.listWebSockets({ wsId: a.wsId, limit: a.limit }) };
        }
        if (sub === 'har') {
          return { ok: true, data: dt.exportHar({ includeBodies: Boolean(a.includeBodies) }) };
        }
        if (sub === 'clear') {
          dt.clearNetwork();
          session.addLog('devtools', 'network log cleared');
          return { ok: true, data: { cleared: true } };
        }
        if (sub === 'throttle') {
          const presetName = a.preset ? String(a.preset).toLowerCase() : '';
          const profileInput = presetName
            ? presetName
            : {
                offline: Boolean(a.offline),
                latencyMs: a.latencyMs ?? 0,
                downloadKbps: a.downloadKbps ?? -1,
                uploadKbps: a.uploadKbps ?? -1,
              };
          if (presetName && !NETWORK_PRESETS[presetName]) {
            return { error: `unknown throttle preset: ${presetName}` };
          }
          const applied = await dt.applyNetworkThrottle(session.ctx, profileInput);
          session.netControls.networkProfile = { ...applied, preset: presetName || 'custom' };
          session.netControls.emulation.offline = applied.offline;
          session.addLog('devtools', `network throttle → ${presetName || JSON.stringify(applied)}`);
          return { ok: true, data: session.netControls.networkProfile };
        }
        if (sub === 'block') {
          const updated = session.netControls.setBlocked({ patterns: a.patterns, blockTrackers: a.blockTrackers });
          session.addLog('devtools', `network block updated · trackers=${updated.blockTrackers} · patterns=${updated.blockedPatterns.length}`);
          return { ok: true, data: updated };
        }
        if (sub === 'mock') {
          const added = session.netControls.addMock({
            urlPattern: a.urlPattern,
            method: a.method,
            status: a.status,
            contentType: a.contentType,
            body: a.body,
            headers: a.headers,
          });
          session.addLog('devtools', `network mock added · ${added.method} ${added.urlPattern} → ${added.status}`);
          return { ok: true, data: added };
        }
        if (sub === 'unmock') {
          const cleared = session.netControls.clearMocks(a.id);
          session.addLog('devtools', `network mocks cleared · removed=${cleared.removed}`);
          return { ok: true, data: cleared };
        }
        return { error: `unknown network operation: ${sub}` };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
      }
    }

    case 'console': {
      const dt = tab.devtools;
      const sub = String(a.sub || a.mode || 'list').toLowerCase();
      if (sub === 'clear') {
        dt.clearConsole();
        session.addLog('devtools', 'console log cleared');
        return { ok: true, data: { cleared: true } };
      }
      if (sub !== 'list') return { error: `unknown console operation: ${sub}` };
      const sinceActionSeq = a.sinceLastAction ? session.lastMutatingActionSeq : null;
      return {
        ok: true,
        data: dt.listConsole({
          level: a.level,
          search: a.search,
          sinceActionSeq,
          limit: a.limit,
        }),
      };
    }

    case 'evaluate': {
      if (!session.allowEval) {
        return {
          blocked: true,
          reason: 'browser_evaluate is disabled by default (set AGENT_BROWSER_ALLOW_EVAL=1 for trusted debugging)',
        };
      }
      const expression = String(a.expression || '').trim();
      if (!expression) return { error: 'expression required' };
      if (session.policy.approvalsEnabled) {
        const decision = await session.requestApproval({
          reason: 'page JavaScript execution',
          detail: `evaluate JS: ${expression.slice(0, 90)}`,
          rule: 'evaluate',
        });
        if (!decision.allow) return { blocked: true, reason: decision.reason };
      }
      session.addLog('devtools', `evaluate JS (${expression.length} chars)`);
      try {
        const data = await evaluateExpression(page, expression, { timeoutMs: a.timeoutMs });
        return { ok: true, data };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 200) };
      }
    }

    case 'inspect': {
      const ref = a.ref ? String(a.ref).trim() : '';
      const selector = a.selector ? String(a.selector).trim() : '';
      if (!ref && !selector) return { error: 'provide ref (e.g. e3) or CSS selector' };
      if (selector.length > 1000) return { error: 'selector too long' };
      let frame = '';
      if (ref) {
        const box = session._findBox(ref);
        if (!box) return { blocked: true, reason: `unknown ref ${ref} — take a snapshot first` };
        frame = box.frame || '';
      }
      session.addLog('devtools', `inspect ${ref || selector.slice(0, 60)}`);
      try {
        const data = await inspectElement(page, { ref, selector, frame });
        return { ok: true, data };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
      }
    }

    case 'a11y': {
      const ref = a.ref ? String(a.ref).trim() : '';
      const selector = a.selector ? String(a.selector).trim() : '';
      let locator = null;
      if (ref) {
        const box = session._findBox(ref);
        if (!box) return { blocked: true, reason: `unknown ref ${ref} — take a snapshot first` };
        locator = session._locatorFor(page, box);
      }
      session.addLog('devtools', `a11y tree ${ref || selector || 'document'}`);
      try {
        const data = await captureA11yTree(page, { locator, ref, selector, maxChars: a.maxChars });
        return { ok: true, data };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
      }
    }

    case 'diff': {
      const sub = String(a.sub || a.mode || 'diff').toLowerCase();
      if (sub === 'mark') {
        const snap = session.snapshot || (await session.snap());
        session.markedSnapshot = snap;
        await readToasts(page, { clear: true });
        session.addLog('devtools', 'diff checkpoint marked');
        return { ok: true, data: { marked: true, url: snap?.meta?.url || '', controls: snap?.boxes?.length || 0 } };
      }
      const before = a.sinceMark && session.markedSnapshot ? session.markedSnapshot : session.prevSnapshot;
      const fresh = a.refresh ? await session.snap() : (session.snapshot || (await session.snap()));
      const baseline = a.refresh && !a.sinceMark ? session.prevSnapshot : before;
      const rawToasts = await readToasts(page, { clear: Boolean(a.clearToasts) });
      const toasts = Array.isArray(rawToasts) ? rawToasts : [];
      return { ok: true, data: diffSnapshots(baseline, fresh, toasts) };
    }

    case 'perf': {
      session.addLog('devtools', 'collect performance metrics');
      try {
        const cdp = await tab.devtools.ensureCdp(session.ctx);
        const data = await collectPerformance(page, { cdp });
        return { ok: true, data };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
      }
    }

    case 'audit': {
      session.addLog('devtools', 'run page audit');
      try {
        const cdp = await tab.devtools.ensureCdp(session.ctx);
        const data = await runPageAudit(page, { tabDevtools: tab.devtools, cdp });
        return { ok: true, data };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
      }
    }

    case 'storage': {
      const sub = String(a.sub || a.mode || 'inspect').toLowerCase();
      try {
        if (sub === 'clear') {
          if (session.policy.approvalsEnabled) {
            const decision = await session.requestApproval({
              reason: 'clear browser storage/cookies',
              detail: `clear storage [${(a.targets || ['cookies', 'localStorage', 'sessionStorage']).join(', ')}]`,
              rule: 'destructive',
            });
            if (!decision.allow) return { blocked: true, reason: decision.reason };
          }
          const res = await clearStorage(page, session.ctx, a.targets);
          session.addLog('devtools', `storage cleared · [${res.cleared.join(', ')}]`);
          return { ok: true, data: res };
        }
        if (sub !== 'inspect') return { error: `unknown storage operation: ${sub}` };
        const includeValues = Boolean(a.includeValues && session.allowSensitiveStorage);
        const data = await inspectStorage(page, session.ctx, { includeValues });
        return { ok: true, data };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
      }
    }

    case 'security': {
      session.addLog('devtools', 'inspect page security & third-party requests');
      try {
        const data = await inspectSecurity(page, session.ctx, tab.devtools);
        return { ok: true, data };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
      }
    }

    case 'emulate': {
      try {
        const emu = session.netControls.emulation;
        let targetViewport = null;
        let targetUa = a.userAgent !== undefined ? String(a.userAgent) : null;
        let deviceScaleFactor = 1;
        let mobile = false;

        if (a.device) {
          const preset = DEVICE_PRESETS[String(a.device).toLowerCase()];
          if (!preset) return { error: `unknown device preset: ${a.device} (use ${Object.keys(DEVICE_PRESETS).join(', ')})` };
          emu.device = preset.name;
          targetViewport = { ...preset.viewport };
          deviceScaleFactor = preset.deviceScaleFactor;
          mobile = preset.mobile;
          if (targetUa === null && preset.userAgent) targetUa = preset.userAgent;
        }

        if (a.viewport && typeof a.viewport === 'object') {
          targetViewport = parseViewportSpec(a.viewport);
          if (!a.device) emu.device = 'custom';
        } else if (Number.isFinite(a.width) && Number.isFinite(a.height)) {
          targetViewport = parseViewportSpec({ width: a.width, height: a.height });
          if (!a.device) emu.device = 'custom';
        }

        if (targetViewport) {
          await page.setViewportSize?.(targetViewport);
          session.viewport = targetViewport;
          emu.viewport = targetViewport;
        }

        const cdp = await tab.devtools.ensureCdp(session.ctx);
        if (cdp && (a.device || targetUa !== null || a.timezoneId)) {
          if (a.device && targetViewport) {
            await cdp.send('Emulation.setDeviceMetricsOverride', {
              width: targetViewport.width,
              height: targetViewport.height,
              deviceScaleFactor,
              mobile,
            }).catch(() => {});
            await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile }).catch(() => {});
          }
          if (targetUa !== null && targetUa !== '') {
            await cdp.send('Emulation.setUserAgentOverride', { userAgent: targetUa }).catch(() => {});
          }
          if (a.timezoneId) {
            const tz = String(a.timezoneId).trim();
            if (!/^[A-Za-z0-9_/+.-]{2,64}$/.test(tz)) return { error: 'invalid timezoneId' };
            await cdp.send('Emulation.setTimezoneOverride', { timezoneId: tz });
            emu.timezoneId = tz;
          }
        }

        const mediaPatch = {};
        if (a.colorScheme) {
          if (!['light', 'dark', 'no-preference'].includes(a.colorScheme)) return { error: 'invalid colorScheme' };
          mediaPatch.colorScheme = a.colorScheme;
          emu.colorScheme = a.colorScheme;
        }
        if (a.reducedMotion) {
          if (!['reduce', 'no-preference'].includes(a.reducedMotion)) return { error: 'invalid reducedMotion' };
          mediaPatch.reducedMotion = a.reducedMotion;
          emu.reducedMotion = a.reducedMotion;
        }
        if (a.media) {
          if (!['screen', 'print'].includes(a.media)) return { error: 'invalid media type' };
          mediaPatch.media = a.media;
          emu.media = a.media;
        }
        if (Object.keys(mediaPatch).length) {
          await page.emulateMedia?.(mediaPatch);
        }

        if (typeof a.offline === 'boolean') {
          await session.ctx.setOffline?.(a.offline);
          emu.offline = a.offline;
          session.netControls.networkProfile.offline = a.offline;
        }

        if (a.geolocation && typeof a.geolocation === 'object') {
          const lat = Number(a.geolocation.latitude);
          const lng = Number(a.geolocation.longitude);
          const acc = a.geolocation.accuracy !== undefined ? Math.max(0, Number(a.geolocation.accuracy)) : 50;
          if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
            return { error: 'invalid geolocation coordinates' };
          }
          await session.ctx.grantPermissions?.(['geolocation']).catch(() => {});
          await session.ctx.setGeolocation?.({ latitude: lat, longitude: lng, accuracy: acc });
          emu.geolocation = { latitude: lat, longitude: lng, accuracy: acc };
        }

        session.addLog('devtools', `emulate updated · device=${emu.device || 'default'} · ${session.viewport.width}×${session.viewport.height} · ${emu.colorScheme}`);
        const snap = await session.snap();
        return { ok: true, data: { emulation: { ...emu, viewport: session.viewport }, snapshot: session.formatWireSnapshot(snap, wireOpts) } };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
      }
    }

    case 'dialog': {
      const dt = tab.devtools;
      const sub = String(a.sub || a.mode || 'list').toLowerCase();
      if (sub === 'list') {
        return {
          ok: true,
          data: {
            rule: { ...dt.dialogRule },
            pending: dt.pendingDialog ? dt.pendingDialog.record : null,
            dialogs: [...dt.dialogs],
          },
        };
      }
      if (sub === 'set') {
        const action = String(a.action || 'dismiss').toLowerCase();
        if (!['accept', 'dismiss', 'manual'].includes(action)) {
          return { error: 'dialog action must be accept, dismiss, or manual' };
        }
        dt.dialogRule = {
          mode: action,
          promptText: a.promptText !== undefined ? String(a.promptText) : '',
          once: Boolean(a.once),
        };
        session.addLog('devtools', `dialog rule → ${action}${dt.dialogRule.once ? ' (once)' : ''}`);
        return { ok: true, data: { rule: { ...dt.dialogRule } } };
      }
      if (sub === 'accept' || sub === 'dismiss') {
        if (!dt.pendingDialog) return { error: 'no pending dialog' };
        const id = dt.pendingDialog.id;
        await dt.pendingDialog.decide(sub === 'accept', a.promptText);
        return { ok: true, data: { id, action: sub === 'accept' ? 'accepted' : 'dismissed' } };
      }
      if (sub === 'clear') {
        dt.dialogs = [];
        return { ok: true, data: { cleared: true } };
      }
      return { error: `unknown dialog operation: ${sub}` };
    }

    case 'trace': {
      const sub = String(a.sub || a.mode || 'status').toLowerCase();
      try {
        if (sub === 'status') return { ok: true, data: session.netControls.traceStatus() };
        if (sub === 'start') {
          const started = await session.netControls.startTrace(session.ctx, {
            screenshots: a.screenshots !== false,
            snapshots: a.snapshots !== false,
            sources: Boolean(a.sources),
          });
          session.addLog('devtools', 'Playwright trace recording started');
          return { ok: true, data: started };
        }
        if (sub === 'stop') {
          const stopped = await session.netControls.stopTrace(session.ctx, session.id);
          session.lastTracePath = stopped.path || null;
          session.addLog('devtools', `Playwright trace saved → ${stopped.path} (${stopped.bytes} bytes)`);
          return { ok: true, data: stopped };
        }
        return { error: `unknown trace operation: ${sub}` };
      } catch (e) {
        return { error: String(e.message || e).split('\n')[0].slice(0, 180) };
      }
    }

    default:
      return null;
  }
}

async function smoothMouseDrag(page, x1, y1, x2, y2, steps = 10) {
  if (!page?.mouse) throw new Error('page.mouse unavailable');
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps });
  await page.mouse.up();
}

// ---------- Direct Supervisor Human Takeover (CAPTCHA / OTP / 2FA) ----------
// Operates even while session.paused === true so a human supervisor can interact
// directly with the live browser viewport while the autonomous agent waits cleanly.
export async function executeHumanTakeover(session, input = {}) {
  await session.init();
  session.touch();
  const page = session.active();
  if (!page) throw new Error('no active tab');

  const op = String(input.op || '').toLowerCase();
  const clampCoord = (v, max) => Math.min(max, Math.max(0, Math.round(Number(v) || 0)));
  const vw = session.viewport?.width || 1280;
  const vh = session.viewport?.height || 800;

  session.metrics?.recordTakeover?.();

  switch (op) {
    case 'click':
    case 'dblclick':
    case 'rightclick': {
      const x = clampCoord(input.x, vw);
      const y = clampCoord(input.y, vh);
      const button = op === 'rightclick' ? 'right' : (['left', 'right', 'middle'].includes(input.button) ? input.button : 'left');
      if (op === 'dblclick' && page.mouse?.dblclick) {
        await page.mouse.dblclick(x, y, { button });
      } else {
        await page.mouse?.click?.(x, y, { button, clickCount: op === 'dblclick' ? 2 : 1 });
      }
      session.addLog('human', `takeover ${op} (${x}, ${y})`);
      break;
    }
    case 'drag': {
      const x1 = clampCoord(input.x, vw);
      const y1 = clampCoord(input.y, vh);
      const x2 = clampCoord(input.targetX, vw);
      const y2 = clampCoord(input.targetY, vh);
      await smoothMouseDrag(page, x1, y1, x2, y2, 12);
      session.addLog('human', `takeover drag (${x1},${y1}) → (${x2},${y2})`);
      break;
    }
    case 'wheel': {
      const dx = Math.max(-4000, Math.min(4000, Math.round(Number(input.dx) || 0)));
      const dy = Math.max(-4000, Math.min(4000, Math.round(Number(input.dy) || 0)));
      await page.mouse?.wheel?.(dx, dy);
      session.addLog('human', `takeover scroll (${dx}, ${dy})`);
      break;
    }
    case 'type': {
      const text = String(input.text ?? '');
      if (!text || text.length > 2000) throw new Error('text must be 1..2000 characters');
      const masked = input.secret ? '"••••••"' : `(${text.length} chars)`;
      if (page.keyboard?.insertText) {
        await page.keyboard.insertText(text);
      } else {
        await page.keyboard?.type?.(text, { delay: 12 });
      }
      if (input.submit) await page.keyboard?.press?.('Enter');
      session.addLog('human', `takeover input ${masked}${input.submit ? ' + Enter' : ''}`);
      break;
    }
    case 'press': {
      const key = String(input.key || '').trim();
      if (!isValidKeyChord(key)) throw new Error('invalid key chord');
      await page.keyboard?.press?.(key);
      session.addLog('human', `takeover key ${key}`);
      break;
    }
    case 'goto': {
      let url = String(input.url || '').trim();
      if (!url) throw new Error('url required');
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
      const check = await session.policy.resolveAllowed(url);
      if (!check.ok) throw new Error(check.reason);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      session.addLog('human', `takeover goto ${url}`);
      break;
    }
    case 'back':
      await page.goBack?.({ timeout: 15000 }).catch(() => {});
      session.addLog('human', 'takeover back');
      break;
    case 'forward':
      await page.goForward?.({ timeout: 15000 }).catch(() => {});
      session.addLog('human', 'takeover forward');
      break;
    case 'reload':
      await page.reload?.({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      session.addLog('human', 'takeover reload');
      break;
    default:
      throw new Error(`unsupported takeover op: ${op}`);
  }

  await sleep(140);
  const snap = await session.snap().catch(() => session.snapshot);
  const buf = await session.capture({ quality: 68 }).catch(() => null);
  return {
    ok: true,
    paused: session.paused,
    url: page.url?.() || '',
    title: session.activeTab()?.title || '',
    shotVersion: session.shotVersion,
    hasShot: Boolean(buf),
    controls: snap?.boxes?.length || 0,
  };
}
