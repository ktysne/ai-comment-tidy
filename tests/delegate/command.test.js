import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { run } from '../../src/cli.js';
import { batchPaths } from '../../src/paths.js';
import { readState, transitionState } from '../../src/state.js';

const roots = [];
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
function makeRepo(status = 'prepared') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-delegate-'));
  roots.push(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'delegate@example.test']);
  git(root, ['config', 'user.name', 'Delegate Test']);
  write(root, 'src/a.cpp', 'int a;\n');
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', '基準']);
  const definition = { schemaVersion: 1, pass: 'volume', base: git(root, ['rev-parse', 'HEAD']), toolCommit: null,
    batches: [{ id: 'V01', area: 'src', files: ['src/a.cpp'], weight: 1, commentChars: 0, docs: [] }] };
  write(root, '.comment-tidy/config.json', JSON.stringify({ passes: { volume: { criteria: 'unused.md' } } }));
  write(root, '.comment-tidy/batches-volume.json', JSON.stringify(definition));
  const paths = batchPaths(root, 'volume', 'V01');
  let state = null;
  if (status !== null) {
    for (const next of ['prepared', 'delegated', 'reported', 'checked', 'applied']) {
      state = transitionState(state, next, { pass: 'volume', batch: 'V01', now: '2026-10-07T00:00:00Z' });
      if (next === status) break;
    }
    write(root, path.relative(root, paths.state), JSON.stringify(state));
  }
  return { root, paths, definition };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('delegate コマンド', { timeout: 20000 }, () => {
  test('runで用意した束の作業ツリーと基準を変更せず委譲と取消を記録する', async () => {
    const { root, paths } = makeRepo(null);
    write(root, '.comment-tidy/config.json', JSON.stringify({ rulesPaths: ['~/rules.md'], passes: { volume: { criteria: 'criteria-volume.md' } } }));
    write(root, '.comment-tidy/criteria-volume.md', fs.readFileSync(new URL('../../templates/criteria.md', import.meta.url), 'utf8'));
    expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(0);
    const files = [path.join(paths.worktree, 'src/a.cpp'), path.join(paths.baseline, 'src/a.cpp'), paths.hashes, paths.prompt];
    const before = files.map((file) => fs.readFileSync(file));
    expect(await run(['delegate', 'V01', '--repo', root], capture().io)).toBe(0);
    expect(await run(['delegate', 'V01', '--repo', root, '--run-id', 'run-real'], capture().io)).toBe(0);
    expect(await run(['delegate', 'V01', '--repo', root, '--cancel'], capture().io)).toBe(0);
    expect(files.map((file) => fs.readFileSync(file))).toEqual(before);
  });
  test('委譲の記録、後からのID追記、status、取消を通す', async () => {
    const { root, paths } = makeRepo();
    const result = capture();
    expect(await run(['delegate', 'V01', '--repo', root], result.io)).toBe(0);
    const delegated = readState(root, 'volume', 'V01');
    expect(delegated).toMatchObject({ status: 'delegated', runId: null });
    expect(result.out[0]).toContain('実行 ID: 未記録');
    expect(await run(['delegate', 'V01', '--repo', root, '--run-id', 'run-123'], capture().io)).toBe(0);
    const recorded = readState(root, 'volume', 'V01');
    expect(recorded.runId).toBe('run-123');
    expect(recorded.timestamps).toEqual(delegated.timestamps);
    const status = capture();
    expect(await run(['status', '--repo', root], status.io)).toBe(0);
    expect(status.out[0]).toContain('run-123');
    expect(status.out[0]).toContain('次に渡せる束: なし');
    expect(await run(['delegate', 'V01', '--repo', root, '--cancel'], capture().io)).toBe(0);
    expect(readState(root, 'volume', 'V01')).toMatchObject({ status: 'prepared', runId: null, check: null, report: null, notes: [] });
    expect(fs.existsSync(paths.worktree)).toBe(false);
    expect(fs.readFileSync(path.join(root, 'src/a.cpp'), 'utf8')).toBe('int a;\n');
    expect(await run(['delegate', 'V01', '--repo', root, '--run-id', 'run-456'], capture().io)).toBe(0);
    expect(readState(root, 'volume', 'V01').runId).toBe('run-456');
  });
  test('同じIDの再記録は許し、別IDへの置き換えや再委譲は記録を保持して拒否する', async () => {
    const { root, paths } = makeRepo();
    expect(await run(['delegate', 'V01', '--repo', root, '--run-id', 'run-123'], capture().io)).toBe(0);
    const before = fs.readFileSync(paths.state, 'utf8');
    expect(await run(['delegate', 'V01', '--repo', root, '--run-id', 'run-123'], capture().io)).toBe(0);
    expect(fs.readFileSync(paths.state, 'utf8')).toBe(before);
    for (const flags of [[], ['--run-id', 'run-other']]) {
      expect(await run(['delegate', 'V01', '--repo', root, ...flags], capture().io)).toBe(2);
      expect(fs.readFileSync(paths.state, 'utf8')).toBe(before);
    }
  });
  test.each([null, 'reported', 'checked', 'applied'])('%sからの委譲と取消は状態を書かず拒否する', async (status) => {
    const { root, paths } = makeRepo(status);
    const before = fs.existsSync(paths.state) ? fs.readFileSync(paths.state) : null;
    for (const flags of [[], ['--run-id', 'run-123'], ['--cancel']]) {
      const result = capture();
      expect(await run(['delegate', 'V01', '--repo', root, ...flags], result.io)).toBe(2);
      expect(result.out).toEqual([]);
    }
    expect(fs.existsSync(paths.state) ? fs.readFileSync(paths.state) : null).toEqual(before);
  });
  test('用意済みからの取消は状態を保持する', async () => {
    const { root, paths } = makeRepo();
    const before = fs.readFileSync(paths.state);
    expect(await run(['delegate', 'V01', '--repo', root, '--cancel'], capture().io)).toBe(2);
    expect(fs.readFileSync(paths.state)).toEqual(before);
  });
  test('複数回の明示選択とサブディレクトリ、外部設定を受ける', async () => {
    const { root, definition } = makeRepo();
    write(root, '.comment-tidy/batches-other.json', JSON.stringify({ ...definition, pass: 'other' }));
    expect(await run(['delegate', 'V01', '--repo', root], capture().io)).toBe(2);
    const external = path.join(root, 'external.json');
    fs.copyFileSync(path.join(root, '.comment-tidy/config.json'), external);
    expect(await run(['delegate', 'V01', '--repo', path.join(root, 'src'), '--config', external, '--pass', 'volume'], capture().io)).toBe(0);
  });
  test('保存失敗時は既存の状態を保持し、成功を出さない', async () => {
    const { root, paths } = makeRepo();
    const before = fs.readFileSync(paths.state);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('保存失敗'); });
    const result = capture();
    expect(await run(['delegate', 'V01', '--repo', root], result.io)).toBe(2);
    expect(result.out).toEqual([]);
    expect(fs.readFileSync(paths.state)).toEqual(before);
  });
  test('壊れた状態、未知の版、未知の束、設定にない回を変更せず拒否する', async () => {
    const { root, paths, definition } = makeRepo();
    for (const invalid of ['{', JSON.stringify({ schemaVersion: 2 })]) {
      fs.writeFileSync(paths.state, invalid);
      expect(await run(['delegate', 'V01', '--repo', root], capture().io)).toBe(2);
      expect(fs.readFileSync(paths.state, 'utf8')).toBe(invalid);
    }
    expect(await run(['delegate', 'unknown', '--repo', root], capture().io)).toBe(2);
    write(root, '.comment-tidy/batches-volume.json', JSON.stringify({ ...definition, schemaVersion: 2 }));
    expect(await run(['delegate', 'V01', '--repo', root], capture().io)).toBe(2);
    write(root, '.comment-tidy/batches-volume.json', JSON.stringify(definition));
    write(root, '.comment-tidy/config.json', '{}');
    expect(await run(['delegate', 'V01', '--repo', root], capture().io)).toBe(2);
  });
  test.each([[], ['V01', 'V02'], ['V01', '--run-id'], ['V01', '--run-id', ' '], ['V01', '--run-id', 'a\nb'],
    ['V01', '--cancel', '--run-id', 'run-1'], ['V01', '--cancel', '--cancel'], ['V01', '--config', 'relative.json'],
    ['V01', '--pass', '../bad'], ['V01', '--unknown'], ['V01', '--run-id', 'a', '--run-id', 'b']])('不正な引数を拒否する: %j', async (...args) => {
    const result = capture();
    expect(await run(['delegate', ...args], result.io)).toBe(2);
    expect(result.out).toEqual([]);
  });
});
