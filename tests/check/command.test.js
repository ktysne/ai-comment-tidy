import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { EXIT_USAGE, run } from '../../src/cli.js';
import { createHashList, writeHashList } from '../../src/snapshot/hash-list.js';

const roots = [];

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}
function replaceWithExternalJunction(directory, context) {
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-outside-'));
  roots.push(externalRoot);
  const externalDirectory = path.join(externalRoot, path.basename(directory));
  fs.renameSync(directory, externalDirectory);
  try { fs.symlinkSync(externalDirectory, directory, 'junction'); }
  catch (error) {
    fs.renameSync(externalDirectory, directory);
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { context.skip(`リンク作成不可: ${error.code}`); return false; }
    throw error;
  }
  return externalDirectory;
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-check-'));
  roots.push(root);
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'check@example.test']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Check Test']);
  execFileSync('git', ['-C', root, 'config', 'core.autocrlf', 'false']);
  return root;
}

function makeLegacyCheckout() {
  const root = makeRepo();
  write(root, '.gitattributes', '* text=auto\n');
  write(root, 'src/a.cpp', 'int value; // before\nint other;\n');
  write(root, 'docs/guide.md', '# Guide\n');
  const base = commitAll(root);
  execFileSync('git', ['-C', root, 'checkout', '--quiet', '--force', base, '--', '.']);
  execFileSync('git', ['-C', root, 'config', 'core.autocrlf', 'true']);
  return { root, base };
}

function write(root, filePath, contents) {
  const absolutePath = path.join(root, ...filePath.split('/'));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
}

function commitAll(root) {
  execFileSync('git', ['-C', root, 'add', '--all']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'base']);
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('check コマンドの引数', () => {
  test('--base と --files で Git の基準とコメントだけの変更を検査する', async () => {
    const root = makeRepo();
    write(root, 'src/a.cpp', 'int value; // before\n');
    const base = commitAll(root);
    write(root, 'src/a.cpp', 'int value; // after\n');
    const result = capture();

    expect(await run(['check', '--repo', root, '--base', base, '--files', 'src/a.cpp'], result.io)).toBe(0);
    expect(result.out[0]).toContain('check: 合格');
    expect(result.err).toEqual([]);
  });

  test('--offline と基準の写しとハッシュ一覧で検査する', async () => {
    const root = makeRepo();
    const baseDir = path.join(root, 'base-copy');
    fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
    write(baseDir, 'src/a.cpp', 'int value; // before\n');
    write(root, 'src/a.cpp', 'int value; // after\n');
    write(root, 'src/untouched.js', 'const value = 1;\n');
    const source = { 'src/untouched.js': fs.readFileSync(path.join(root, 'src', 'untouched.js')) };
    const hashesPath = path.join(root, 'hashes.json');
    writeHashList(hashesPath, createHashList({
      listFiles: () => Object.keys(source),
      readMany: (files) => new Map(files.map((filePath) => [filePath, source[filePath]])),
    }));
    const result = capture();

    expect(await run([
      'check', '--offline', '--repo', root, '--base-dir', baseDir, '--hashes', hashesPath, '--files', 'src/a.cpp',
    ], result.io)).toBe(0);
    expect(result.out[0]).toContain('check: 合格');
    expect(result.err).toEqual([]);
  });

  test('--offline --files は担当ファイルの親が外部ジャンクションなら内容を読まず終了コード2で止まる', async (context) => {
    const root = makeRepo();
    const baseDir = path.join(root, 'base-copy');
    write(baseDir, 'src/a.cpp', 'int value; // before\n');
    write(root, 'src/a.cpp', 'int value; // after\n');
    const hashesPath = path.join(root, 'hashes.json');
    const source = new Map([['src/a.cpp', Buffer.from('int value; // after\n')]]);
    writeHashList(hashesPath, createHashList({
      listFiles: () => [...source.keys()],
      readMany: (files) => new Map(files.map((filePath) => [filePath, source.get(filePath)])),
    }));
    const externalDirectory = replaceWithExternalJunction(path.join(root, 'src'), context);
    if (!externalDirectory) return;
    const result = capture();
    const read = vi.spyOn(fs, 'readFileSync');

    expect(await run([
      'check', '--offline', '--repo', root, '--base-dir', baseDir, '--hashes', hashesPath, '--files', 'src/a.cpp',
    ], result.io)).toBe(2);
    expect(result.err.join('\n')).toContain('担当ファイルの置き場にリンクか不正な要素があります: src/a.cpp');
    expect(result.out).toEqual([]);
    const targetPath = path.join(externalDirectory, 'a.cpp');
    expect(read.mock.calls.some(([file]) => typeof file === 'string' && path.resolve(file) === targetPath)).toBe(false);
  });

  test('--base --files は担当ファイルの親が外部ジャンクションなら内容を読まず終了コード2で止まる', async (context) => {
    const root = makeRepo();
    write(root, 'src/a.cpp', 'int value; // before\n');
    const base = commitAll(root);
    write(root, 'src/a.cpp', 'int value; // after\n');
    const externalDirectory = replaceWithExternalJunction(path.join(root, 'src'), context);
    if (!externalDirectory) return;
    const result = capture();
    const read = vi.spyOn(fs, 'readFileSync');

    expect(await run(['check', '--repo', root, '--base', base, '--files', 'src/a.cpp'], result.io)).toBe(2);
    expect(result.err.join('\n')).toContain('担当ファイルの置き場にリンクか不正な要素があります: src/a.cpp');
    expect(result.out).toEqual([]);
    const targetPath = path.join(externalDirectory, 'a.cpp');
    expect(read.mock.calls.some(([file]) => typeof file === 'string' && path.resolve(file) === targetPath)).toBe(false);
  });

  test('Git 経路の --out は検査結果を JSON で保存する', async () => {
    const root = makeRepo();
    write(root, 'src/a.cpp', 'int value; // before\n');
    const base = commitAll(root);
    write(root, 'src/a.cpp', 'int value; // after\n');
    const outputPath = path.join(root, 'check.json');
    const result = capture();

    expect(await run([
      'check', '--repo', root, '--base', base, '--files', 'src/a.cpp', '--out', outputPath,
    ], result.io)).toBe(0);
    const report = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(report).toMatchObject({ schemaVersion: 1, base, offline: false, ok: true, files: ['src/a.cpp'] });
    expect(result.out).toEqual([]);
  });

  test('--base も --offline も無ければ引数の誤りとして 2 で終える', async () => {
    const result = capture();

    expect(await run(['check', '--files', 'src/a.cpp'], result.io)).toBe(2);
    expect(result.err.join('\n')).toContain('--base');
  });

  test('--config は絶対パスを受け、設定範囲外のファイルを拒否する', async () => {
    const root = makeRepo();
    write(root, 'selected/a.cpp', 'int value; // before\n');
    write(root, 'outside/a.cpp', 'int value; // before\n');
    const base = commitAll(root);
    write(root, 'selected/a.cpp', 'int value; // after\n');
    const configPath = path.join(root, 'custom-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      scope: { include: ['selected/**'], exclude: [] },
    }), 'utf8');
    const accepted = capture();

    expect(await run([
      'check', '--repo', root, '--config', configPath, '--base', base, '--files', 'selected/a.cpp',
    ], accepted.io)).toBe(0);
    expect(accepted.out[0]).toContain('check: 合格');

    const excluded = capture();
    expect(await run([
      'check', '--repo', root, '--config', configPath, '--base', base, '--files', 'outside/a.cpp',
    ], excluded.io)).toBe(EXIT_USAGE);
    expect(excluded.err.join('\n')).toContain('設定の対象外');

    const relative = capture();
    expect(await run([
      'check', '--repo', root, '--config', 'relative.json', '--base', base, '--files', 'selected/a.cpp',
    ], relative.io)).toBe(EXIT_USAGE);
    expect(relative.err.join('\n')).toContain('--config には絶対パスを指定してください');
  });
});

describe('check --base の既存 LF チェックアウト', () => {
  test('担当コメントの変更を通し、git の差分には担当ファイルだけを返す', async () => {
    const { root, base } = makeLegacyCheckout();
    write(root, 'src/a.cpp', 'int value; // after\nint other;\n');
    const changedFiles = execFileSync('git', [
      '-C', root, 'diff', '--name-only', '--no-renames', '-z', base,
    ]).toString('utf8').split('\0').filter(Boolean);
    const result = capture();

    expect(changedFiles).toEqual(['src/a.cpp']);
    expect(fs.readFileSync(path.join(root, 'docs', 'guide.md'))).toEqual(Buffer.from('# Guide\n'));
    expect(await run(['check', '--repo', root, '--base', base, '--files', 'src/a.cpp'], result.io)).toBe(0);
    expect(result.out[0]).toContain('check: 合格');
  });

  test('担当外の内容が変わると out-of-scope-change で不合格にする', async () => {
    const { root, base } = makeLegacyCheckout();
    write(root, 'docs/guide.md', '# Changed\n');
    const result = capture();

    expect(await run(['check', '--repo', root, '--base', base, '--files', 'src/a.cpp'], result.io)).toBe(1);
    expect(result.out.join('\n')).toContain('docs/guide.md [out-of-scope-change]');
  });

  test('未追跡ファイルを担当外の変更として扱わない', async () => {
    const { root, base } = makeLegacyCheckout();
    write(root, 'docs/new.md', '# New\n');
    const result = capture();

    expect(await run(['check', '--repo', root, '--base', base, '--files', 'src/a.cpp'], result.io)).toBe(0);
    expect(result.out[0]).toContain('check: 合格');
  });

  test('CRLF と LF が混在する担当ファイルを line-ending で不合格にする', async () => {
    const { root, base } = makeLegacyCheckout();
    write(root, 'src/a.cpp', Buffer.from('int value; // before\r\nint other;\n'));
    const result = capture();

    expect(await run(['check', '--repo', root, '--base', base, '--files', 'src/a.cpp'], result.io)).toBe(1);
    expect(result.out.join('\n')).toContain('src/a.cpp [line-ending]');
  });
});
