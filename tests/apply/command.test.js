import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { run } from '../../src/cli.js';
import { batchPaths } from '../../src/paths.js';
import { readState } from '../../src/state.js';

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
async function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-batch-check-'));
  roots.push(root);
  git(root, ['init', '--quiet', '-b', 'main']);
  git(root, ['config', 'user.email', 'check@example.test']);
  git(root, ['config', 'user.name', 'Check Test']);
  git(root, ['config', 'core.autocrlf', 'true']);
  write(root, 'src/a.cpp', '// 一\n// 二\n// 三\n// 四\nint a;\n');
  write(root, 'src/b.cpp', 'int b;\n');
  write(root, '.gitattributes', '*.cpp text eol=crlf\n');
  write(root, '.gitignore', '.comment-tidy/work/\n.comment-tidy/worktrees/\n');
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', '基準']);
  const base = git(root, ['rev-parse', 'HEAD']);
  const definition = { schemaVersion: 1, pass: 'volume', base, toolCommit: null,
    batches: [{ id: 'V01', area: 'src', files: ['src/a.cpp'], weight: 1, commentChars: 12, docs: [] }] };
  write(root, '.comment-tidy/config.json', JSON.stringify({ rulesPaths: ['~/rules.md'], scope: { include: ['src/**'] }, passes: { volume: { criteria: 'criteria-volume.md' } } }));
  write(root, '.comment-tidy/batches-volume.json', JSON.stringify(definition));
  write(root, '.comment-tidy/criteria-volume.md', fs.readFileSync(new URL('../../templates/criteria.md', import.meta.url), 'utf8'));
  const paths = batchPaths(root, 'volume', 'V01');
  expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(0);
  expect(await run(['delegate', 'V01', '--repo', root, '--run-id', 'run-1'], capture().io)).toBe(0);
  write(root, 'final.md', '報告の本文');
  expect(await run(['report', 'V01', path.join(root, 'final.md'), '--repo', root], capture().io)).toBe(0);
  write(paths.worktree, 'src/a.cpp', '// 一\r\nint a;\r\n');
  git(root, ['switch', '-c', 'integration']);
  git(root, ['checkout', '--', 'src/a.cpp']);
  expect(await run(['check', 'V01', '--repo', root], capture().io)).toBe(0);
  return { root, paths, base, definition };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('検査済みの束の取り込み', { timeout: 20000 }, () => {
  test('全工程を通りCRLFを保って担当だけを写し、コミットは行わない', async () => {
    const { root, paths, base } = await makeRepo();
    write(root, 'src/b.cpp', 'int integration;\r\n');
    const before = readState(root, 'volume', 'V01');
    const result = capture();
    expect(await run(['apply', 'V01', '--repo', root], result.io)).toBe(0);
    expect(fs.readFileSync(path.join(root, 'src/a.cpp'))).toEqual(fs.readFileSync(path.join(paths.worktree, 'src/a.cpp')));
    expect(fs.readFileSync(path.join(root, 'src/b.cpp'), 'utf8')).toBe('int integration;\r\n');
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(base);
    expect(readState(root, 'volume', 'V01')).toMatchObject({ status: 'applied', runId: before.runId, report: before.report, notes: before.notes });
    expect(result.out[0]).toContain('取り込み済み');
    expect(await run(['apply', 'V01', '--repo', root], capture().io)).toBe(2);
  });
  test.each([null, false])('状態名が検査済みでも合格が%sなら拒否する', async (ok) => {
    const { root, paths } = await makeRepo();
    const state = readState(root, 'volume', 'V01');
    state.check = ok === null ? null : { ...state.check, ok };
    fs.writeFileSync(paths.state, JSON.stringify(state));
    const before = fs.readFileSync(path.join(root, 'src/a.cpp'));
    expect(await run(['apply', 'V01', '--repo', root], capture().io)).toBe(2);
    expect(fs.readFileSync(path.join(root, 'src/a.cpp'))).toEqual(before);
  });
  test.each(['main', 'detached', 'diverged', 'committed', 'dirty', 'staged', 'hidden'])('統合先の%sを拒否して担当を保持する', async (kind) => {
    const { root, base } = await makeRepo();
    if (kind === 'main') git(root, ['switch', 'main']);
    if (kind === 'detached') git(root, ['checkout', '--detach']);
    if (kind === 'diverged') {
      git(root, ['checkout', '--orphan', 'unrelated']);
      git(root, ['add', '--all']);
      git(root, ['commit', '--quiet', '-m', '別の起点']);
    }
    if (['committed', 'dirty', 'staged', 'hidden'].includes(kind)) write(root, 'src/a.cpp', 'int other;\r\n');
    if (kind === 'hidden') git(root, ['update-index', '--assume-unchanged', 'src/a.cpp']);
    if (['committed', 'staged'].includes(kind)) git(root, ['add', 'src/a.cpp']);
    if (kind === 'committed') git(root, ['commit', '--quiet', '-m', '担当の変更']);
    const before = fs.readFileSync(path.join(root, 'src/a.cpp'));
    expect(await run(['apply', 'V01', '--repo', root], capture().io)).toBe(2);
    expect(fs.readFileSync(path.join(root, 'src/a.cpp'))).toEqual(before);
    expect(readState(root, 'volume', 'V01').status).toBe('checked');
    expect(base).toBeTruthy();
  });
  test.each(['src/a.cpp', 'src/b.cpp'])('検査後の%sの改変は再検査で拒否し古い合格を無効にする', async (file) => {
    const { root, paths } = await makeRepo();
    write(paths.worktree, file, 'int different;\r\n');
    const before = fs.readFileSync(path.join(root, 'src/a.cpp'));
    expect(await run(['apply', 'V01', '--repo', root], capture().io)).toBe(1);
    expect(fs.readFileSync(path.join(root, 'src/a.cpp'))).toEqual(before);
    expect(readState(root, 'volume', 'V01')).toMatchObject({ status: 'checked', check: { ok: false } });
  });
  test('取り込み済みの状態保存が失敗したら担当を復元し再実行できる', async () => {
    const { root, paths } = await makeRepo();
    const before = fs.readFileSync(path.join(root, 'src/a.cpp'));
    const original = fs.renameSync;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === paths.state && JSON.parse(fs.readFileSync(from, 'utf8')).status === 'applied') throw new Error('保存失敗');
      return original(from, to);
    });
    expect(await run(['apply', 'V01', '--repo', root], capture().io)).toBe(2);
    expect(fs.readFileSync(path.join(root, 'src/a.cpp'))).toEqual(before);
    expect(readState(root, 'volume', 'V01').status).toBe('checked');
    failure.mockRestore();
    expect(await run(['apply', 'V01', '--repo', root], capture().io)).toBe(0);
  });
  test('複数担当の途中の書き込み失敗は書き込んだ担当を復元する', async () => {
    const { root, paths, definition } = await makeRepo();
    definition.batches[0].files.push('src/b.cpp');
    write(root, '.comment-tidy/batches-volume.json', JSON.stringify(definition));
    expect(await run(['check', 'V01', '--repo', root], capture().io)).toBe(0);
    const before = fs.readFileSync(path.join(root, 'src/a.cpp'));
    const original = fs.writeFileSync;
    let failed = false;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (file === path.join(root, 'src/b.cpp') && !failed) { failed = true; throw new Error('書き込み失敗'); }
      return original(file, ...args);
    });
    expect(await run(['apply', 'V01', '--repo', root], capture().io)).toBe(2);
    expect(fs.readFileSync(path.join(root, 'src/a.cpp'))).toEqual(before);
    expect(readState(root, 'volume', 'V01').status).toBe('checked');
    expect(fs.existsSync(paths.state)).toBe(true);
  });
  test('基準より後の担当外のコミットを許し外部設定と回を受ける', async () => {
    const { root } = await makeRepo();
    write(root, 'src/b.cpp', 'int later;\r\n');
    git(root, ['add', 'src/b.cpp']);
    git(root, ['commit', '--quiet', '-m', '担当外']);
    const config = path.join(root, 'external.json');
    fs.copyFileSync(path.join(root, '.comment-tidy/config.json'), config);
    expect(await run(['apply', 'V01', '--pass', 'volume', '--repo', path.join(root, 'src'), '--config', config], capture().io)).toBe(0);
    expect(fs.readFileSync(path.join(root, 'src/b.cpp'), 'utf8')).toBe('int later;\r\n');
  });
  test('担当外とのハードリンクを拒否し双方の内容を保持する', async () => {
    const { root } = await makeRepo();
    const assigned = path.join(root, 'src/a.cpp');
    const outside = path.join(root, 'linked.cpp');
    fs.linkSync(assigned, outside);
    const before = fs.readFileSync(assigned);
    expect(await run(['apply', 'V01', '--repo', root], capture().io)).toBe(2);
    expect(fs.readFileSync(assigned)).toEqual(before);
    expect(fs.readFileSync(outside)).toEqual(before);
    expect(readState(root, 'volume', 'V01').status).toBe('checked');
  });
  test.each([[], ['V01', 'V02'], ['V01', '--commit'], ['V01', '--offline'], ['V01', '--config', 'relative.json'], ['V01', '--pass', '../bad']])('不正な引数を拒否する: %j', async (...args) => {
    expect(await run(['apply', ...args], capture().io)).toBe(2);
  });
});
