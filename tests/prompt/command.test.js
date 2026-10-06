import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { EXIT_OK, EXIT_USAGE, run } from '../../src/cli.js';
import { batchPaths } from '../../src/paths.js';
import { changedAssignedFiles, createGitSnapshot } from '../../src/snapshot/git.js';
import { createHashList, writeHashList } from '../../src/snapshot/hash-list.js';

const roots = [];
const criteria = fs.readFileSync(new URL('../../templates/criteria.md', import.meta.url), 'utf8');
function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function write(root, file, text) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}
async function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-prompt-'));
  roots.push(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'prompt@example.test']);
  git(root, ['config', 'user.name', 'Prompt Test']);
  write(root, 'src/a.cpp', '// a\n// b\n// c\n// d\n');
  write(root, 'src/b.cpp', 'int b;\n');
  write(root, 'src/space name.cpp', 'int c;\n');
  write(root, 'docs/design.md', '# 仕様\n');
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', '基準']);
  const base = git(root, ['rev-parse', 'HEAD']);
  write(root, '.comment-tidy/config.json', JSON.stringify({
    rulesPaths: ['~/.claude/CLAUDE.md'], passes: { volume: { criteria: 'criteria-volume.md' } },
  }));
  write(root, '.comment-tidy/criteria-volume.md', criteria);
  expect(await run(['plan', 'volume', '--repo', root, '--base', base], capture().io)).toBe(EXIT_OK);
  const paths = batchPaths(root, 'volume', 'V01');
  return { root, base, paths };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('prompt コマンド', { timeout: 15000 }, () => {
  test('作業ツリー無しなら基準から新規の依頼文を出し、何も書き込まない', async () => {
    const { root, paths } = await makeRepo();
    const original = git(root, ['status', '--porcelain']);
    write(root, 'src/a.cpp', '// worktree\n');
    const result = capture();
    expect(await run(['prompt', 'V01', '--repo', root], result.io)).toBe(EXIT_OK);
    expect(result.out[0]).toContain('新規の作業');
    expect(result.out[0]).toContain('1-4');
    expect(result.out[0]).toContain(os.homedir().replace(/\\/g, '/'));
    expect(fs.existsSync(paths.worktree)).toBe(false);
    expect(fs.existsSync(paths.state)).toBe(false);
    expect(fs.existsSync(paths.prompt)).toBe(false);
    expect(git(root, ['status', '--porcelain'])).toContain(original);
    expect(fs.readFileSync(path.join(root, 'src/a.cpp'), 'utf8')).toBe('// worktree\n');
  });

  test('作業ツリーの担当ファイルを変更ありと未着手に分け、現在の行範囲を示す', async () => {
    const { root, base, paths } = await makeRepo();
    git(root, ['worktree', 'add', '--detach', paths.worktree, base]);
    write(paths.worktree, 'src/a.cpp', '// 短くした\n');
    write(paths.worktree, 'outside.cpp', '// 担当外\n');
    const result = capture();
    expect(await run(['prompt', 'V01', '--repo', root], result.io)).toBe(EXIT_OK);
    expect(result.out[0]).toContain('途中の作業を再開');
    expect(result.out[0]).toContain('変更あり: src/a.cpp');
    expect(result.out[0]).toContain('未着手: src/b.cpp, src/space name.cpp');
    expect(result.out[0]).not.toContain('outside.cpp');
    expect(result.out[0]).not.toContain('1-4');
    expect(result.out[0]).toContain('--offline');
    expect(result.out[0]).toContain(paths.hashes.replace(/\\/g, '/'));
  });

  test('空白のある担当名とステージ済みの改名を変更一覧へ含める', async () => {
    const { root, base, paths } = await makeRepo();
    git(root, ['worktree', 'add', '--detach', paths.worktree, base]);
    write(paths.worktree, 'src/space name.cpp', 'int changed;\n');
    git(paths.worktree, ['mv', 'src/a.cpp', 'src/renamed.cpp']);
    expect(changedAssignedFiles(paths.worktree, ['src/a.cpp', 'src/b.cpp', 'src/space name.cpp']))
      .toEqual(new Set(['src/a.cpp', 'src/space name.cpp']));
  });

  test('依頼文に載せたコマンドで基準の写しと変更後の担当ファイルを検査できる', async () => {
    const { root, base, paths } = await makeRepo();
    git(root, ['worktree', 'add', '--detach', paths.worktree, base]);
    const baseline = createGitSnapshot(paths.worktree);
    const definition = JSON.parse(fs.readFileSync(paths.definition, 'utf8'));
    for (const file of definition.batches[0].files) write(paths.baseline, file, baseline.read(file));
    writeHashList(paths.hashes, createHashList(baseline));
    const newline = baseline.read('src/a.cpp').includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
    write(paths.worktree, 'src/a.cpp', `// 短くした${newline}`);
    const result = capture();
    expect(await run(['prompt', 'V01', '--repo', root], result.io)).toBe(EXIT_OK);
    const command = /```(?:powershell|sh)\n([^\n]+)\n```/u.exec(result.out[0])[1];
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
    let output;
    try {
      output = execFileSync(shell, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      throw new Error(`${error.message}\n${error.stdout}\n${error.stderr}`, { cause: error });
    }
    expect(output).toContain('check:');
    expect(fs.existsSync(paths.state)).toBe(false);
  });

  test('正本のパスが未設定なら依頼文を生成しない', async () => {
    const { root } = await makeRepo();
    write(root, '.comment-tidy/config.json', JSON.stringify({ passes: { volume: { criteria: 'criteria-volume.md' } } }));
    const result = capture();
    expect(await run(['prompt', 'V01', '--repo', root], result.io)).toBe(EXIT_USAGE);
    expect(result.err.join('\n')).toContain('rulesPaths');
    expect(result.out).toEqual([]);
  });

  test('複数の回なら --pass を要求し、回を指定すれば選べる', async () => {
    const { root } = await makeRepo();
    const second = JSON.parse(fs.readFileSync(path.join(root, '.comment-tidy/batches-volume.json'), 'utf8'));
    second.pass = 'history';
    write(root, '.comment-tidy/batches-history.json', JSON.stringify(second));
    const result = capture();
    expect(await run(['prompt', 'V01', '--repo', root], result.io)).toBe(EXIT_USAGE);
    expect(result.err.join('\n')).toContain('--pass');
    expect(result.out).toEqual([]);
    expect(await run(['prompt', 'V01', '--repo', root, '--pass', 'volume'], capture().io)).toBe(EXIT_OK);
  });

  test('不明な版と存在しない束を依頼文を出さず拒否する', async () => {
    const { root } = await makeRepo();
    const result = capture();
    expect(await run(['prompt', 'V99', '--repo', root], result.io)).toBe(EXIT_USAGE);
    const file = path.join(root, '.comment-tidy/batches-volume.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.schemaVersion = 2;
    write(root, '.comment-tidy/batches-volume.json', JSON.stringify(value));
    expect(await run(['prompt', 'V01', '--repo', root], result.io)).toBe(EXIT_USAGE);
    expect(result.out).toEqual([]);
  });

  test('サブディレクトリと外部の設定でも判定基準は元の置き場から読む', async () => {
    const { root } = await makeRepo();
    const external = path.join(root, 'config-custom.json');
    write(root, 'config-custom.json', fs.readFileSync(path.join(root, '.comment-tidy/config.json')));
    expect(await run(['prompt', 'V01', '--repo', path.join(root, 'src'), '--config', external], capture().io)).toBe(EXIT_OK);
  });

  test('禁止語を含む判定基準は該当する節と行を示し、依頼文を出さない', async () => {
    const { root } = await makeRepo();
    write(root, '.comment-tidy/criteria-volume.md', criteria.replace('## 対象外', '## 対象外\npush する'));
    const result = capture();
    expect(await run(['prompt', 'V01', '--repo', root], result.io)).toBe(EXIT_USAGE);
    expect(result.out).toEqual([]);
    expect(result.err.join('\n')).toContain('対象外 1行目');
  });

  test('通常のフォルダーを既存の作業ツリーと誤認しない', async () => {
    const { root, paths } = await makeRepo();
    fs.mkdirSync(paths.worktree, { recursive: true });
    const result = capture();
    expect(await run(['prompt', 'V01', '--repo', root], result.io)).toBe(EXIT_USAGE);
    expect(result.out).toEqual([]);
    expect(result.err.join('\n')).toContain('独立したリポジトリ');
  });
});
