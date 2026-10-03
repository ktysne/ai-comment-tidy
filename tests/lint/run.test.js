import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/lint/rules.js', async (importOriginal) => {
  const rules = await importOriginal();
  return { ...rules, findViolations: vi.fn(rules.findViolations) };
});

import { lintRepository } from '../../src/lint/run.js';
import { findViolations } from '../../src/lint/rules.js';

const roots = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-run-'));
  roots.push(root);
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'lint@example.test']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Lint Test']);
  return root;
}

function write(root, relativePath, content) {
  const absolutePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
}

function commitAll(root) {
  execFileSync('git', ['-C', root, 'add', '--all']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'base']);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('lintRepository', () => {
  test('scope.include は無視し、scope.exclude と設定言語で対象を決める', () => {
    const root = makeRepo();
    write(root, '.comment-tidy/config.json', JSON.stringify({
      scope: { include: ['another/**'], exclude: ['skip/**'] },
      languages: { js: ['*.custom'] },
    }));
    write(root, 'source.custom', '// safe\n');
    write(root, 'skip/hidden.custom', '// safe\n');
    commitAll(root);
    write(root, 'source.custom', '// #73\n');
    write(root, 'skip/hidden.custom', '// #99\n');

    const result = lintRepository({ repoRoot: root, mode: 'changed' });

    expect(result.confirmed).toBe(1);
    expect(result.files.map(({ path: filePath }) => filePath)).toEqual(['source.custom']);
  });

  test('既存の違反があるファイルへ無関係な行を足しても報告しない', () => {
    const root = makeRepo();
    write(root, 'src/existing.cpp', '// #123\n\nint value = 1;\n');
    commitAll(root);
    write(root, 'src/existing.cpp', '// #123\n\nint value = 1;\nint next = 2;\n');

    expect(lintRepository({ repoRoot: root, mode: 'changed' })).toEqual({ files: [], confirmed: 0, review: 0 });
  });

  test('新しいファイルの違反をすべて報告する', () => {
    const root = makeRepo();
    write(root, 'src/new.cpp', '// #123\n\n// TODO implement this\n');
    commitAll(root);
    write(root, 'src/added.cpp', '// #45\n\n// HACK finish later\n');

    const result = lintRepository({ repoRoot: root, mode: 'changed' });
    expect(result).toMatchObject({ confirmed: 1, review: 1 });
    expect(result.files[0].path).toBe('src/added.cpp');
    expect(result.files[0].violations.map(({ ruleId }) => ruleId)).toEqual(['issue-ref', 'todo-no-ticket']);
  });

  test('changed で未追跡ファイルを除外する指定を扱う', () => {
    const root = makeRepo();
    write(root, 'tracked.cpp', '// safe\n');
    commitAll(root);
    write(root, 'tracked.cpp', '// #12\n');
    write(root, 'untracked.cpp', '// #34\n');

    const result = lintRepository({ repoRoot: root, mode: 'changed', includeUntracked: false });

    expect(result.confirmed).toBe(1);
    expect(result.files.map(({ path: filePath }) => filePath)).toEqual(['tracked.cpp']);
  });

  test('pathspec 内のワイルドカード文字を文字どおりに扱う', () => {
    const root = makeRepo();
    write(root, 'folder/[literal].cpp', '// safe\n');
    commitAll(root);
    write(root, 'folder/[literal].cpp', '// #73\n');

    const result = lintRepository({ repoRoot: root, mode: 'changed', pathspecs: ['folder/[literal].cpp'] });

    expect(result.files.map(({ path: filePath }) => filePath)).toEqual(['folder/[literal].cpp']);
    expect(result.confirmed).toBe(1);
  });

  test('変更のないファイルが多いフォルダーでは変更ファイルだけを検査する', () => {
    const root = makeRepo();
    for (let index = 0; index < 200; index++) write(root, `folder/stable-${index}.cpp`, '// safe\n');
    write(root, 'folder/changed.cpp', '// safe\n');
    commitAll(root);
    write(root, 'folder/changed.cpp', '// #73\n');
    findViolations.mockClear();

    const result = lintRepository({ repoRoot: root, mode: 'changed', pathspecs: ['folder'] });

    expect(result.files.map(({ path: filePath }) => filePath)).toEqual(['folder/changed.cpp']);
    expect(result.confirmed).toBe(1);
    expect(findViolations).toHaveBeenCalledTimes(2);
  });

  test('staged はインデックスの内容を読み、作業ツリーの未登録変更を読まない', () => {
    const root = makeRepo();
    write(root, 'src/staged.cpp', '// safe\n');
    commitAll(root);
    write(root, 'src/staged.cpp', '// #123\n');
    execFileSync('git', ['-C', root, 'add', '--', 'src/staged.cpp']);
    write(root, 'src/staged.cpp', '// safe\n');

    expect(lintRepository({ repoRoot: root, mode: 'staged' })).toMatchObject({ confirmed: 1, review: 0 });

    write(root, 'src/staged.cpp', '// safe\n');
    execFileSync('git', ['-C', root, 'add', '--', 'src/staged.cpp']);
    write(root, 'src/staged.cpp', '// #789\n');
    expect(lintRepository({ repoRoot: root, mode: 'staged' })).toEqual({ files: [], confirmed: 0, review: 0 });
  });

  test('staged の変更一覧を pathspec で絞る', () => {
    const root = makeRepo();
    write(root, 'selected/inside.cpp', '// #73\n');
    write(root, 'outside.cpp', '// #99\n');
    execFileSync('git', ['-C', root, 'add', '--all']);

    const result = lintRepository({ repoRoot: root, mode: 'staged', pathspecs: ['selected'] });

    expect(result.files.map(({ path: filePath }) => filePath)).toEqual(['selected/inside.cpp']);
    expect(result.confirmed).toBe(1);
  });

  test('空白、セミコロン、アンパサンドを含むファイル名を扱う', () => {
    const root = makeRepo();
    const relativePath = 'src/file name ; &.cpp';
    write(root, relativePath, '// #8\n');
    const result = lintRepository({ repoRoot: root, mode: 'changed' });
    expect(result.files.map(({ path: filePath }) => filePath)).toEqual([relativePath]);
    expect(result.confirmed).toBe(1);
  });

  test('行末の変換だけでは違反を新しく報告しない', () => {
    const root = makeRepo();
    execFileSync('git', ['-C', root, 'config', 'core.autocrlf', 'true']);
    write(root, '.gitattributes', '*.cpp text=auto\n');
    write(root, 'src/lines.cpp', '// #9\r\n');
    commitAll(root);
    write(root, 'src/lines.cpp', '// #9\n');

    expect(lintRepository({ repoRoot: root, mode: 'files', files: ['src/lines.cpp'] }))
      .toEqual({ files: [], confirmed: 0, review: 0 });
  });

  test('scope.exclude と Git の除外対象を調べない', () => {
    const root = makeRepo();
    write(root, '.gitignore', 'ignored.cpp\n');
    write(root, 'skip/hidden.cpp', '// #1\n');
    write(root, 'ignored.cpp', '// #2\n');
    write(root, 'visible.cpp', '// safe\n');
    const configPath = path.join(root, '.comment-tidy', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ scope: { exclude: ['skip/**/*.{cpp,h}'] } }), 'utf8');

    expect(lintRepository({ repoRoot: root, mode: 'changed' })).toEqual({ files: [], confirmed: 0, review: 0 });
  });

  test('lint.enabled が false なら Git を調べず空の結果を返す', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-disabled-'));
    roots.push(root);
    const configPath = path.join(root, '.comment-tidy', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ lint: { enabled: false } }), 'utf8');

    expect(lintRepository({ repoRoot: root, mode: 'changed' })).toEqual({ files: [], confirmed: 0, review: 0 });
  });

  test('名前を変えただけのファイルは、変更前の名前の内容と比べ、既存の違反を報告しない', () => {
    const root = makeRepo();
    write(root, 'old.cpp', '// #1\n\n// TODO later\n\nint value = 1;\n');
    commitAll(root);
    execFileSync('git', ['-C', root, 'mv', 'old.cpp', 'new.cpp']);

    expect(lintRepository({ repoRoot: root, mode: 'staged' })).toEqual({ files: [], confirmed: 0, review: 0 });
    expect(lintRepository({ repoRoot: root, mode: 'changed' })).toEqual({ files: [], confirmed: 0, review: 0 });
  });

  test('ステージしていない名前の変更でも、changed は既存の違反を報告しない', () => {
    const root = makeRepo();
    write(root, 'old.cpp', '// #1\n\n// TODO later\n\nint value = 1;\n');
    commitAll(root);
    fs.renameSync(path.join(root, 'old.cpp'), path.join(root, 'new.cpp'));

    expect(lintRepository({ repoRoot: root, mode: 'changed' })).toEqual({ files: [], confirmed: 0, review: 0 });

    write(root, 'new.cpp', '// #1\n\n// TODO later\n\nint value = 1;\n// #2\n');
    const result = lintRepository({ repoRoot: root, mode: 'changed' });
    expect(result.files[0].violations.map(({ matched }) => matched)).toEqual(['#2']);
  });

  test('名前を変えたファイルに足した違反は報告する', () => {
    const root = makeRepo();
    write(root, 'old.cpp', '// #1\n\nint value = 1;\nint other = 2;\nint third = 3;\n');
    commitAll(root);
    execFileSync('git', ['-C', root, 'mv', 'old.cpp', 'new.cpp']);
    write(root, 'new.cpp', '// #1\n\nint value = 1;\nint other = 2;\nint third = 3;\n// #2\n');
    execFileSync('git', ['-C', root, 'add', '--all']);

    const result = lintRepository({ repoRoot: root, mode: 'staged' });
    expect(result.confirmed).toBe(1);
    expect(result.files[0].violations.map(({ matched }) => matched)).toEqual(['#2']);
  });

  test('scope.exclude のフォルダーに当たるパターンは、その下のファイルにも当たる', () => {
    const root = makeRepo();
    write(root, 'a/gen/x.cpp', '// #1\n');
    write(root, 'skip/sub/y.cpp', '// #2\n');
    const configPath = path.join(root, '.comment-tidy', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ scope: { exclude: ['**/gen', 'skip/*'] } }), 'utf8');

    expect(lintRepository({ repoRoot: root, mode: 'changed' })).toEqual({ files: [], confirmed: 0, review: 0 });
  });

  test('repoRoot を省くと、基準のフォルダーを含むリポジトリのルートを使い、相対パスを基準のフォルダーから解決する', () => {
    const root = makeRepo();
    write(root, 'src/deep/file.cpp', '// #7\n');

    const result = lintRepository({ mode: 'files', files: ['file.cpp'], baseDirectory: path.join(root, 'src', 'deep') });
    expect(result.files.map(({ path: filePath }) => filePath)).toEqual(['src/deep/file.cpp']);
    expect(result.confirmed).toBe(1);
  });

  test('staged-with-worktree は範囲の中で作業ツリーから消えたファイルを飛ばし、残りを検査する', () => {
    const root = makeRepo();
    write(root, 'src/gone.cpp', 'int gone = 1;\n');
    write(root, 'src/kept.cpp', 'int kept = 1;\n');
    commitAll(root);
    fs.rmSync(path.join(root, 'src', 'gone.cpp'));
    write(root, 'src/kept.cpp', '// #5\nint kept = 1;\n');

    expect(lintRepository({ repoRoot: root, mode: 'staged-with-worktree', pathspecs: ['src'] }))
      .toMatchObject({ confirmed: 1, review: 0 });
  });

  test('範囲の外から範囲の中へ移したファイルは、移す前の内容と比べる', () => {
    const root = makeRepo();
    write(root, 'old.cpp', '// #42\nint value = 1;\n');
    commitAll(root);
    fs.mkdirSync(path.join(root, 'src'));
    execFileSync('git', ['-C', root, 'mv', 'old.cpp', 'src/new.cpp']);

    const empty = { files: [], confirmed: 0, review: 0 };
    expect(lintRepository({ repoRoot: root, mode: 'staged-with-worktree', pathspecs: ['src'] })).toEqual(empty);
    expect(lintRepository({ repoRoot: root, mode: 'changed', pathspecs: ['src'], includeUntracked: false })).toEqual(empty);
  });

  test('コミットが無いリポジトリでも追加ファイルを検査する', () => {
    const root = makeRepo();
    write(root, 'src/first.cpp', '// #321\n');

    expect(lintRepository({ repoRoot: root, mode: 'changed' })).toMatchObject({ confirmed: 1, review: 0 });
  });
});
