#!/usr/bin/env node
// cli.mjs — One-shot headless page fetch & structured extraction for agents and shell pipelines.
// Content goes to stdout only; diagnostics go to stderr.

import { Session } from './lib/session.mjs';

const usage = 'Usage: node cli.mjs fetch <url> [--dump text|html|markdown|links|forms] [--max-chars N] [--allow-private]';
const args = process.argv.slice(2);
if (args[0] !== 'fetch' || !args[1]) {
  console.error(usage);
  process.exit(1);
}

let format = 'text';
let maxChars = 20000;
let allowPrivate = undefined;

for (let i = 2; i < args.length; i++) {
  if (args[i] === '--dump' && args[i + 1]) format = args[++i];
  else if (args[i] === '--max-chars' && args[i + 1]) maxChars = Number(args[++i]);
  else if (args[i] === '--allow-private') allowPrivate = true;
  else {
    console.error(usage);
    process.exit(1);
  }
}

const session = new Session(allowPrivate ? { policy: { allowPrivateNetworks: true } } : {});
try {
  const opened = await session.act({ op: 'open', url: args[1] });
  if (opened.blocked || opened.error) throw new Error(opened.reason || opened.error);
  const extracted = await session.act({ op: 'extract', format, maxChars });
  if (extracted.blocked || extracted.error) throw new Error(extracted.reason || extracted.error);
  const { data } = extracted;
  console.log(data.content ?? JSON.stringify(data, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await session.shutdown();
}
