import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { run } from '../../src/cli.js';
import { batchPaths } from '../../src/paths.js';
import { readState, transitionState, writeState } from '../../src/state.js';
import { listWorktreeRegistrations } from '../../src/snapshot/worktree.js';
import * as worktrees from '../../src/snapshot/worktree.js';

const roots = [];
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function write(root, file, contents) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}
async function command(root, ...args) {
  const out = [], err = [];
  const code = await run([...args, '--repo', root], { stdout: text => out.push(text), stderr: text => err.push(text) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
async function fixture({ applied = true, submodule = false, materializedLink = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-clean-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'clean@example.test');
  git(root, 'config', 'user.name', 'Clean Test');
  git(root, 'config', 'core.autocrlf', 'true');
  write(root, '.gitattributes', '*.js text eol=crlf\n');
  write(root, '.gitignore', '.comment-tidy/work/\n.comment-tidy/worktrees/\n*.ignored\n');
  write(root, 'src/空 白.js', '\uFEFF// 理由\r\nexport const a = 1;\r\n');
  write(root, 'src/b.js', 'export const b = 2;\r\n');
  write(root, 'outside.js', 'export const outside = 3;\r\n');
  git(root, 'add', '--all');
  if (materializedLink) {
    git(root, 'config', 'core.symlinks', 'false');
    const objectId = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'outside.js', encoding: 'utf8' }).trim();
    git(root, 'update-index', '--add', '--cacheinfo', `120000,${objectId},materialized-link`);
  }
  git(root, 'commit', '-qm', '基準');
  if (submodule) {
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${git(root, 'rev-parse', 'HEAD')},module`);
    git(root, 'commit', '-qm', 'サブモジュール');
  }
  const base = git(root, 'rev-parse', 'HEAD');
  write(root, '.comment-tidy/config.json', JSON.stringify({ rulesPaths: ['~/rules.md'], scope: { include: ['src/**'] }, passes: { volume: { criteria: 'criteria-volume.md' } } }));
  write(root, '.comment-tidy/criteria-volume.md', fs.readFileSync(new URL('../../templates/criteria.md', import.meta.url)));
  const definition = { schemaVersion: 1, pass: 'volume', base, toolCommit: null, batches: [
    { id: 'V01', area: 'src', files: ['src/空 白.js'], weight: 1, commentChars: 2, docs: [] },
    { id: 'V02', area: 'src', files: ['src/b.js'], weight: 1, commentChars: 0, docs: [] },
  ] };
  write(root, '.comment-tidy/batches-volume.json', JSON.stringify(definition));
  const prepared = await command(root, 'run', 'V01', 'V02');
  expect(prepared.err).toBe('');
  expect(prepared.code).toBe(0);
  const paths = batchPaths(root, 'volume', 'V01');
  const second = batchPaths(root, 'volume', 'V02');
  if (applied) {
    let state = readState(root, 'volume', 'V01');
    for (const status of ['delegated', 'reported', 'checked', 'applied']) {
      state = transitionState(state, status);
      writeState(root, 'volume', 'V01', state);
    }
  }
  return { root, paths, second, base, definition };
}
function registered(root, target) {
  return listWorktreeRegistrations(root).some(item => path.relative(item.directory, target) === '');
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('束の作業ツリーの片付け', { timeout: 20000 }, () => {
  test('取り込み済みだけを削除し証拠と他の束を保持し再実行できる', async () => {
    const { root, paths, second } = await fixture();
    write(paths.worktree, 'src/空 白.js', '\uFEFFexport const a = 1;\r\n');
    const state = fs.readFileSync(paths.state);
    const baseline = fs.readFileSync(path.join(paths.baseline, 'src/空 白.js'));
    const result = await command(root, 'clean');
    expect(result).toMatchObject({ code: 0, err: '' });
    expect(fs.existsSync(paths.worktree)).toBe(false);
    expect(registered(root, paths.worktree)).toBe(false);
    expect(fs.existsSync(second.worktree)).toBe(true);
    expect(fs.readFileSync(paths.state)).toEqual(state);
    expect(fs.readFileSync(path.join(paths.baseline, 'src/空 白.js'))).toEqual(baseline);
    expect(fs.existsSync(paths.hashes)).toBe(true);
    expect(fs.existsSync(paths.prompt)).toBe(true);
    expect((await command(root, 'clean')).code).toBe(0);
  });
  test('dry-runは対象と状態を表示し作業ツリーと登録と状態を変えない', async () => {
    const { root, paths } = await fixture();
    const before = fs.readFileSync(paths.state);
    expect(await command(root, 'clean', '--dry-run')).toMatchObject({ code: 0, err: '' });
    expect(registered(root, paths.worktree)).toBe(true);
    expect(fs.readFileSync(paths.state)).toEqual(before);
    expect(fs.existsSync(path.join(paths.worktree, 'src/空 白.js'))).toBe(true);
  });
  test('全工程から片付けまで通し報告と検査結果を残す', async () => {
    const { root, paths } = await fixture({ applied: false });
    git(root, 'switch', '-c', 'integration');
    expect((await command(root, 'delegate', 'V01')).code).toBe(0);
    write(root, 'report.md', '報告\n```json\n{"docsCandidates":[],"needsDecision":[],"codeImprovements":[]}\n```');
    write(paths.worktree, 'src/空 白.js', '\uFEFFexport const a = 1;\r\n');
    expect((await command(root, 'report', 'V01', path.join(root, 'report.md'))).code).toBe(0);
    expect((await command(root, 'check', 'V01')).code).toBe(0);
    expect((await command(root, 'apply', 'V01')).code).toBe(0);
    expect((await command(root, 'clean', 'V01')).code).toBe(0);
    expect(readState(root, 'volume', 'V01').status).toBe('applied');
    expect(fs.existsSync(paths.check)).toBe(true);
    expect(fs.existsSync(paths.report)).toBe(true);
    expect(fs.readFileSync(path.join(root, 'src/空 白.js'), 'utf8')).toBe('\uFEFFexport const a = 1;\r\n');
  });
  test('forceでも束の指定省略時は未取り込みを選ばず明示した束だけ削除する', async () => {
    const { root, paths, second } = await fixture({ applied: false });
    expect((await command(root, 'clean', '--force')).out).toContain('対象なし');
    expect((await command(root, 'clean', 'V01')).code).toBe(2);
    expect((await command(root, 'clean', 'V01', '--force')).code).toBe(0);
    expect(fs.existsSync(paths.worktree)).toBe(false);
    expect(fs.existsSync(second.worktree)).toBe(true);
  });
  test.each(['delegated', 'missing-state', 'unknown-schema'])('%sの束はforceでも削除しない', async kind => {
    const { root, paths } = await fixture({ applied: false });
    if (kind === 'delegated') writeState(root, 'volume', 'V01', transitionState(readState(root, 'volume', 'V01'), 'delegated'));
    if (kind === 'missing-state') fs.unlinkSync(paths.state);
    if (kind === 'unknown-schema') write(root, path.relative(root, paths.state), '{"schemaVersion":2}');
    expect((await command(root, 'clean', 'V01', '--force')).code).toBe(2);
    expect(registered(root, paths.worktree)).toBe(true);
  });
  test.each(['dirty', 'staged', 'untracked', 'ignored', 'hidden', 'deleted', 'renamed', 'mode'])('担当外の%sをforceとdry-runでも拒否する', async kind => {
    const { root, paths } = await fixture();
    if (['dirty', 'staged', 'hidden'].includes(kind)) write(paths.worktree, 'outside.js', 'export const changed = 4;\r\n');
    if (kind === 'staged') git(paths.worktree, 'add', 'outside.js');
    if (kind === 'hidden') git(paths.worktree, 'update-index', '--assume-unchanged', 'outside.js');
    if (kind === 'untracked') write(paths.worktree, 'new.txt', '外の作業');
    if (kind === 'ignored') write(paths.worktree, 'new.ignored', '無視された作業');
    if (kind === 'deleted') fs.unlinkSync(path.join(paths.worktree, 'outside.js'));
    if (kind === 'renamed') git(paths.worktree, 'mv', 'outside.js', 'renamed.js');
    if (kind === 'mode') git(paths.worktree, 'update-index', '--chmod=+x', 'outside.js');
    expect((await command(root, 'clean', 'V01', '--force', '--dry-run')).code).toBe(2);
    expect((await command(root, 'clean', 'V01', '--force')).code).toBe(2);
    expect(fs.existsSync(path.join(paths.worktree, 'src/空 白.js'))).toBe(true);
  });
  test('サブモジュールを持つ作業ツリーは削除しない', async () => {
    const { root, paths } = await fixture({ submodule: true });
    expect((await command(root, 'clean', 'V01', '--force')).code).toBe(2);
    expect(fs.existsSync(paths.worktree)).toBe(true);
  });
  test('core.symlinks=falseの通常ファイルとして置かれた追跡リンクを扱う', async () => {
    const { root, paths } = await fixture({ materializedLink: true });
    expect(fs.readFileSync(path.join(paths.worktree, 'materialized-link'), 'utf8')).toBe('outside.js');
    expect((await command(root, 'clean', 'V01')).code).toBe(0);
    expect(fs.existsSync(path.join(root, 'outside.js'))).toBe(true);
  });
  test.for(['root', 'parent'])('作業ツリーの%sのジャンクションをたどらない', async (kind, context) => {
    const { root, paths } = await fixture();
    const source = kind === 'root' ? paths.worktree : path.dirname(paths.worktree);
    const saved = path.join(root, 'relocated');
    fs.renameSync(source, saved);
    try { fs.symlinkSync(saved, source, 'junction'); }
    catch (error) {
      fs.renameSync(saved, source);
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { context.skip(`リンク作成不可: ${error.code}`); return; }
      throw error;
    }
    expect((await command(root, 'clean', 'V01', '--force')).code).toBe(2);
    expect(fs.existsSync(path.join(saved, kind === 'root' ? 'src/空 白.js' : 'V01/src/空 白.js'))).toBe(true);
  });
  test.each(['branch', 'head', 'locked', 'nested', 'foreign'])('%sの作業ツリーを拒否する', async kind => {
    const { root, paths } = await fixture();
    if (kind === 'branch') git(paths.worktree, 'switch', '-c', 'other');
    if (kind === 'head') { git(paths.worktree, 'commit', '--allow-empty', '-qm', '別のHEAD'); }
    if (kind === 'locked') git(root, 'worktree', 'lock', paths.worktree);
    if (kind === 'nested') git(paths.worktree, 'init', '-q', 'nested');
    if (kind === 'foreign') {
      git(root, 'worktree', 'remove', '--force', paths.worktree);
      fs.mkdirSync(paths.worktree, { recursive: true });
      git(paths.worktree, 'init', '-q');
    }
    expect((await command(root, 'clean', 'V01', '--force')).code).toBe(2);
    expect(fs.existsSync(paths.worktree)).toBe(true);
  });
  test('後の束の確認が失敗したら前の束も削除しない', async () => {
    const { root, paths, second } = await fixture();
    write(second.worktree, 'foreign.txt', '作業');
    expect((await command(root, 'clean', 'V01', 'V02', '--force')).code).toBe(2);
    expect(registered(root, paths.worktree)).toBe(true);
    expect(fs.existsSync(paths.worktree)).toBe(true);
  });
  test('担当の削除とステージ済み変更は受け付ける', async () => {
    const { root, paths } = await fixture();
    git(paths.worktree, 'rm', 'src/空 白.js');
    expect((await command(root, 'clean', 'V01')).code).toBe(0);
  });
  test('作業ツリーがなく登録だけ残る場合は対象の登録だけ削除する', async () => {
    const { root, paths, second } = await fixture();
    fs.rmSync(paths.worktree, { recursive: true });
    expect(registered(root, paths.worktree)).toBe(true);
    expect((await command(root, 'clean', 'V01')).code).toBe(0);
    expect(registered(root, paths.worktree)).toBe(false);
    expect(registered(root, second.worktree)).toBe(true);
  });
  test('登録のない空の残留ディレクトリを削除できる', async () => {
    const { root, paths } = await fixture();
    git(root, 'worktree', 'remove', '--force', paths.worktree);
    fs.mkdirSync(path.join(paths.worktree, 'empty'), { recursive: true });
    expect((await command(root, 'clean', 'V01')).code).toBe(0);
    expect(fs.existsSync(paths.worktree)).toBe(false);
  });
  test('空のディレクトリだけ残る場合は成功として登録の有無を表示し再実行できる', async () => {
    const { root, paths } = await fixture();
    const failure = vi.spyOn(worktrees, 'removeBatchWorktree').mockImplementation(() => { throw new Error('ディレクトリ使用中'); });
    const original = fs.rmdirSync;
    const blocked = vi.spyOn(fs, 'rmdirSync').mockImplementation(target => {
      if (target === paths.worktree || target.startsWith(paths.worktree + path.sep)) {
        throw Object.assign(new Error('使用中'), { code: 'EBUSY' });
      }
      return original(target);
    });
    const result = await command(root, 'clean', 'V01');
    expect(result.code).toBe(0);
    expect(result.out).toContain('空のディレクトリが残っています');
    expect(result.out).toContain('Git の登録: あり');
    expect(fs.existsSync(path.join(paths.worktree, '.git'))).toBe(false);
    expect(readState(root, 'volume', 'V01').status).toBe('applied');
    failure.mockRestore(); blocked.mockRestore();
    expect((await command(root, 'clean', 'V01')).code).toBe(0);
    expect(registered(root, paths.worktree)).toBe(false);
  });
  test.skipIf(process.platform !== 'win32')('別プロセスが使用する空のディレクトリを報告し終了後に片付けられる', async context => {
    const { root, paths } = await fixture();
    const child = spawn(process.execPath, ['-e', 'const timer=setInterval(()=>{},1000);process.stdin.once("data",()=>{clearInterval(timer);process.exit(0);});process.stdout.write("ready");'],
      { cwd: path.join(paths.worktree, 'src'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise(resolve => child.once('exit', resolve));
    try {
      await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
      const result = await command(root, 'clean', 'V01');
      expect(result.code).toBe(0);
      if (!fs.existsSync(paths.worktree)) { context.skip('この環境ではプロセスの作業場所が削除を妨げない'); return; }
      expect(result.out).toContain('空のディレクトリが残っています');
      child.stdin.write('stop');
      await exited;
      expect((await command(root, 'clean', 'V01')).code).toBe(0);
      expect(fs.existsSync(paths.worktree)).toBe(false);
      expect(registered(root, paths.worktree)).toBe(false);
    } finally { if (child.exitCode === null) { child.kill(); await exited; } }
  });
  test('削除後に空かどうか確認できないときは失敗を返す', async () => {
    const { root, paths } = await fixture();
    let failed = false;
    vi.spyOn(worktrees, 'removeBatchWorktree').mockImplementation(() => { failed = true; throw new Error('削除失敗'); });
    const original = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation((target, ...args) => {
      if (failed && target === paths.worktree) throw Object.assign(new Error('読めない'), { code: 'EACCES' });
      return original(target, ...args);
    });
    expect((await command(root, 'clean', 'V01')).code).toBe(2);
  });
  test('外部設定とサブディレクトリのrepoを受け未知の回や複数回の省略は拒否する', async () => {
    const { root, paths, definition } = await fixture();
    const config = JSON.parse(fs.readFileSync(path.join(root, '.comment-tidy/config.json')));
    config.passes.other = { criteria: 'criteria-volume.md' };
    write(root, '.comment-tidy/config.json', JSON.stringify(config));
    write(root, '.comment-tidy/batches-other.json', JSON.stringify({ ...definition, pass: 'other' }));
    expect((await command(root, 'clean')).code).toBe(2);
    expect((await command(root, 'clean', '--pass', 'missing')).code).toBe(2);
    const external = path.join(root, 'external.json');
    write(root, 'external.json', JSON.stringify(config));
    expect(await run(['clean', 'V01', '--pass', 'volume', '--repo', path.join(root, 'src'), '--config', external], { stdout: () => {}, stderr: () => {} })).toBe(0);
    expect(fs.existsSync(paths.worktree)).toBe(false);
  });
  test.for(['junction', 'file', 'broken', 'broken-junction'])('内部の%sリンクだけ解除し外部の内容を残す', async (kind, context) => {
    const { root, paths } = await fixture();
    const outside = path.join(root, 'external');
    write(root, 'external/data.txt', '外部データ');
    const link = path.join(paths.worktree, 'src/空 白.js');
    fs.unlinkSync(link);
    try {
      fs.symlinkSync(kind === 'file' ? path.join(outside, 'data.txt') : kind.startsWith('broken') ? path.join(outside, 'missing') : outside,
        link, kind.includes('junction') ? 'junction' : 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { context.skip(`リンク作成不可: ${error.code}`); return; }
      throw error;
    }
    const dry = await command(root, 'clean', 'V01', '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('解除するリンク:');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect((await command(root, 'clean', 'V01')).code).toBe(0);
    expect(fs.readFileSync(path.join(outside, 'data.txt'), 'utf8')).toBe('外部データ');
  });
  test('内部リンクの解除失敗では通常ファイルの削除を始めない', async context => {
    const { root, paths } = await fixture();
    const link = path.join(paths.worktree, 'src/空 白.js');
    fs.unlinkSync(link);
    try { fs.symlinkSync(path.join(root, 'external'), link, 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { context.skip(`リンク作成不可: ${error.code}`); return; }
      throw error;
    }
    const original = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(target => {
      if (target === link) throw new Error('リンク解除失敗');
      return original(target);
    });
    const result = await command(root, 'clean', 'V01');
    expect(result.code).toBe(2);
    expect(result.err).toContain('リンク解除失敗');
    expect(fs.existsSync(path.join(paths.worktree, 'outside.js'))).toBe(true);
  });
  test('削除途中の失敗では削除済みと未処理の束を返す', async () => {
    const { root, paths, second } = await fixture();
    const original = fs.unlinkSync;
    const failure = vi.spyOn(fs, 'unlinkSync').mockImplementation(target => {
      if (target === path.join(second.worktree, 'src/b.js')) throw new Error('削除失敗');
      return original(target);
    });
    const result = await command(root, 'clean', 'V01', 'V02', '--force');
    expect(result.code).toBe(2);
    expect(result.err).toContain('削除済み: V01');
    expect(result.err).toContain('未処理: なし');
    expect(fs.existsSync(paths.worktree)).toBe(false);
    expect(fs.existsSync(second.worktree)).toBe(true);
    failure.mockRestore();
    expect((await command(root, 'clean', 'V01', 'V02', '--force')).code).toBe(0);
    expect(fs.existsSync(second.worktree)).toBe(false);
    expect(registered(root, second.worktree)).toBe(false);
  });
  test.each([false, true])('統合先の属性が異なっていても対象側の改行を検査する: 変更=%s', async changed => {
    const { root, paths } = await fixture();
    write(root, '.gitattributes', '*.js text eol=lf\n');
    if (changed) write(paths.worktree, 'outside.js', 'export const outside = 3;\n');
    const result = await command(root, 'clean', 'V01');
    expect(result.code).toBe(changed ? 2 : 0);
    expect(fs.existsSync(paths.worktree)).toBe(changed);
  });
  test.each(['content', 'missing', 'type', 'ignored'])('途中失敗後でも担当外の新しい%sを拒否する', async kind => {
    const { root, paths } = await fixture();
    const target = path.join(paths.worktree, 'outside.js');
    const original = fs.unlinkSync;
    const failure = vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (file === target) throw new Error('削除失敗');
      return original(file);
    });
    expect((await command(root, 'clean', 'V01')).code).toBe(2);
    failure.mockRestore();
    if (kind === 'content') write(paths.worktree, 'outside.js', 'export const outside = 3;\n');
    if (kind === 'missing') fs.unlinkSync(path.join(paths.worktree, 'src/b.js'));
    if (kind === 'type') { fs.unlinkSync(target); fs.mkdirSync(target); }
    if (kind === 'ignored') write(paths.worktree, 'later.ignored', '別の作業');
    expect((await command(root, 'clean', 'V01', '--force')).code).toBe(2);
    expect(fs.existsSync(path.join(paths.worktree, 'src/空 白.js'))).toBe(true);
  });
  test('削除直後の記録失敗でも再開し担当外の残存バイト列を検査する', async () => {
    const { root, paths } = await fixture();
    const target = path.join(paths.worktree, '.gitattributes');
    const original = fs.unlinkSync;
    const failure = vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      original(file);
      if (file === target) throw new Error('削除後の中断');
    });
    expect((await command(root, 'clean', 'V01')).code).toBe(2);
    failure.mockRestore();
    write(root, '.gitattributes', '*.js text eol=lf\n');
    expect((await command(root, 'clean', 'V01')).code).toBe(0);
    expect(fs.existsSync(paths.worktree)).toBe(false);
  });
  test('runで作り直した束は過去の削除記録を使わない', async () => {
    const { root, paths } = await fixture({ applied: false });
    expect((await command(root, 'clean', 'V01', '--force')).code).toBe(0);
    expect((await command(root, 'run', 'V01', '--fresh')).code).toBe(0);
    fs.unlinkSync(path.join(paths.worktree, 'outside.js'));
    expect((await command(root, 'clean', 'V01', '--force')).code).toBe(2);
  });
  test.each([['V01', 'V01'], ['V99'], ['--pass', '../bad'], ['--force', '--force'], ['--dry-run', '--dry-run'], ['--unknown'], ['--config', 'relative.json']])('不正な引数では書き込まない: %j', async (...args) => {
    const { root, paths } = await fixture();
    expect((await command(root, 'clean', ...args)).code).toBe(2);
    expect(registered(root, paths.worktree)).toBe(true);
  });
});
