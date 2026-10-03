import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const roots = [];

afterEach(() => {
  vi.doUnmock('node:child_process');
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('写しのディレクトリの読み取り', () => {
  test('渡したファイルだけを読み、子プロセスを起動しない', async () => {
    vi.doMock('node:child_process', () => {
      throw new Error('子プロセスを起動できません');
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-fs-snapshot-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'listed.cpp'), '// listed\n', 'utf8');
    fs.writeFileSync(path.join(root, 'unlisted.cpp'), '// unlisted\n', 'utf8');

    const { createFsSnapshot } = await import('../../src/snapshot/fs.js');
    const snapshot = createFsSnapshot(root, ['listed.cpp']);

    expect(snapshot.listFiles()).toEqual(['listed.cpp']);
    expect(snapshot.read('listed.cpp')).toEqual(Buffer.from('// listed\n', 'utf8'));
    expect(snapshot.has('listed.cpp')).toBe(true);
    expect(snapshot.has('unlisted.cpp')).toBe(false);
  });
});
