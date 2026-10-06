import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { writeHashList } from '../../src/snapshot/hash-list.js';
import { sha256 } from '../../src/snapshot/hash-list.js';
import { batchPaths } from '../../src/paths.js';

const roots = [];

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.resetModules();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('check --offline の依存', () => {
  test('束のoffline検査も子プロセスを読み込まず、状態と結果を書かない', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-batch-offline-'));
    roots.push(root);
    const paths = batchPaths(root, 'volume', 'V01');
    const write = (file, content) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    const source = 'int a; // before\n';
    write(path.join(paths.baseline, 'src/a.cpp'), source);
    write(path.join(paths.worktree, 'src/a.cpp'), 'int a; // after\n');
    write(paths.hashes, JSON.stringify({ algorithm: 'sha256', files: { 'src/a.cpp': sha256(Buffer.from(source)) } }));
    write(paths.definition, JSON.stringify({ schemaVersion: 1, pass: 'volume', base: 'a'.repeat(40), toolCommit: null,
      batches: [{ id: 'V01', area: 'src', files: ['src/a.cpp'], weight: 1, commentChars: 9, docs: [] }] }));
    write(path.join(root, '.comment-tidy/config.json'), JSON.stringify({ passes: { volume: { criteria: 'unused.md' } } }));
    write(paths.state, 'offlineは状態を読まない');
    vi.resetModules();
    vi.doMock('node:child_process', () => { throw new Error('子プロセスを読み込みました'); });
    const { run } = await import('../../src/cli.js');
    expect(await run(['check', 'V01', '--offline', '--repo', root], { stdout: () => {}, stderr: () => {} })).toBe(0);
    expect(fs.readFileSync(paths.state, 'utf8')).toBe('offlineは状態を読まない');
    expect(fs.existsSync(paths.check)).toBe(false);
  });
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
