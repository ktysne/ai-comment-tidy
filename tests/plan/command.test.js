import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EXIT_OK, EXIT_USAGE, run } from '../../src/cli.js';
import * as snapshotGit from '../../src/snapshot/git.js';

const roots = [];

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root, filePath, content) {
  const target = path.join(root, filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-plan-'));
  roots.push(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'plan@example.test']);
  git(root, ['config', 'user.name', 'Plan Test']);
  write(root, 'src/a.cpp', '// base\n');
  write(root, 'docs/05-example.md', '# 概要\n');
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', '基準']);
  const base = git(root, ['rev-parse', 'HEAD']);
  git(root, ['update-ref', 'refs/remotes/origin/main', base]);
  write(root, '.comment-tidy/config.json', JSON.stringify({ passes: { volume: { criteria: 'criteria-volume.md' } } }));
  return { root, base, outputPath: path.join(root, '.comment-tidy/batches-volume.json') };
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('plan コマンド', () => {
  test('既定の基準をSHAへ固定し、作業ツリーの変更を計画へ含めない', async () => {
    const { root, base, outputPath } = makeRepo();
    write(root, 'src/a.cpp', '// worktree\n// docs/05「概要」\n');
    write(root, 'src/untracked.cpp', '// added\n');
    const result = capture();
    expect(await run(['plan', 'volume', '--repo', root], result.io)).toBe(EXIT_OK);
    const definition = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(definition).toMatchObject({ schemaVersion: 1, pass: 'volume', base });
    expect(definition.toolCommit).toBe(git(path.resolve(import.meta.dirname, '../..'), ['rev-parse', 'HEAD']));
    expect(definition.batches[0]).toEqual({
      id: 'V01', area: 'src', files: ['src/a.cpp'], weight: 0.12, commentChars: 6, docs: [],
    });
    expect(result.out[0]).toContain(base);
    expect(result.out[0]).toMatch(/\d{4}-\d{2}-\d{2}T/);
    const original = fs.readFileSync(outputPath, 'utf8');
    expect(await run(['plan', 'volume', '--repo', root, '--force'], capture().io)).toBe(EXIT_OK);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(original);
  });

  test('--base と外部の --config で基準と回を指定する', async () => {
    const { root, base } = makeRepo();
    write(root, 'src/a.cpp', '// docs/05「概要」\n');
    git(root, ['add', 'src/a.cpp']);
    git(root, ['commit', '--quiet', '-m', '参照']);
    const latest = git(root, ['rev-parse', 'HEAD']);
    const configPath = path.join(root, 'custom.json');
    write(root, 'custom.json', JSON.stringify({ plan: { base }, passes: { history: { criteria: 'criteria-history.md' } } }));
    expect(await run(['plan', 'history', '--repo', root, '--config', configPath, '--base', 'HEAD'], capture().io)).toBe(EXIT_OK);
    const definition = JSON.parse(fs.readFileSync(path.join(root, '.comment-tidy/batches-history.json'), 'utf8'));
    expect(definition.base).toBe(latest);
    expect(definition.batches[0]).toMatchObject({ id: 'H01', docs: ['docs/05-example.md'] });
  });

  test('サブディレクトリの --repo もリポジトリのルートへ解決する', async () => {
    const { root, outputPath } = makeRepo();
    expect(await run(['plan', 'volume', '--repo', path.join(root, 'src')], capture().io)).toBe(EXIT_OK);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.existsSync(path.join(root, 'src/.comment-tidy'))).toBe(false);
  });

  test('既存の定義は --force 無しで変更せず、--force 付きなら置き換える', async () => {
    const { root, outputPath } = makeRepo();
    write(root, '.comment-tidy/batches-volume.json', '既存の定義\n');
    expect(await run(['plan', 'volume', '--repo', root], capture().io)).toBe(EXIT_USAGE);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('既存の定義\n');
    expect(await run(['plan', 'volume', '--repo', root, '--force'], capture().io)).toBe(EXIT_OK);
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8')).schemaVersion).toBe(1);
  });

  test('置き換えに失敗しても既存の定義を保持し、一時ファイルを残さない', async () => {
    const { root, outputPath } = makeRepo();
    write(root, '.comment-tidy/batches-volume.json', '元の定義\n');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('書き込み失敗'); });
    expect(await run(['plan', 'volume', '--repo', root, '--force'], capture().io)).toBe(EXIT_USAGE);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('元の定義\n');
    expect(fs.readdirSync(path.dirname(outputPath)).sort()).toEqual(['batches-volume.json', 'config.json']);
  });

  test('生成中に別の定義が作られても --force 無しでは上書きしない', async () => {
    const { root, outputPath } = makeRepo();
    const originalWrite = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((filePath, ...args) => {
      originalWrite(filePath, ...args);
      if (String(filePath).endsWith('.tmp')) originalWrite(outputPath, '別の定義\n');
    });
    expect(await run(['plan', 'volume', '--repo', root], capture().io)).toBe(EXIT_USAGE);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('別の定義\n');
    expect(fs.readdirSync(path.dirname(outputPath)).sort()).toEqual(['batches-volume.json', 'config.json']);
  });

  test('UTF-8で読めないファイルと領域の重複、未所属を標準エラーへ出す', async () => {
    const { root } = makeRepo();
    write(root, 'src/b.cpp', Buffer.from([0xff]));
    write(root, 'root.cpp', 'int a;');
    git(root, ['add', 'src/b.cpp', 'root.cpp']);
    git(root, ['commit', '--quiet', '-m', '警告用の入力']);
    write(root, '.comment-tidy/config.json', JSON.stringify({
      areas: { first: ['src/**'], second: ['src/**'] }, passes: { volume: { criteria: 'criteria-volume.md' } },
    }));
    const result = capture();
    expect(await run(['plan', 'volume', '--repo', root, '--base', 'HEAD'], result.io)).toBe(EXIT_OK);
    expect(result.err.join('\n')).toContain('src/b.cpp');
    expect(result.err.join('\n')).toContain('複数の領域');
    expect(result.err.join('\n')).toContain('どの領域にも');
  });

  test('道具のコミットが取得できなくても null を記録して生成する', async () => {
    const { root, outputPath } = makeRepo();
    const resolve = snapshotGit.resolveCommit;
    vi.spyOn(snapshotGit, 'resolveCommit').mockImplementation((repo, ref) => {
      if (repo !== root) throw new Error('道具の Git 情報がありません');
      return resolve(repo, ref);
    });
    expect(await run(['plan', 'volume', '--repo', root], capture().io)).toBe(EXIT_OK);
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8')).toolCommit).toBeNull();
  });

  test.each(['directory', 'definition'])('リンクの生成先を --force 付きでも無変更で拒否する: %s', async (kind) => {
    const { root, outputPath } = makeRepo();
    write(root, '.comment-tidy/batches-volume.json', '元の定義\n');
    const target = kind === 'directory' ? path.dirname(outputPath) : outputPath;
    const lstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
      if (filePath === target) return { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
      return lstat(filePath, ...args);
    });
    expect(await run(['plan', 'volume', '--repo', root, '--force'], capture().io)).toBe(EXIT_USAGE);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('元の定義\n');
    expect(fs.readdirSync(path.dirname(outputPath)).sort()).toEqual(['batches-volume.json', 'config.json']);
  });

  test.each([
    [], ['../volume'], ['unknown'], ['volume', '--base'], ['volume', '--base', 'missing'],
    ['volume', '--config', 'relative.json'], ['volume', '--force', '--force'], ['volume', '--unexpected'],
  ].map((args) => [args]))('引数や基準が不正なら定義を生成しない: %j', async (args) => {
    const { root, outputPath } = makeRepo();
    expect(await run(['plan', ...args, '--repo', root], capture().io)).toBe(EXIT_USAGE);
    expect(fs.existsSync(outputPath)).toBe(false);
  });
});
