import fs from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renameWithRetry } from '../src/fs-retry.js';

afterEach(() => vi.restoreAllMocks());

describe('renameWithRetry', () => {
  test('一時的な EPERM の後に成功する', () => {
    const failure = Object.assign(new Error('一時的に使用中'), { code: 'EPERM' });
    let calls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      calls++;
      if (calls <= 2) throw failure;
    });

    renameWithRetry('source', 'target', 0);

    expect(calls).toBe(3);
  });

  test('再試行対象外のエラーは一度で投げる', () => {
    const failure = Object.assign(new Error('見つからない'), { code: 'ENOENT' });
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw failure; });

    expect(() => renameWithRetry('source', 'target', 0)).toThrow(failure);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  test('再試行を使い切ったとき最後のエラーを投げる', () => {
    const failures = [];
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      const failure = Object.assign(new Error('使用中'), { code: 'EPERM' });
      failures.push(failure);
      throw failure;
    });

    let thrown;
    try { renameWithRetry('source', 'target', 0); }
    catch (error) { thrown = error; }

    expect(rename).toHaveBeenCalledTimes(7);
    expect(thrown).toBe(failures.at(-1));
  });
});
