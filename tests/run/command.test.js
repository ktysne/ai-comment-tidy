import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { run } from '../../src/cli.js';
import { batchPaths } from '../../src/paths.js';
import { readHashList, sha256 } from '../../src/snapshot/hash-list.js';
import { readState, transitionState } from '../../src/state.js';

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
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-run-'));
  roots.push(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'run@example.test']);
  git(root, ['config', 'user.name', 'Run Test']);
  git(root, ['config', 'core.autocrlf', 'true']);
  write(root, 'src/a.cpp', '// a\n// b\n// c\n// d\nint a;\n');
  write(root, 'src/b.cpp', 'int b;\n');
  write(root, 'src/space name.cpp', 'int c;\n');
  write(root, 'vendor/ignored.cpp', 'int ignored;\n');
  write(root, '.gitattributes', '*.cpp text eol=crlf\n');
  write(root, '.gitignore', '.comment-tidy/work/\n.comment-tidy/worktrees/\n');
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', '基準']);
  const base = git(root, ['rev-parse', 'HEAD']);
  const definition = { schemaVersion: 1, pass: 'volume', base, toolCommit: null, batches: [
    { id: 'V01', area: 'src', files: ['src/a.cpp'], weight: 1, commentChars: 10, docs: [] },
    { id: 'V02', area: 'src', files: ['src/b.cpp', 'src/space name.cpp'], weight: 1, commentChars: 0, docs: [] },
  ] };
  write(root, '.comment-tidy/config.json', JSON.stringify({ rulesPaths: ['~/rules.md'], scope: { include: ['src/**'] }, passes: { volume: { criteria: 'criteria-volume.md' } } }));
  write(root, '.comment-tidy/criteria-volume.md', criteria);
  write(root, '.comment-tidy/batches-volume.json', JSON.stringify(definition));
  return { root, base, definition, paths: batchPaths(root, 'volume', 'V01') };
}
function setState(root, paths, status) {
  let state = null;
  for (const next of ['prepared', 'delegated', 'reported', 'checked', 'applied']) {
    state = transitionState(state, next, { pass: 'volume', batch: 'V01', changes: { runId: 'run-old', notes: ['記録'], report: { needsDecision: [] } } });
    if (next === status) break;
  }
  write(root, path.relative(root, paths.state), JSON.stringify(state));
  return fs.readFileSync(paths.state, 'utf8');
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('run コマンド', { timeout: 20000 }, () => {
  test('複数束を基準から用意し、写しのCRLFと対象全体のハッシュを保存する', async () => {
    const { root, base, paths } = makeRepo();
    write(root, 'src/a.cpp', '// integration\nint a;\n');
    const result = capture();
    expect(await run(['run', 'V01', 'V02', '--repo', root], result.io)).toBe(0);
    expect(git(paths.worktree, ['rev-parse', 'HEAD'])).toBe(base);
    expect(git(paths.worktree, ['branch', '--show-current'])).toBe('');
    const content = fs.readFileSync(path.join(paths.worktree, 'src/a.cpp'));
    expect(content.toString()).toContain('\r\n');
    expect(fs.readFileSync(path.join(paths.baseline, 'src/a.cpp'))).toEqual(content);
    const hashes = readHashList(paths.hashes);
    expect(Object.keys(hashes.files)).toEqual(['src/a.cpp', 'src/b.cpp', 'src/space name.cpp']);
    expect(hashes.files['src/a.cpp']).toBe(sha256(content));
    expect(readState(root, 'volume', 'V01').status).toBe('prepared');
    expect(readState(root, 'volume', 'V02').status).toBe('prepared');
    expect(fs.readFileSync(paths.prompt, 'utf8')).toContain('新規の作業');
    expect(result.out).toHaveLength(2);
    write(paths.worktree, 'src/a.cpp', '// a\r\nint a;\r\n');
    const check = capture();
    expect(await run(['check', '--offline', '--repo', paths.worktree, '--base-dir', paths.baseline, '--hashes', paths.hashes,
      '--config', path.join(root, '.comment-tidy/config.json'), '--files', 'src/a.cpp'], check.io)).toBe(0);
    write(paths.worktree, 'src/b.cpp', 'int changed;\r\n');
    expect(await run(['check', '--offline', '--repo', paths.worktree, '--base-dir', paths.baseline, '--hashes', paths.hashes,
      '--config', path.join(root, '.comment-tidy/config.json'), '--files', 'src/a.cpp'], capture().io)).toBe(1);
  });
  test('再開は担当の変更を案内し、基準と状態を上書きしない', async () => {
    const { root, paths } = makeRepo();
    expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(0);
    write(paths.worktree, 'src/a.cpp', '// shorter\r\nint a;\r\n');
    const base = fs.readFileSync(path.join(paths.baseline, 'src/a.cpp'));
    const hashes = fs.readFileSync(paths.hashes);
    const state = setState(root, paths, 'reported');
    expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(0);
    expect(fs.readFileSync(paths.prompt, 'utf8')).toContain('変更あり: src/a.cpp');
    expect(fs.readFileSync(path.join(paths.baseline, 'src/a.cpp'))).toEqual(base);
    expect(fs.readFileSync(paths.hashes)).toEqual(hashes);
    expect(fs.readFileSync(paths.state, 'utf8')).toBe(state);
    fs.unlinkSync(path.join(paths.worktree, 'src/a.cpp'));
    expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(0);
    expect(fs.readFileSync(paths.prompt, 'utf8')).toContain('src/a.cpp: 欠落');
  });
  test('freshは指定した束だけを基準へ戻し、過去の検査と報告を消す', async () => {
    const { root, paths } = makeRepo();
    expect(await run(['run', 'V01', 'V02', '--repo', root], capture().io)).toBe(0);
    const other = batchPaths(root, 'volume', 'V02');
    write(other.worktree, 'src/b.cpp', 'int keep;\r\n');
    write(paths.worktree, 'src/a.cpp', 'int changed;\r\n');
    setState(root, paths, 'checked');
    write(root, path.relative(root, paths.report), '古い報告');
    write(root, path.relative(root, paths.check), '{}');
    expect(await run(['run', 'V01', '--repo', root, '--fresh'], capture().io)).toBe(0);
    expect(fs.readFileSync(path.join(paths.worktree, 'src/a.cpp'), 'utf8')).toContain('// a\r\n');
    expect(readState(root, 'volume', 'V01')).toMatchObject({ status: 'prepared', runId: null, notes: [], check: null, report: null });
    expect(fs.existsSync(paths.report)).toBe(false);
    expect(fs.existsSync(paths.check)).toBe(false);
    expect(fs.readFileSync(path.join(other.worktree, 'src/b.cpp'), 'utf8')).toBe('int keep;\r\n');
  });
  test.each(['delegated', 'applied'])('%sの束は通常実行もfreshも変更しない', async (status) => {
    const { root, paths } = makeRepo();
    expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(0);
    const state = setState(root, paths, status);
    const prompt = fs.readFileSync(paths.prompt);
    for (const flags of [[], ['--fresh']]) expect(await run(['run', 'V01', '--repo', root, ...flags], capture().io)).toBe(2);
    expect(fs.readFileSync(paths.state, 'utf8')).toBe(state);
    expect(fs.readFileSync(paths.prompt)).toEqual(prompt);
  });
  test('複数束の引数と細則を先に検証し、後の束の誤りでも最初の束を書かない', async () => {
    const { root, paths } = makeRepo();
    expect(await run(['run', 'V01', 'unknown', '--repo', root], capture().io)).toBe(2);
    expect(fs.existsSync(paths.worktree)).toBe(false);
    write(root, '.comment-tidy/criteria-volume.md', criteria.replace('## 目的', '## 目的\ngit を使う'));
    expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(2);
    expect(fs.existsSync(paths.worktree)).toBe(false);
  });
  test('欠けた準備や壊れた基準を再開時に取り直さずfreshを求める', async () => {
    const { root, paths } = makeRepo();
    expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(0);
    write(root, path.relative(root, path.join(paths.baseline, 'src/a.cpp')), '改変された基準');
    expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(2);
    expect(await run(['run', 'V01', '--fresh', '--repo', root], capture().io)).toBe(0);
    fs.unlinkSync(paths.state);
    expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(2);
    expect(await run(['run', 'V01', '--fresh', '--repo', root], capture().io)).toBe(0);
  });
  test('通常のフォルダーと別リポジトリをfreshでも削除しない', async () => {
    const { root, paths } = makeRepo();
    fs.mkdirSync(paths.worktree, { recursive: true });
    write(paths.worktree, 'keep.txt', '保護する');
    expect(await run(['run', 'V01', '--fresh', '--repo', root], capture().io)).toBe(2);
    expect(fs.readFileSync(path.join(paths.worktree, 'keep.txt'), 'utf8')).toBe('保護する');
    git(paths.worktree, ['init', '--quiet']);
    expect(await run(['run', 'V01', '--fresh', '--repo', root], capture().io)).toBe(2);
    expect(fs.readFileSync(path.join(paths.worktree, 'keep.txt'), 'utf8')).toBe('保護する');
  });
  test('保存失敗後は完了の状態を残さず、確認後のfreshで復旧する', async () => {
    const { root, paths } = makeRepo();
    const original = fs.renameSync;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === paths.prompt) throw new Error('保存失敗');
      return original(from, to);
    });
    expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(2);
    expect(fs.existsSync(paths.state)).toBe(false);
    expect(fs.existsSync(paths.worktree)).toBe(true);
    failure.mockRestore();
    expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(2);
    expect(await run(['run', 'V01', '--fresh', '--repo', root], capture().io)).toBe(0);
  });
  test('ブランチに移った作業ツリーと基準と異なるHEADは削除しない', async () => {
    const { root, paths } = makeRepo();
    expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(0);
    git(paths.worktree, ['switch', '-c', 'keep-branch']);
    expect(await run(['run', 'V01', '--fresh', '--repo', root], capture().io)).toBe(2);
    expect(git(paths.worktree, ['branch', '--show-current'])).toBe('keep-branch');
    git(paths.worktree, ['switch', '--detach']);
    write(paths.worktree, 'src/a.cpp', 'int changed;\r\n');
    git(paths.worktree, ['add', 'src/a.cpp']);
    git(paths.worktree, ['commit', '--quiet', '-m', '保存する変更']);
    expect(await run(['run', 'V01', '--fresh', '--repo', root], capture().io)).toBe(2);
    expect(fs.readFileSync(path.join(paths.worktree, 'src/a.cpp'), 'utf8')).toBe('int changed;\r\n');
  });
  test('設定の対象外になった担当ファイルは準備前に止める', async () => {
    const { root, paths } = makeRepo();
    const configPath = path.join(root, '.comment-tidy/config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.scope.include = ['other/**'];
    fs.writeFileSync(configPath, JSON.stringify(config));
    expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(2);
    expect(fs.existsSync(paths.worktree)).toBe(false);
  });
  test.each(['同じ設定', '外部設定'])('対象範囲を広げた%sでの再開はハッシュの補充や依頼文の更新をせず止める', async (mode) => {
    const { root, paths } = makeRepo();
    const configPath = path.join(root, '.comment-tidy/config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.scope.include = ['src/a.cpp'];
    fs.writeFileSync(configPath, JSON.stringify(config));
    expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(0);
    const hashes = fs.readFileSync(paths.hashes);
    const prompt = fs.readFileSync(paths.prompt);
    const state = fs.readFileSync(paths.state);
    write(paths.worktree, 'src/b.cpp', 'int changed;\r\n');
    config.scope.include = ['src/**'];
    const expanded = mode === '外部設定' ? path.join(root, 'expanded.json') : configPath;
    fs.writeFileSync(expanded, JSON.stringify(config));
    const result = capture();
    const args = ['run', 'V01', '--repo', root, '--config', expanded];
    expect(await run(args, result.io)).toBe(2);
    expect(result.err[0]).toContain('--fresh');
    expect(result.err[0]).toContain('src/b.cpp');
    expect(fs.readFileSync(paths.hashes)).toEqual(hashes);
    expect(fs.readFileSync(paths.prompt)).toEqual(prompt);
    expect(fs.readFileSync(paths.state)).toEqual(state);
    expect(await run([...args, '--fresh'], capture().io)).toBe(0);
    expect(Object.keys(readHashList(paths.hashes).files)).toContain('src/b.cpp');
    expect(fs.readFileSync(path.join(paths.worktree, 'src/b.cpp'), 'utf8')).toBe('int b;\r\n');
    expect(await run(args, capture().io)).toBe(0);
  });
  test('複数回の選択、サブディレクトリ、外部設定を受ける', async () => {
    const { root, definition } = makeRepo();
    write(root, '.comment-tidy/batches-other.json', JSON.stringify({ ...definition, pass: 'other' }));
    expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(2);
    const external = path.join(root, 'external.json');
    fs.copyFileSync(path.join(root, '.comment-tidy/config.json'), external);
    expect(await run(['run', 'V01', '--repo', path.join(root, 'src'), '--config', external, '--pass', 'volume'], capture().io)).toBe(0);
  });
  test.each([[], ['V01', 'V01'], ['--repo'], ['V01', '--config', 'relative.json'], ['V01', '--fresh', '--fresh'], ['../bad']])('不正な引数を拒否する: %j', async (...args) => {
    expect(await run(['run', ...args], capture().io)).toBe(2);
  });
});
