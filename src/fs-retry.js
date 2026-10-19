import fs from 'node:fs';

const RETRYABLE_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const MAX_RENAME_RETRIES = 6;
const INITIAL_RENAME_DELAY_MS = 10;

// Windows ではウイルス対策や索引サービスが置き換え先を開いている間、rename が拒否されるため再試行する。
export function renameWithRetry(from, to, initialDelayMs = INITIAL_RENAME_DELAY_MS) {
  let delayMs = initialDelayMs;
  for (let retry = 0; ; retry++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (!RETRYABLE_RENAME_ERRORS.has(error.code) || retry >= MAX_RENAME_RETRIES) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      delayMs *= 2;
    }
  }
}
