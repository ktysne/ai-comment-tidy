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

function editInput(root, filePath, toolInput, toolName = 'Edit', toolResponse) {
  const value = {
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: { file_path: filePath, ...toolInput },
    cwd: root,
  };
  if (toolResponse !== undefined) value.tool_response = toolResponse;
  return JSON.stringify(value);
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
  test('設定した拡張子を post-edit で検査する', async () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, '.comment-tidy'), { recursive: true });
    fs.writeFileSync(path.join(root, '.comment-tidy', 'config.json'), JSON.stringify({
      scope: { include: ['elsewhere/**'], exclude: [] },
      languages: { js: ['*.custom'] },
    }), 'utf8');
    const filePath = path.join(root, 'source.custom');
    fs.writeFileSync(filePath, '// #12\n', 'utf8');

    const result = await runHook('post-edit', editInput(root, filePath, { new_string: '// #12' }));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('issue-ref');
  });

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

  test('structuredPatch がある Edit は指定された行だけを調べる', async () => {
    const root = makeRepo();
    writeSource(root, '// #12\nint value = 1;\n// #34\n');

    const result = await runHook('post-edit', editInput(
      root,
      'source.cpp',
      { new_string: '' },
      'Edit',
      { structuredPatch: [{ newStart: 3, newLines: 1 }] },
    ));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('#34');
    expect(result.stderr[0]).not.toContain('#12');
  });

  test('structuredPatch の newLines が 0 なら newStart の行を調べる', async () => {
    const root = makeRepo();
    writeSource(root, '// #12\nint value = 1;\n// #34\n');

    const result = await runHook('post-edit', editInput(
      root,
      'source.cpp',
      { new_string: 'not present' },
      'Edit',
      { structuredPatch: [{ newStart: 3, newLines: 0 }] },
    ));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('#34');
    expect(result.stderr[0]).not.toContain('#12');
  });

  test('更新 Write は structuredPatch の範囲だけを調べる', async () => {
    const root = makeRepo();
    writeSource(root, 'int value = 1;\n// #12\n// #34\n');

    const result = await runHook('post-edit', editInput(
      root,
      'source.cpp',
      { content: 'int value = 1;\n// #12\n// #34\n' },
      'Write',
      { type: 'update', structuredPatch: [{ newStart: 2, newLines: 1 }] },
    ));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('#12');
    expect(result.stderr[0]).not.toContain('#34');
  });

  test('structuredPatch の無い Edit で new_string が空か見つからなければ何も報告しない', async () => {
    const emptyRoot = makeRepo();
    writeSource(emptyRoot, '// #12\n');
    const empty = await runHook('post-edit', editInput(emptyRoot, 'source.cpp', { new_string: '' }));

    const missingRoot = makeRepo();
    writeSource(missingRoot, '// #34\n');
    const missing = await runHook('post-edit', editInput(missingRoot, 'source.cpp', { new_string: 'not present' }));

    expect(empty.code).toBe(0);
    expect(empty.stderr).toEqual([]);
    expect(missing.code).toBe(0);
    expect(missing.stderr).toEqual([]);
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
    ['cd repo && cd sub && git commit -m x', { directory: path.join('repo', 'sub'), mode: 'staged' }],
    ['Set-Location repo && sl sub && git commit -m x', {
      directory: path.join('repo', 'sub'), mode: 'staged',
    }],
    ['pushd repo && git commit -m x', { directory: 'repo', mode: 'staged' }],
    ['(cd sub && git commit -m x)', { directory: 'sub', mode: 'staged' }],
    ['cd "D:\\work dir" && git commit -m x', {
      directory: path.relative(process.cwd(), 'D:\\work dir'), mode: 'staged',
    }],
    ['NAME=value git commit -m x', { directory: null, mode: 'staged' }],
    ['git -P commit -m x', { directory: null, mode: 'staged' }],
    ['git add -A && git commit -m x', { directory: null, mode: 'changed' }],
    ['git add --all && git commit -m x', { directory: null, mode: 'changed' }],
    ['git add -u && git commit -m x', { directory: null, mode: 'changed', includeUntracked: false }],
    ['git add --update && git commit -m x', { directory: null, mode: 'changed', includeUntracked: false }],
    ['git commit -am x', { directory: null, mode: 'changed', includeUntracked: false }],
    ['git commit --all', { directory: null, mode: 'changed', includeUntracked: false }],
    ['git add src/file.cpp && git commit -m x', {
      directory: null,
      mode: 'staged-with-worktree',
      paths: [path.resolve('src/file.cpp')],
    }],
    ['cd repo && cd sub && git add file.cpp && git commit -m x', {
      directory: path.join('repo', 'sub'),
      mode: 'staged-with-worktree',
      paths: [path.resolve('repo', 'sub', 'file.cpp')],
    }],
    ['git commit -- src/file.cpp', {
      directory: null,
      mode: 'changed',
      paths: [path.resolve('src/file.cpp')],
      includeUntracked: false,
    }],
    ['git commit -i -- src/file.cpp', {
      directory: null,
      mode: 'staged-with-worktree',
      paths: [path.resolve('src/file.cpp')],
      includeUntracked: false,
    }],
    ['git commit --include src/file.cpp', {
      directory: null,
      mode: 'staged-with-worktree',
      paths: [path.resolve('src/file.cpp')],
      includeUntracked: false,
    }],
    ['git add -A && git commit --trailer "X: y" -m x', { directory: null, mode: 'changed' }],
    ['git add src/file.cpp && git commit --unknown -a', {
      directory: null,
      mode: 'staged-with-worktree',
      paths: [path.resolve('src/file.cpp')],
    }],
    ['git add --unknown && git commit -m x', { directory: null, mode: 'staged' }],
    ['git status\ngit commit -m x', { directory: null, mode: 'staged' }],
    ['git add src/*.cpp && git commit -m x', { directory: null, mode: 'changed' }],
    ['git add ":(glob)src/**" && git commit -m x', { directory: null, mode: 'changed' }],
    ['git commit src/*.cpp -m x', { directory: null, mode: 'changed', includeUntracked: false }],
  ])('コミットを作る形を判定する: %s', (command, expected) => {
    expect(detectCommit(command)).toEqual(expected);
  });

  test.each([
    'git commit-tree abc',
    'git commit-graph write',
    'git log --grep commit',
    'git status',
    'echo "git commit"',
    'cat <<WORD\ngit commit -m fake\nWORD',
    "cat <<'WORD'\ngit commit -m fake\nWORD",
    'cat <<"WORD"\ngit commit -m fake\nWORD',
    'cat <<-WORD\n\tgit commit -m fake\n\tWORD',
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

  test('git commit -- <フォルダー> は、その中の未追跡ファイルを調べない', async () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, 'selected'));
    fs.writeFileSync(path.join(root, 'selected', 'untracked.cpp'), '// #99\n', 'utf8');

    const result = await runHook('pre-commit', commitInput(root, 'git commit -- selected'));

    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
  });

  test('git add <フォルダー> は範囲内の未追跡と範囲外のステージ内容を調べる', async () => {
    const root = makeRepo();
    writeSource(root, '// #42\n');
    execFileSync('git', ['-C', root, 'add', '--', 'source.cpp']);
    fs.mkdirSync(path.join(root, 'selected'));
    fs.writeFileSync(path.join(root, 'selected', 'untracked.cpp'), '// #99\n', 'utf8');
    fs.writeFileSync(path.join(root, 'outside.cpp'), '// #77\n', 'utf8');

    const result = await runHook('pre-commit', commitInput(root, 'git add selected && git commit -m x'));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('#42');
    expect(result.stderr[0]).toContain('#99');
    expect(result.stderr[0]).not.toContain('#77');
  });

  test('git commit -i はパスの作業ツリーと範囲外のステージ内容を調べる', async () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, 'selected.cpp'), '// safe\n', 'utf8');
    execFileSync('git', ['-C', root, 'add', '--', 'selected.cpp']);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'selected']);
    writeSource(root, '// #42\n');
    execFileSync('git', ['-C', root, 'add', '--', 'source.cpp']);
    fs.writeFileSync(path.join(root, 'selected.cpp'), '// #99\n', 'utf8');

    const result = await runHook('pre-commit', commitInput(root, 'git commit -i -m x -- selected.cpp'));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('#42');
    expect(result.stderr[0]).toContain('#99');
  });

  test('リポジトリ外のパスを指定した commit は staged を調べる', async () => {
    const root = makeRepo();
    writeSource(root, '// #42\n');
    execFileSync('git', ['-C', root, 'add', '--', 'source.cpp']);

    const result = await runHook('pre-commit', commitInput(root, 'git commit -- ../outside.cpp'));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('#42');
  });

  test.each([
    'git commit -a -m x',
    'git add -u && git commit -m x',
  ])('%s は追跡済みの変更だけを調べる', async (command) => {
    const root = makeRepo();
    writeSource(root, '// #42\n');
    fs.writeFileSync(path.join(root, 'untracked.cpp'), '// #99\n', 'utf8');

    const result = await runHook('pre-commit', commitInput(root, command));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('#42');
    expect(result.stderr[0]).not.toContain('#99');
  });

  test('git add のパスはステージ結果と合わせ、同じファイルには作業ツリーの内容を使う', async () => {
    const root = makeRepo();
    writeSource(root, '// #42\n');
    execFileSync('git', ['-C', root, 'add', '--', 'source.cpp']);
    writeSource(root, '// safe\n');

    const result = await runHook('pre-commit', commitInput(root, 'git add source.cpp && git commit -m x'));

    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
  });

  test('git add のパス指定後にステージと files の違反を合わせて数える', async () => {
    const root = makeRepo();
    writeSource(root, '// TODO finish later\n');
    execFileSync('git', ['-C', root, 'add', '--', 'source.cpp']);
    fs.writeFileSync(path.join(root, 'selected.cpp'), '// #99\n', 'utf8');

    const result = await runHook('pre-commit', commitInput(root, 'git add selected.cpp && git commit -m x'));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('TODO');
    expect(result.stderr[0]).toContain('#99');
  });

  test('リポジトリのルートで git add . を使うと未追跡ファイルも調べる', async () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, 'untracked.cpp'), '// #99\n', 'utf8');

    const result = await runHook('pre-commit', commitInput(root, 'git add . && git commit -m x'));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('#99');
  });

  test('サブフォルダーで git add . を使うとその範囲だけを調べる', async () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'source.cpp'), '// #42\n', 'utf8');
    fs.writeFileSync(path.join(root, 'outside.cpp'), '// #99\n', 'utf8');

    const result = await runHook('pre-commit', commitInput(root, 'cd sub && git add . && git commit -m x'));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('#42');
    expect(result.stderr[0]).not.toContain('#99');
  });

  test('git commit のパス指定があると指定ファイルだけを調べる', async () => {
    const root = makeRepo();
    writeSource(root, '// #42\n');
    fs.writeFileSync(path.join(root, 'other.cpp'), '// #99\n', 'utf8');
    execFileSync('git', ['-C', root, 'add', '--all']);

    const result = await runHook('pre-commit', commitInput(root, 'git commit -- source.cpp'));

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('#42');
    expect(result.stderr[0]).not.toContain('#99');
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
