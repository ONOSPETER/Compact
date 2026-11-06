// Central error type. Every failure that reaches the user is a CompactError
// with a stable code, a human message and (ideally) a hint that says what to do next.

export const EXIT = Object.freeze({
  OK: 0,
  FAIL: 1,
  USAGE: 2,
  ENV: 3,
  NETWORK: 4,
  VALIDATION: 5,
  CANCELLED: 130,
});

export class CompactError extends Error {
  /**
   * @param {string} code    stable machine-readable code, e.g. E_RPC_UNREACHABLE
   * @param {string} message human readable, one sentence
   * @param {{hint?: string, cause?: unknown, details?: unknown, exitCode?: number}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'CompactError';
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
    this.exitCode = opts.exitCode ?? EXIT.FAIL;
  }
  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint, details: this.details };
  }
}

export const isCompactError = (e) => e instanceof CompactError;

/** Wrap an unknown error without losing an existing CompactError. */
export function wrapError(err, code, message, opts = {}) {
  if (isCompactError(err)) return err;
  return new CompactError(code, message ?? (err && err.message) ?? String(err), { ...opts, cause: err });
}
