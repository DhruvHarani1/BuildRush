#!/usr/bin/env node
import { main } from '../dist/src/cli.js';
main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => { console.error('buildrush: internal error:', err && err.stack ? err.stack : err); process.exitCode = 3; },
);
