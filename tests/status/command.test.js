import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { run } from '../../src/cli.js';
import { batchPaths } from '../../src/paths.js';
import { transitionState } from '../../src/state.js';

const roots = [];
function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function write(root, file, content) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-status-'));
  roots.push(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'status@example.test']);
  git(root, ['config', 'user.name', 'Status Test']);
  write(root, 'src/a.cpp', '// abcd\nint a;\n');
  write(root, '.gitignore', '.comment-tidy/work/\n.comment-tidy/worktrees/\n');
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', '基準']);
  const base = git(root, ['rev-parse', 'HEAD']);
  const definition = { schemaVersion: 1, pass: 'volume', base, toolCommit: null, batches: [{ id: 'V01', area: 'src', files: ['src/a.cpp'], weight: 1, commentChars: 999, docs: [] }] };
  write(root, '.comment-tidy/config.json', JSON.stringify({ passes: { volume: { criteria: 'unused.md' } } }));
  write(root, '.comment-tidy/batches-volume.json', JSON.stringify(definition));
  return { root, base, definition, paths: batchPaths(root, 'volume', 'V01') };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('status コマンド', { timeout: 15000 }, () => {
  test('唯一の回を選び、未着手を示してファイルを書かない', async () => {
    const { root, paths } = makeRepo();
    const before = git(root, ['status', '--porcelain']);
    const result = capture();
    expect(await run(['status', '--repo', root], result.io)).toBe(0);
    expect(result.out[0]).toContain('| V01 | src | 未着手 | 6 | 未計測 |');
    expect(result.out[0]).toContain('次に渡せる束: V01');
    expect(fs.existsSync(paths.state)).toBe(false);
    expect(fs.existsSync(paths.worktree)).toBe(false);
    expect(git(root, ['status', '--porcelain'])).toBe(before);
  });
  test('基準SHAを固定し、束の作業ツリーでの変更を測る', async () => {
    const { root, base, paths } = makeRepo();
    git(root, ['worktree', 'add', '--detach', paths.worktree, base]);
    write(paths.worktree, 'src/a.cpp', '// a\nint a;\n');
    write(root, 'src/a.cpp', '// totally different\nint a;\n');
    git(root, ['add', 'src/a.cpp']);
    git(root, ['commit', '--quiet', '-m', '統合先']);
    const state = transitionState(transitionState(null, 'prepared', { pass: 'volume', batch: 'V01' }), 'delegated', { changes: { runId: 'run-xyz' } });
    write(root, path.relative(root, paths.state), JSON.stringify(state));
    const before = fs.readFileSync(paths.state, 'utf8');
    const result = capture();
    expect(await run(['status', '--repo', root, '--pass', 'volume'], result.io)).toBe(0);
    expect(result.out[0]).toContain('| 委譲中 | 6 | 3 | 50.0% |');
    expect(result.out[0]).toContain('run-xyz');
    expect(result.out[0]).toContain('次に渡せる束: なし');
    expect(fs.readFileSync(paths.state, 'utf8')).toBe(before);
    fs.unlinkSync(path.join(paths.worktree, 'src/a.cpp'));
    const missing = capture();
    expect(await run(['status', '--repo', root], missing.io)).toBe(0);
    expect(missing.out[0]).toContain('担当ファイル欠落');
  });
  test('取り込み済みは束の作業ツリーが消えても統合先から測る', async () => {
    const { root, paths } = makeRepo();
    let state = null;
    for (const status of ['prepared', 'delegated', 'reported', 'checked', 'applied']) state = transitionState(state, status, { pass: 'volume', batch: 'V01' });
    write(root, path.relative(root, paths.state), JSON.stringify(state));
    write(root, 'src/a.cpp', '// a\nint a;\n');
    const result = capture();
    expect(await run(['status', '--repo', root], result.io)).toBe(0);
    expect(result.out[0]).toContain('| 取り込み済み | 6 | 3 | 50.0% | 統合先 |');
    expect(result.out[0]).toContain('次に渡せる束: なし');
  });
  test('複数回は明示指定を求め、サブディレクトリと外部設定を受ける', async () => {
    const { root, definition } = makeRepo();
    write(root, '.comment-tidy/batches-other.json', JSON.stringify({ ...definition, pass: 'other' }));
    expect(await run(['status', '--repo', root], capture().io)).toBe(2);
    const external = path.join(root, 'external.json');
    write(root, 'external.json', JSON.stringify({ passes: { volume: { criteria: 'unused.md' } }, implementer: { agent: 'custom-agent', parallel: 1 } }));
    const result = capture();
    expect(await run(['status', '--repo', path.join(root, 'src'), '--config', external, '--pass', 'volume'], result.io)).toBe(0);
    expect(result.out[0]).toContain('custom-agent');
  });
  test('不明な版、壊れた状態、通常フォルダーをエラーにし標準出力を空に保つ', async () => {
    const { root, paths, definition } = makeRepo();
    for (const invalid of [JSON.stringify({ schemaVersion: 2 }), '{']) {
      write(root, path.relative(root, paths.state), invalid);
      const result = capture();
      expect(await run(['status', '--repo', root], result.io)).toBe(2);
      expect(result.out).toEqual([]);
    }
    fs.unlinkSync(paths.state);
    fs.mkdirSync(paths.worktree, { recursive: true });
    expect(await run(['status', '--repo', root], capture().io)).toBe(2);
    fs.rmdirSync(paths.worktree);
    write(root, '.comment-tidy/batches-volume.json', JSON.stringify({ ...definition, schemaVersion: 2 }));
    expect(await run(['status', '--repo', root], capture().io)).toBe(2);
  });
  test.each([['V01'], ['--json'], ['--repo'], ['--pass', '../bad'], ['--config', 'relative.json'], ['--pass', 'volume', '--pass', 'volume']])('不正な引数を拒否する: %j', async (...args) => {
    const result = capture();
    expect(await run(['status', ...args], result.io)).toBe(2);
    expect(result.out).toEqual([]);
  });
});
