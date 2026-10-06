import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { run } from '../../src/cli.js';
import { batchPaths } from '../../src/paths.js';
import { readState, transitionState } from '../../src/state.js';

const roots = [];
const value = { docsCandidates: [{ file: 'src/a.cpp', lines: '1-2', summary: '資料へ移す' }], needsDecision: [], codeImprovements: [] };
const text = `codex-agent: agent=impl-standard\ncodex-agent: run=run-1\n## やったこと\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\ncodex-agent: result=ok\n`;
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
function makeRepo(status = 'delegated') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-report-'));
  roots.push(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'report@example.test']);
  git(root, ['config', 'user.name', 'Report Test']);
  write(root, 'src/a.cpp', '// 一\n// 二\nint a;\n');
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', '基準']);
  const definition = { schemaVersion: 1, pass: 'volume', base: git(root, ['rev-parse', 'HEAD']), toolCommit: null,
    batches: [{ id: 'V01', area: 'src', files: ['src/a.cpp'], weight: 1, commentChars: 6, docs: [] }] };
  write(root, '.comment-tidy/config.json', JSON.stringify({ passes: { volume: { criteria: 'unused.md' } } }));
  write(root, '.comment-tidy/batches-volume.json', JSON.stringify(definition));
  const paths = batchPaths(root, 'volume', 'V01');
  let state = null;
  if (status !== null) {
    for (const next of ['prepared', 'delegated', 'reported', 'checked', 'applied']) {
      state = transitionState(state, next, { pass: 'volume', batch: 'V01', changes: { runId: 'run-1' } });
      if (next === status) break;
    }
    write(root, path.relative(root, paths.state), JSON.stringify(state));
  }
  const input = path.join(root, 'final report.md');
  fs.writeFileSync(input, text);
  return { root, paths, input, definition };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('report コマンド', { timeout: 20000 }, () => {
  test('runとdelegateで用意した束へ報告を取り込んでも作業ツリーと基準を変更しない', async () => {
    const { root, paths, input } = makeRepo(null);
    write(root, '.comment-tidy/config.json', JSON.stringify({ rulesPaths: ['~/rules.md'], passes: { volume: { criteria: 'criteria-volume.md' } } }));
    write(root, '.comment-tidy/criteria-volume.md', fs.readFileSync(new URL('../../templates/criteria.md', import.meta.url), 'utf8'));
    expect(await run(['run', 'V01', '--repo', root], capture().io)).toBe(0);
    expect(await run(['delegate', 'V01', '--repo', root, '--run-id', 'run-1'], capture().io)).toBe(0);
    const files = [path.join(paths.worktree, 'src/a.cpp'), path.join(paths.baseline, 'src/a.cpp'), paths.hashes, paths.prompt];
    const before = files.map((file) => fs.readFileSync(file));
    expect(await run(['report', 'V01', input, '--repo', root], capture().io)).toBe(0);
    expect(readState(root, 'volume', 'V01').status).toBe('reported');
    expect(files.map((file) => fs.readFileSync(file))).toEqual(before);
  });
  test('報告をそのまま保存し、基準の行番号を確認してstatusに候補を出す', async () => {
    const { root, paths, input } = makeRepo();
    const bytes = Buffer.from(`\ufeff${text.replaceAll('\n', '\r\n')}`);
    fs.writeFileSync(input, bytes);
    write(root, 'src/a.cpp', 'int changed;\n');
    const before = readState(root, 'volume', 'V01');
    expect(await run(['report', 'V01', input, '--repo', root], capture().io)).toBe(0);
    expect(fs.readFileSync(paths.report)).toEqual(bytes);
    const state = readState(root, 'volume', 'V01');
    expect(state).toMatchObject({ status: 'reported', runId: 'run-1', report: value, notes: [] });
    expect(state.timestamps.delegated).toBe(before.timestamps.delegated);
    const status = capture();
    expect(await run(['status', '--repo', root], status.io)).toBe(0);
    expect(status.out[0]).toContain('資料へ移す');
    expect(fs.readFileSync(path.join(root, 'src/a.cpp'), 'utf8')).toBe('int changed;\n');
  });
  test('JSONと監査行のない報告は記録付きで受け付ける', async () => {
    const { root, input } = makeRepo();
    fs.writeFileSync(input, '報告の本文');
    expect(await run(['report', 'V01', input, '--repo', root], capture().io)).toBe(0);
    expect(readState(root, 'volume', 'V01')).toMatchObject({ status: 'reported', report: null, notes: ['監査行なし', '報告の JSON なし'] });
  });
  test.each([null, 'prepared', 'reported', 'checked', 'applied'])('%sの束の報告は保存せず拒否する', async (state) => {
    const { root, paths, input } = makeRepo(state);
    const before = fs.existsSync(paths.state) ? fs.readFileSync(paths.state) : null;
    expect(await run(['report', 'V01', input, '--repo', root], capture().io)).toBe(2);
    expect(fs.existsSync(paths.report)).toBe(false);
    expect(fs.existsSync(paths.state) ? fs.readFileSync(paths.state) : null).toEqual(before);
  });
  test.each(['```json\n{\n```', text.replace('run=run-1', 'run=wrong'), text.replace('1-2', '1-9'), Buffer.from([0xff])])('不正な入力は既存の報告と状態を変更しない', async (content) => {
    const { root, paths, input } = makeRepo();
    write(root, path.relative(root, paths.report), '保存済みの報告');
    const state = fs.readFileSync(paths.state);
    fs.writeFileSync(input, content);
    const result = capture();
    expect(await run(['report', 'V01', input, '--repo', root], result.io)).toBe(2);
    expect(result.out).toEqual([]);
    expect(fs.readFileSync(paths.report, 'utf8')).toBe('保存済みの報告');
    expect(fs.readFileSync(paths.state)).toEqual(state);
  });
  test('報告保存失敗は状態を保持し、状態保存失敗は再取り込みで復旧できる', async () => {
    const { root, paths, input } = makeRepo();
    const before = fs.readFileSync(paths.state);
    const original = fs.renameSync;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === paths.report) throw new Error('報告保存失敗');
      return original(from, to);
    });
    expect(await run(['report', 'V01', input, '--repo', root], capture().io)).toBe(2);
    expect(fs.existsSync(paths.report)).toBe(false);
    expect(fs.readFileSync(paths.state)).toEqual(before);
    failure.mockImplementation((from, to) => {
      if (to === paths.state) throw new Error('状態保存失敗');
      return original(from, to);
    });
    const result = capture();
    expect(await run(['report', 'V01', input, '--repo', root], result.io)).toBe(2);
    expect(result.out).toEqual([]);
    expect(fs.readFileSync(paths.state)).toEqual(before);
    failure.mockRestore();
    expect(await run(['report', 'V01', input, '--repo', root], capture().io)).toBe(0);
  });
  test('複数回の指定、外部設定、サブディレクトリからの呼び出しを受ける', async () => {
    const { root, input, definition } = makeRepo();
    write(root, '.comment-tidy/batches-other.json', JSON.stringify({ ...definition, pass: 'other' }));
    expect(await run(['report', 'V01', input, '--repo', root], capture().io)).toBe(2);
    const config = path.join(root, 'external.json');
    fs.copyFileSync(path.join(root, '.comment-tidy/config.json'), config);
    expect(await run(['report', 'V01', input, '--repo', path.join(root, 'src'), '--pass', 'volume', '--config', config], capture().io)).toBe(0);
  });
  test('未知の版、壊れた状態、存在しない入力ファイルを保存前に拒否する', async () => {
    const { root, input, paths } = makeRepo();
    expect(await run(['report', 'V01', `${input}.missing`, '--repo', root], capture().io)).toBe(2);
    fs.writeFileSync(paths.state, '{');
    expect(await run(['report', 'V01', input, '--repo', root], capture().io)).toBe(2);
    write(root, '.comment-tidy/batches-volume.json', JSON.stringify({ schemaVersion: 2 }));
    expect(await run(['report', 'V01', input, '--repo', root], capture().io)).toBe(2);
    expect(fs.existsSync(paths.report)).toBe(false);
  });
  test.each([[], ['V01'], ['V01', 'file', 'extra'], ['V01', 'file', '--repo'], ['V01', 'file', '--config', 'relative.json'],
    ['V01', 'file', '--pass', '../bad'], ['V01', 'file', '--unknown'], ['V01', 'file', '--pass', 'a', '--pass', 'b']])('不正な引数を拒否する: %j', async (...args) => {
    expect(await run(['report', ...args], capture().io)).toBe(2);
  });
});
