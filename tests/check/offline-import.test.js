import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { writeHashList } from '../../src/snapshot/hash-list.js';
import { sha256 } from '../../src/snapshot/hash-list.js';

const roots = [];

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.resetModules();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('check --offline の依存', () => {
  test('node:child_process を読み込まずに検査を完了する', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-check-offline-'));
    roots.push(root);
    const baseDir = path.join(root, 'base');
    const workingFile = path.join(root, 'src', 'a.cpp');
    const baseFile = path.join(baseDir, 'src', 'a.cpp');
    fs.mkdirSync(path.dirname(workingFile), { recursive: true });
    fs.mkdirSync(path.dirname(baseFile), { recursive: true });
    fs.writeFileSync(workingFile, 'int value; // after\n');
    fs.writeFileSync(baseFile, 'int value; // before\n');
    const hashesPath = path.join(root, 'hashes.json');
    writeHashList(hashesPath, { algorithm: 'sha256', files: { 'src/a.cpp': sha256(Buffer.from('int value; // before\n')) } });
    vi.doMock('node:child_process', () => {
      throw new Error('check --offline が node:child_process を読み込みました');
    });
    const { run } = await import('../../src/cli.js');
    const output = [];

    expect(await run([
      'check', '--offline', '--repo', root, '--base-dir', baseDir, '--hashes', hashesPath, '--files', 'src/a.cpp',
    ], { stdout: (value) => output.push(value), stderr: (value) => output.push(value) })).toBe(0);
    expect(output.join('\n')).toContain('check: 合格');
  });
});
