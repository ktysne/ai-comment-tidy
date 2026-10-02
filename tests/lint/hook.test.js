import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { run } from '../../src/cli.js';
import { detectCommit } from '../../src/lint/hooks.js';

const roots = [];

function makeRepo(source = '// safe\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-hook-'));
  roots.push(root);
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'hook@example.test']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Hook Test']);
  fs.writeFileSync(path.join(root, 'source.cpp'), source, 'utf8');
  execFileSync('git', ['-C', root, 'add', '--all']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'base']);
  return root;
}

function capture() {
  const stdout = [];
  const stderr = [];
  return { stdout, stderr, io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) } };
}

async function runHook(hook, input, extraIo = {}) {
  const result = capture();
  const code = await run(['lint', '--hook', hook], {
    ...result.io,
    readStdin: async () => input,
    ...extraIo,
  });
  return { code, ...result };
}

function editInput(root, filePath, toolInput, toolName = 'Edit') {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: { file_path: filePath, ...toolInput },
    cwd: root,
  });
}

function commitInput(root, command, toolName = 'Bash') {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { command },
    cwd: root,
  });
}

function writeSource(root, source) {
  fs.writeFileSync(path.join(root, 'source.cpp'), source, 'utf8');
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('lint --hook post-edit', () => {
  test('違反のあるコメントを足した Edit で 2 と報告が返る', async () => {
    const root = makeRepo();
    writeSource(root, '// #123\n');

    const result = await runHook('post-edit', editInput(root, 'source.cpp', { new_string: '// #123' }));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('いま書いたコメント');
    expect(result.stderr[0]).toContain('issue-ref');
  });

  test('編集した範囲の外にある新しい違反を報告しない', async () => {
    const root = makeRepo();
    writeSource(root, '// #12\nint value = 1;\n// #34\n');

    const result = await runHook('post-edit', editInput(root, 'source.cpp', { new_string: '// #12' }));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('#12');
    expect(result.stderr[0]).not.toContain('#34');
  });

  test('比べる元にある違反を報告しない', async () => {
    const root = makeRepo('// #123\nint value = 1;\n');
    writeSource(root, '// #123\nint value = 2;\n');

    const result = await runHook('post-edit', editInput(root, 'source.cpp', { new_string: 'int value = 2;' }));

    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([]);
  });

  test('Write はファイル全体を調べる', async () => {
    const root = makeRepo();
    writeSource(root, 'int value = 1;\n// #123\n');

    const result = await runHook('post-edit', editInput(root, 'source.cpp', { content: 'int value = 1;\n// #123\n' }, 'Write'));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('issue-ref');
  });

  test('replace_all では一致した複数の位置を調べる', async () => {
    const root = makeRepo();
    writeSource(root, '// #7\nint value = 1;\n// #7\n');

    const result = await runHook('post-edit', editInput(root, 'source.cpp', { new_string: '// #7', replace_all: true }));

    expect(result.code).toBe(2);
    expect(result.stderr[0].match(/issue-ref/g)).toHaveLength(2);
  });

  test('CRLF のファイルでも LF の new_string の位置を見つける', async () => {
    const root = makeRepo();
    writeSource(root, 'int value = 1;\r\n// #123\r\n');

    const result = await runHook('post-edit', editInput(root, 'source.cpp', { new_string: 'int value = 1;\n// #123' }));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('issue-ref');
  });

  test('非対応言語、リポジトリ外、存在しないファイル、別のツールは何も出さずに終わる', async () => {
    const root = makeRepo();
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-hook-outside-'));
    roots.push(externalRoot);
    fs.writeFileSync(path.join(root, 'notes.txt'), '// #1\n', 'utf8');
    fs.writeFileSync(path.join(externalRoot, 'outside.cpp'), '// #2\n', 'utf8');
    const inputs = [
      editInput(root, 'notes.txt', { new_string: '// #1' }),
      editInput(root, path.join(externalRoot, 'outside.cpp'), { new_string: '// #2' }),
      editInput(root, 'missing.cpp', { new_string: '// #3' }),
      editInput(root, 'source.cpp', { new_string: '// #4' }, 'Bash'),
    ];

    for (const input of inputs) {
      const result = await runHook('post-edit', input);
      expect(result.code).toBe(0);
      expect(result.stdout).toEqual([]);
      expect(result.stderr).toEqual([]);
    }
  });

  test('壊れた JSON は一行を標準エラーへ出して 0 で終わる', async () => {
    const result = await runHook('post-edit', '{');

    expect(result.code).toBe(0);
    expect(result.stderr).toHaveLength(1);
    expect(result.stderr[0]).not.toMatch(/[\r\n]/);
  });

  test('空の入力は何も出さずに 0 で終わる', async () => {
    const result = await runHook('post-edit', '');

    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([]);
  });
});

describe('detectCommit', () => {
  test.each([
    ['git commit -m x', { directory: null, mode: 'staged' }],
    ['git -C sub commit -m x', { directory: 'sub', mode: 'staged' }],
    ['git -c user.name=x commit -m x', { directory: null, mode: 'staged' }],
    ['git --no-pager -C sub commit -m x', { directory: 'sub', mode: 'staged' }],
    ['cd sub && git commit -m x', { directory: 'sub', mode: 'staged' }],
    ['cd "D:\\work dir" && git commit -m x', { directory: 'D:\\work dir', mode: 'staged' }],
    ['git add -A && git commit -m x', { directory: null, mode: 'changed' }],
    ['git commit -am x', { directory: null, mode: 'changed' }],
    ['git commit --all', { directory: null, mode: 'changed' }],
    ['git status\ngit commit -m x', { directory: null, mode: 'staged' }],
  ])('コミットを作る形を判定する: %s', (command, expected) => {
    expect(detectCommit(command)).toEqual(expected);
  });

  test.each([
    'git commit-tree abc',
    'git commit-graph write',
    'git log --grep commit',
    'git status',
    'echo "git commit"',
    '',
  ])('コミットでない形を判定しない: %s', (command) => {
    expect(detectCommit(command)).toBeNull();
  });
});

describe('lint --hook pre-commit', () => {
  test('ステージした確定の違反があると 2 と報告が返る', async () => {
    const root = makeRepo();
    writeSource(root, '// #123\n');
    execFileSync('git', ['-C', root, 'add', '--all']);

    const result = await runHook('pre-commit', commitInput(root, 'git commit -m x'));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('確定の違反');
    expect(result.stderr[0]).toContain('issue-ref');
  });

  test('見直し候補だけなら JSON を標準出力へ出してコミットを通す', async () => {
    const root = makeRepo();
    writeSource(root, '// TODO finish later\n');
    execFileSync('git', ['-C', root, 'add', '--all']);

    const result = await runHook('pre-commit', commitInput(root, 'git commit -m x'));

    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(JSON.parse(result.stdout[0])).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: expect.stringContaining('見直し候補'),
      },
    });
  });

  test('違反が無いコミットとコミット以外のコマンドは何も出さない', async () => {
    const root = makeRepo();
    const clean = await runHook('pre-commit', commitInput(root, 'git commit -m x'));
    const other = await runHook('pre-commit', commitInput(root, 'git status'));

    expect(clean.code).toBe(0);
    expect(clean.stdout).toEqual([]);
    expect(clean.stderr).toEqual([]);
    expect(other.code).toBe(0);
    expect(other.stdout).toEqual([]);
    expect(other.stderr).toEqual([]);
  });

  test('PowerShell のコミット入力も検査する', async () => {
    const root = makeRepo();

    const result = await runHook('pre-commit', commitInput(root, 'git commit -m x', 'PowerShell'));

    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([]);
  });

  test('git add を含むコマンドでは未ステージの違反も調べる', async () => {
    const root = makeRepo();
    writeSource(root, '// #42\n');

    const result = await runHook('pre-commit', commitInput(root, 'git add -A && git commit -m x'));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('#42');
  });

  test('リポジトリ外と壊れた JSON はコミットを止めない', async () => {
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-precommit-outside-'));
    roots.push(externalRoot);
    const outside = await runHook('pre-commit', commitInput(externalRoot, 'git commit -m x'));
    const malformed = await runHook('pre-commit', '{');

    expect(outside.code).toBe(0);
    expect(outside.stdout).toEqual([]);
    expect(outside.stderr).toEqual([]);
    expect(malformed.code).toBe(0);
    expect(malformed.stderr).toHaveLength(1);
  });

  test('フック内部の例外を一行で知らせて 0 で終わる', async () => {
    const result = await runHook('post-edit', '{}', {
      readStdin: async () => { throw new Error('test failure\nwith another line'); },
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toHaveLength(1);
    expect(result.stderr[0]).toContain('test failure with another line');
    expect(result.stderr[0]).not.toMatch(/[\r\n]/);
  });
});
