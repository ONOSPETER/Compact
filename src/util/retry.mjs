import { sleep } from './fs.mjs';

/**
 * Run fn with exponential backoff + jitter.
 * shouldRetry(err, attempt) decides whether a failure is transient.
 */
export async function retry(fn, { attempts = 3, baseMs = 300, factor = 3, maxMs = 8000, shouldRetry = () => true, onRetry } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (i === attempts || !shouldRetry(err, i)) break;
      const delay = Math.min(maxMs, baseMs * factor ** (i - 1)) * (0.75 + Math.random() * 0.5);
      onRetry?.(err, i, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}
