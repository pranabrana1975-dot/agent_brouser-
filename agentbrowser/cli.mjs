#!/usr/bin/env node
// cli.mjs — One-shot headless page fetch, structured scraper, PDF export & F12 DevTools CLI.
// Output goes to stdout only; errors/usage go to stderr.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from './lib/session.mjs';
import { EXTRACT_FORMATS } from './lib/extract.mjs';

const DEVTOOLS_DUMPS = ['snapshot', 'pdf', 'network', 'console', 'perf', 'audit', 'security', 'storage', 'a11y'];
const ALL_DUMPS = [...EXTRACT_FORMATS.filter((f) => f !== 'schema'), ...DEVTOOLS_DUMPS];

const usage = [
  'Usage:',
  `  node cli.mjs fetch <url> [--dump ${ALL_DUMPS.join('|')}] [--max-chars N] [--max-pages N] [--selector <css>] [--device desktop|iphone-15|pixel-8|ipad] [--proxy <url>] [--allow-private]`,
  '  node cli.mjs inspect <url> [--selector <css>] [--device desktop|iphone-15|pixel-8|ipad] [--proxy <url>] [--allow-private]',
].join('\n');

export function parseCliArgs(argv) {
  const cmd = argv[0];
  const url = argv[1];
  if (!['fetch', 'inspect'].includes(cmd) || !url || url.startsWith('--')) {
    throw new Error(usage);
  }
  const opts = {
    cmd,
    url,
    dump: 'text',
    maxChars: 20000,
    maxPages: 1,
    selector: '',
    device: '',
    proxy: '',
    allowPrivate: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dump' && argv[i + 1]) opts.dump = argv[++i];
    else if (flag === '--max-chars' && argv[i + 1]) opts.maxChars = Number(argv[++i]);
    else if (flag === '--max-pages' && argv[i + 1]) opts.maxPages = Number(argv[++i]);
    else if (flag === '--selector' && argv[i + 1]) opts.selector = argv[++i];
    else if (flag === '--device' && argv[i + 1]) opts.device = argv[++i];
    else if (flag === '--proxy' && argv[i + 1]) opts.proxy = argv[++i];
    else if (flag === '--allow-private') opts.allowPrivate = true;
    else throw new Error(usage);
  }
  if (cmd === 'fetch' && !ALL_DUMPS.includes(opts.dump)) {
    throw new Error(`Unsupported --dump format: ${opts.dump}\n${usage}`);
  }
  return opts;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const session = new Session({
    minActionIntervalMs: 0,
    ...(opts.allowPrivate ? { policy: { allowPrivateNetworks: true } } : {}),
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  });

  const must = async (action) => {
    const out = await session.act(action);
    if (out?.blocked || out?.error) throw new Error(out.reason || out.error);
    return out;
  };

  try {
    if (opts.device) {
      await must({ op: 'emulate', device: opts.device });
    }
    const opened = await must({ op: 'open', url: opts.url });

    if (opts.cmd === 'inspect') {
      const report = {
        url: opened.snapshot?.meta?.url || opts.url,
        title: opened.snapshot?.meta?.title || '',
        console: (await must({ op: 'console', sub: 'list' })).data,
        network: (await must({ op: 'network', sub: 'list' })).data,
        perf: (await must({ op: 'perf' })).data,
        security: (await must({ op: 'security' })).data,
        audit: (await must({ op: 'audit' })).data,
      };
      if (opts.selector) {
        report.element = (await must({ op: 'inspect', selector: opts.selector })).data;
      }
      console.log(JSON.stringify(report, null, 2));
    } else if (EXTRACT_FORMATS.includes(opts.dump)) {
      const { data } = await must({
        op: 'extract',
        format: opts.dump,
        maxChars: opts.maxChars,
        ...(opts.maxPages > 1 ? { maxPages: opts.maxPages } : {}),
        ...(opts.selector ? { selector: opts.selector } : {}),
      });
      console.log(data.content ?? JSON.stringify(data, null, 2));
    } else if (opts.dump === 'pdf') {
      const { data } = await must({ op: 'pdf', includeBase64: true });
      process.stdout.write(Buffer.from(data.base64, 'base64'));
    } else if (opts.dump === 'snapshot') {
      console.log(opened.snapshot?.text || '');
    } else if (opts.dump === 'a11y') {
      const { data } = await must({ op: 'a11y', maxChars: opts.maxChars });
      console.log(data.tree || '');
    } else if (opts.dump === 'network') {
      console.log(JSON.stringify((await must({ op: 'network', sub: 'list', limit: 200 })).data, null, 2));
    } else if (opts.dump === 'console') {
      console.log(JSON.stringify((await must({ op: 'console', sub: 'list', limit: 200 })).data, null, 2));
    } else {
      console.log(JSON.stringify((await must({ op: opts.dump })).data, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await session.shutdown();
  }
}
