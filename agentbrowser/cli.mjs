#!/usr/bin/env node
// One-shot fetch for agents and shell pipelines. Output goes to stdout only.
import { Session } from './lib/session.mjs';
const usage = 'Usage: node cli.mjs fetch <url> [--dump text|html|markdown|links|forms] [--max-chars N]';
const args = process.argv.slice(2);
if (args[0] !== 'fetch' || !args[1]) { console.error(usage); process.exit(1); }
let format = 'text', maxChars = 20000;
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--dump' && args[i + 1]) format = args[++i];
  else if (args[i] === '--max-chars' && args[i + 1]) maxChars = Number(args[++i]);
  else { console.error(usage); process.exit(1); }
}
const session = new Session();
try {
  const opened = await session.act({ op: 'open', url: args[1] });
  if (opened.blocked || opened.error) throw new Error(opened.reason || opened.error);
  const { data } = await session.act({ op: 'extract', format, maxChars });
  console.log(data.content ?? JSON.stringify(data, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await session.shutdown(); }
