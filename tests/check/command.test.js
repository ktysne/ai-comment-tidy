import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { run } from '../../src/cli.js';
import { createHashList, writeHashList } from '../../src/snapshot/hash-list.js';

const roots = [];

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-check-'));
  roots.push(root);
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'check@example.test']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Check Test']);
  execFileSync('git', ['-C', root, 'config', 'core.autocrlf', 'false']);
  return root;
}

function write(root, filePath, contents) {
  const absolutePath = path.join(root, ...filePath.split('/'));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
}

function commitAll(root) {
  execFileSync('git', ['-C', root, 'add', '--all']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'base']);
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('check コマンドの引数', () => {
  test('--base と --files で Git の基準とコメントだけの変更を検査する', async () => {
    const root = makeRepo();
    write(root, 'src/a.cpp', 'int value; // before\n');
    const base = commitAll(root);
    write(root, 'src/a.cpp', 'int value; // after\n');
    const result = capture();

    expect(await run(['check', '--repo', root, '--base', base, '--files', 'src/a.cpp'], result.io)).toBe(0);
    expect(result.out[0]).toContain('check: 合格');
    expect(result.err).toEqual([]);
  });

  test('--offline と基準の写しとハッシュ一覧で検査する', async () => {
    const root = makeRepo();
    const baseDir = path.join(root, 'base-copy');
    fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
    write(baseDir, 'src/a.cpp', 'int value; // before\n');
    write(root, 'src/a.cpp', 'int value; // after\n');
    write(root, 'src/untouched.js', 'const value = 1;\n');
    const source = { 'src/untouched.js': fs.readFileSync(path.join(root, 'src', 'untouched.js')) };
    const hashesPath = path.join(root, 'hashes.json');
    writeHashList(hashesPath, createHashList({
      listFiles: () => Object.keys(source),
      readMany: (files) => new Map(files.map((filePath) => [filePath, source[filePath]])),
    }));
    const result = capture();

    expect(await run([
      'check', '--offline', '--repo', root, '--base-dir', baseDir, '--hashes', hashesPath, '--files', 'src/a.cpp',
    ], result.io)).toBe(0);
    expect(result.out[0]).toContain('check: 合格');
    expect(result.err).toEqual([]);
  });

  test('Git 経路の --out は検査結果を JSON で保存する', async () => {
    const root = makeRepo();
    write(root, 'src/a.cpp', 'int value; // before\n');
    const base = commitAll(root);
    write(root, 'src/a.cpp', 'int value; // after\n');
    const outputPath = path.join(root, 'check.json');
    const result = capture();

    expect(await run([
      'check', '--repo', root, '--base', base, '--files', 'src/a.cpp', '--out', outputPath,
    ], result.io)).toBe(0);
    const report = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(report).toMatchObject({ schemaVersion: 1, base, offline: false, ok: true, files: ['src/a.cpp'] });
    expect(result.out).toEqual([]);
  });

  test('--base も --offline も無ければ引数の誤りとして 2 で終える', async () => {
    const result = capture();

    expect(await run(['check', '--files', 'src/a.cpp'], result.io)).toBe(2);
    expect(result.err.join('\n')).toContain('--base');
  });
});
