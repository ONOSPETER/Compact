#!/usr/bin/env node
import { main } from '../src/cli/main.mjs';

// Piping into `head` etc. closes stdout early: exit quietly instead of crashing.
for (const s of [process.stdout, process.stderr]) s.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
