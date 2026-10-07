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
async function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-batch-check-'));
  roots.push(root);
  git(root, ['init', '--quiet']);
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
  return { root, paths, base, definition };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('束を取るcheck', { timeout: 20000 }, () => {
  test('報告ありから検査済みへ進め、束と回を含む結果を保存する', async () => {
    const { root, paths, base } = await makeRepo();
    write(root, 'src/a.cpp', 'int integration;\n');
    const result = capture();
    expect(await run(['check', 'V01', '--repo', root], result.io)).toBe(0);
    expect(result.out[0]).toContain('check: 合格');
    const check = JSON.parse(fs.readFileSync(paths.check, 'utf8'));
    const state = readState(root, 'volume', 'V01');
    expect(check).toMatchObject({ pass: 'volume', batch: 'V01', base, offline: false, ok: true });
    expect(state.status).toBe('checked');
    expect(state.check).toEqual(check);
    expect(state.timestamps.checked).toBe(check.checkedAt);
    expect(state.runId).toBe('run-1');
    expect(state.notes).toContain('監査行なし');
    expect(await run(['check', 'V01', '--repo', root], capture().io)).toBe(0);
  });
  test('不合格は報告ありを保ち、修正後の再実行だけが検査済みへ進む', async () => {
    const { root, paths } = await makeRepo();
    write(paths.worktree, 'src/a.cpp', 'int changed;\r\n');
    expect(await run(['check', 'V01', '--repo', root], capture().io)).toBe(1);
    expect(readState(root, 'volume', 'V01')).toMatchObject({ status: 'reported', check: { ok: false } });
    write(paths.worktree, 'src/a.cpp', '// 一\r\nint a;\r\n');
    expect(await run(['check', 'V01', '--repo', root], capture().io)).toBe(0);
    expect(readState(root, 'volume', 'V01').status).toBe('checked');
  });
  test('検査済みでの不合格は状態名と時刻を保ち、古い合格結果を置き換える', async () => {
    const { root, paths } = await makeRepo();
    expect(await run(['check', 'V01', '--repo', root], capture().io)).toBe(0);
    const before = readState(root, 'volume', 'V01');
    write(paths.worktree, 'src/b.cpp', 'int other;\r\n');
    expect(await run(['check', 'V01', '--repo', root], capture().io)).toBe(1);
    const after = readState(root, 'volume', 'V01');
    expect(after.status).toBe('checked');
    expect(after.timestamps).toEqual(before.timestamps);
    expect(after.check.ok).toBe(false);
    expect(after.check.failures.some((item) => item.check === 'out-of-scope-change')).toBe(true);
  });
  test('offlineは委譲中にも使え、検査結果と状態を更新しない', async () => {
    const { root, paths } = await makeRepo();
    const delegated = transitionState(transitionState(null, 'prepared', { pass: 'volume', batch: 'V01' }), 'delegated');
    fs.writeFileSync(paths.state, JSON.stringify(delegated));
    write(root, path.relative(root, paths.check), '変更しない');
    const before = fs.readFileSync(paths.state);
    expect(await run(['check', 'V01', '--offline', '--repo', root], capture().io)).toBe(0);
    expect(fs.readFileSync(paths.state)).toEqual(before);
    expect(fs.readFileSync(paths.check, 'utf8')).toBe('変更しない');
    write(paths.worktree, 'src/b.cpp', 'int other;\r\n');
    expect(await run(['check', 'V01', '--offline', '--repo', root], capture().io)).toBe(1);
    expect(fs.readFileSync(paths.state)).toEqual(before);
  });
  test('offlineは基準の写しの改変を拒否し、結果を書かない', async () => {
    const { root, paths } = await makeRepo();
    write(paths.baseline, 'src/a.cpp', 'int different;\r\n');
    expect(await run(['check', 'V01', '--offline', '--repo', root], capture().io)).toBe(2);
    expect(fs.existsSync(paths.check)).toBe(false);
  });
  test.each([null, 'prepared', 'delegated', 'applied'])('%sからの通常検査は保存前に拒否する', async (status) => {
    const { root, paths } = await makeRepo();
    if (status === null) fs.unlinkSync(paths.state);
    else {
      let state = null;
      for (const next of ['prepared', 'delegated', 'reported', 'checked', 'applied']) {
        state = transitionState(state, next, { pass: 'volume', batch: 'V01' });
        if (next === status) break;
      }
      fs.writeFileSync(paths.state, JSON.stringify(state));
    }
    const before = fs.existsSync(paths.state) ? fs.readFileSync(paths.state) : null;
    expect(await run(['check', 'V01', '--repo', root], capture().io)).toBe(2);
    expect(fs.existsSync(paths.check)).toBe(false);
    expect(fs.existsSync(paths.state) ? fs.readFileSync(paths.state) : null).toEqual(before);
  });
  test('再検査の保存失敗でも以前の合格結果を状態に残さず、再実行で復旧する', async () => {
    const { root, paths } = await makeRepo();
    expect(await run(['check', 'V01', '--repo', root], capture().io)).toBe(0);
    write(paths.worktree, 'src/a.cpp', 'int different;\r\n');
    const original = fs.renameSync;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === paths.check) throw new Error('保存失敗');
      return original(from, to);
    });
    const result = capture();
    expect(await run(['check', 'V01', '--repo', root], result.io)).toBe(2);
    expect(result.out).toEqual([]);
    expect(readState(root, 'volume', 'V01')).toMatchObject({ status: 'checked', check: null });
    failure.mockRestore();
    expect(await run(['check', 'V01', '--repo', root], capture().io)).toBe(1);
    expect(readState(root, 'volume', 'V01').check.ok).toBe(false);
  });
  test('複数回は明示選択し、通常検査はサブディレクトリと外部設定を受ける', async () => {
    const { root, definition } = await makeRepo();
    write(root, '.comment-tidy/batches-other.json', JSON.stringify({ ...definition, pass: 'other' }));
    expect(await run(['check', 'V01', '--repo', root], capture().io)).toBe(2);
    const config = path.join(root, 'external.json');
    fs.copyFileSync(path.join(root, '.comment-tidy/config.json'), config);
    expect(await run(['check', 'V01', '--pass', 'volume', '--repo', path.join(root, 'src'), '--config', config], capture().io)).toBe(0);
  });
  test('結果保存後の状態保存失敗は合格を無効のまま保ち、再検査で復旧する', async () => {
    const { root, paths } = await makeRepo();
    expect(await run(['check', 'V01', '--repo', root], capture().io)).toBe(0);
    const original = fs.renameSync;
    let stateWrites = 0;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === paths.state && ++stateWrites === 2) throw new Error('状態保存失敗');
      return original(from, to);
    });
    const result = capture();
    expect(await run(['check', 'V01', '--repo', root], result.io)).toBe(2);
    expect(result.out).toEqual([]);
    expect(JSON.parse(fs.readFileSync(paths.check, 'utf8')).ok).toBe(true);
    expect(readState(root, 'volume', 'V01').check).toBeNull();
    failure.mockRestore();
    expect(await run(['check', 'V01', '--repo', root], capture().io)).toBe(0);
    expect(readState(root, 'volume', 'V01').check.ok).toBe(true);
  });
  test('未知の版と異なる作業ツリーは結果を書かず拒否する', async () => {
    const { root, paths, definition } = await makeRepo();
    write(root, '.comment-tidy/batches-volume.json', JSON.stringify({ ...definition, schemaVersion: 2 }));
    expect(await run(['check', 'V01', '--repo', root], capture().io)).toBe(2);
    write(root, '.comment-tidy/batches-volume.json', JSON.stringify(definition));
    git(paths.worktree, ['switch', '-c', 'keep']);
    expect(await run(['check', 'V01', '--repo', root], capture().io)).toBe(2);
    expect(fs.existsSync(paths.check)).toBe(false);
  });
  test.each([['V01', '--base', 'HEAD'], ['V01', '--files', 'a.cpp'], ['V01', '--out', 'out.json'], ['V01', '--base-dir', 'base'],
    ['V01', '--offline', '--hashes', 'hashes'], ['V01', '--pass', '../bad'], ['V01', 'V02'], ['--pass', 'volume', '--base', 'HEAD', '--files', 'a.cpp']])('束と明示指定の併用を拒否する: %j', async (...args) => {
    expect(await run(['check', ...args], capture().io)).toBe(2);
  });
});
