import readline from 'node:readline/promises';
import { CompactError, EXIT } from '../errors.mjs';

function requireTty() {
  if (!process.stdin.isTTY) {
    throw new CompactError('E_NO_TTY', 'This step needs an interactive terminal.', { hint: 'Pass the value as a flag, or use --yes for defaults.', exitCode: EXIT.USAGE });
  }
}

export async function ask(question, { fallback = '' } = {}) {
  requireTty();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${question}${fallback ? ` (${fallback})` : ''} `)).trim();
    return a || fallback;
  } finally { rl.close(); }
}

export async function confirm(question, { fallback = true } = {}) {
  const a = (await ask(`${question} [${fallback ? 'Y/n' : 'y/N'}]`)).toLowerCase();
  return a ? a.startsWith('y') : fallback;
}

export async function select(question, choices) {
  requireTty();
  process.stdout.write(`${question}\n`);
  choices.forEach((c, i) => process.stdout.write(`  ${i + 1}) ${c.label}\n`));
  for (;;) {
    const n = Number(await ask('Choose a number:'));
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;
  }
}

/** Read a secret without echoing it. */
export function askSecret(question) {
  requireTty();
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const done = (fn, v) => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); fn(v); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') return done(reject, new CompactError('E_ABORT', 'Cancelled.', { exitCode: EXIT.CANCELLED }));
        if (ch === '\r' || ch === '\n') return done(resolve, buf);
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}
