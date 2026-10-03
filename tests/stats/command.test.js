import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { EXIT_OK, EXIT_USAGE, run } from '../../src/cli.js';

const roots = [];

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-stats-'));
  roots.push(root);
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'stats@example.test']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Stats Test']);
  return root;
}

function write(root, filePath, content) {
  const absolutePath = path.join(root, ...filePath.split('/'));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
}

function commitAll(root) {
  execFileSync('git', ['-C', root, 'add', '--all']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'base']);
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('stats コマンド', () => {
  test('作業ツリーと指定コミットの JSON を出力し、領域接頭辞で絞る', async () => {
    const root = makeRepo();
    write(root, 'src/file.cpp', '// base\n');
    write(root, 'other.cpp', '// outside\n');
    const commit = commitAll(root);
    write(root, 'src/file.cpp', 'int value; // worktree\n');
    write(root, 'src/new.js', '// added\n');

    const worktree = capture();
    expect(await run(['stats', '--repo', root, '--paths', 'src/'], worktree.io)).toBe(EXIT_OK);
    const current = JSON.parse(worktree.out[0]);
    expect(current.source).toEqual({ ref: null, worktree: true });
    expect(Object.keys(current.files)).toEqual(['src/file.cpp', 'src/new.js']);
    expect(current.totals.src).toMatchObject({ lines: 2, code: 1, comment: 2, trailing: 1 });

    const baseline = capture();
    expect(await run(['stats', '--repo', root, '--ref', commit, '--paths', 'src/'], baseline.io)).toBe(EXIT_OK);
    const previous = JSON.parse(baseline.out[0]);
    expect(previous.source).toEqual({ ref: commit, worktree: false });
    expect(Object.keys(previous.files)).toEqual(['src/file.cpp']);
    expect(previous.files['src/file.cpp']).toMatchObject({ comment: 1, commentOnly: 1, trailing: 0 });
  });

  test('--out は JSON を保存し、標準出力には領域の要約を出す', async () => {
    const root = makeRepo();
    write(root, 'src/file.js', '// note\n');
    const outputPath = path.join(root, 'stats.json');
    const result = capture();

    expect(await run(['stats', '--repo', root, '--out', outputPath], result.io)).toBe(EXIT_OK);
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8')).files['src/file.js'].comment).toBe(1);
    expect(result.out[0]).toContain('| src |');
    expect(result.out[0]).toContain('| 全体 |');
  });

  test('--repo と絶対パスの --config で範囲、言語、領域を指定する', async () => {
    const root = makeRepo();
    write(root, 'selected/source.custom', '// selected\n');
    write(root, 'outside/source.js', '// outside\n');
    commitAll(root);
    const configPath = path.join(root, 'custom-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      scope: { include: ['selected/**'], exclude: [] },
      languages: { cpp: ['selected/**/*.custom'] },
      areas: { selected: ['selected/**'] },
    }), 'utf8');
    const result = capture();

    expect(await run(['stats', '--repo', root, '--config', configPath], result.io)).toBe(EXIT_OK);
    const report = JSON.parse(result.out[0]);
    expect(Object.keys(report.files)).toEqual(['selected/source.custom']);
    expect(report.totals.selected.comment).toBe(1);

    const relative = capture();
    expect(await run(['stats', '--repo', root, '--config', 'relative.json'], relative.io)).toBe(EXIT_USAGE);
    expect(relative.err.join('\n')).toContain('--config には絶対パスを指定してください');
  });

  test('--compare は領域ごとと全体の Markdown 表を出す', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-compare-'));
    roots.push(root);
    const firstPath = path.join(root, 'first.json');
    const secondPath = path.join(root, 'second.json');
    const first = { lines: 4, code: 1, comment: 3, commentOnly: 2, trailing: 1, doc: 1, separator: 0, commentChars: 24 };
    const second = { lines: 5, code: 2, comment: 3, commentOnly: 2, trailing: 1, doc: 1, separator: 1, commentChars: 30 };
    fs.writeFileSync(firstPath, JSON.stringify({ schemaVersion: 1, totals: { src: first } }));
    fs.writeFileSync(secondPath, JSON.stringify({ schemaVersion: 1, totals: { src: second, tests: second } }));
    const result = capture();

    expect(await run(['stats', '--compare', `before=${firstPath}`, `after=${secondPath}`], result.io)).toBe(EXIT_OK);
    expect(result.out[0]).toContain('## src\n| 値 | before | after |');
    expect(result.out[0]).toContain('| lines | 4 | 5 |');
    expect(result.out[0]).toContain('## tests');
    expect(result.out[0]).toContain('## 全体');
    expect(result.out[0]).toContain('| lines | 4 | 10 |');
  });

  test('--compare が 1 件なら引数の誤りとして 2 で終える', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-compare-args-'));
    roots.push(root);
    const filePath = path.join(root, 'stats.json');
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, totals: {} }));
    const result = capture();

    expect(await run(['stats', '--compare', `only=${filePath}`], result.io)).toBe(EXIT_USAGE);
    expect(result.err.join('\n')).toContain('2 つ以上');
  });

  test('必要な値が無い引数を 2 として報告する', async () => {
    const result = capture();

    expect(await run(['stats', '--paths'], result.io)).toBe(EXIT_USAGE);
    expect(result.err.join('\n')).toContain('--paths');
  });
});
