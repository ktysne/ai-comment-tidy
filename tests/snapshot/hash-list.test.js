import { describe, expect, test } from 'vitest';

import { createHashList, sha256, validateHashList } from '../../src/snapshot/hash-list.js';

describe('ハッシュ一覧', () => {
  test('sha256 と相対パスを並べた一覧を作る', () => {
    const content = Buffer.from('value');
    const result = createHashList({
      listFiles: () => ['src/a.cpp'],
      readMany: () => new Map([['src/a.cpp', content]]),
    });

    expect(result).toEqual({ algorithm: 'sha256', files: { 'src/a.cpp': sha256(content) } });
  });

  test('絶対パスや不正なハッシュを拒否する', () => {
    expect(() => validateHashList({ algorithm: 'sha256', files: { '../a.cpp': '0'.repeat(64) } })).toThrow('相対パス');
    expect(() => validateHashList({ algorithm: 'sha256', files: { 'a.cpp': 'invalid' } })).toThrow('不正');
  });
});
