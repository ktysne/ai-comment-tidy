import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { createGitSnapshot, resolveCommit } from '../../src/snapshot/git.js';

const roots = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-snapshot-'));
  roots.push(root);
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'snapshot@example.test']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Snapshot Test']);
  execFileSync('git', ['-C', root, 'config', 'core.autocrlf', 'true']);
  return root;
}

function write(root, filePath, content) {
  const absolutePath = path.join(root, ...filePath.split('/'));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function commitAll(root) {
  execFileSync('git', ['-C', root, 'add', '--all']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'base']);
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Git の時点の読み取り', () => {
  test('コミットの読み取りは text=auto と core.autocrlf による CRLF 変換を通す', () => {
    const root = makeRepo();
    write(root, '.gitattributes', '*.cpp text=auto\n');
    write(root, 'src/file name.cpp', Buffer.from('// committed\r\n', 'utf8'));
    const commit = commitAll(root);
    const worktreeContent = fs.readFileSync(path.join(root, 'src', 'file name.cpp'));
    const snapshot = createGitSnapshot(root, resolveCommit(root, commit));

    expect(worktreeContent.includes(Buffer.from('\r\n'))).toBe(true);
    expect(snapshot.listFiles()).toContain('src/file name.cpp');
    expect(snapshot.has('src/file name.cpp')).toBe(true);
    expect(snapshot.read('src/file name.cpp')).toEqual(worktreeContent);
  });

  test('コミットから複数のファイルをまとめて読み、空のファイルと末尾の改行が無いファイルを切り分ける', () => {
    const root = makeRepo();
    write(root, '.gitattributes', '*.cpp text=auto\n');
    write(root, 'a.cpp', '// a\n// a2\n');
    write(root, 'empty.cpp', '');
    write(root, 'tail.cpp', '// no newline');
    const commit = commitAll(root);
    const snapshot = createGitSnapshot(root, resolveCommit(root, commit));

    const contents = snapshot.readMany(['a.cpp', 'empty.cpp', 'tail.cpp']);

    expect(contents.get('a.cpp')).toEqual(Buffer.from('// a\r\n// a2\r\n', 'utf8'));
    expect(contents.get('empty.cpp')).toEqual(Buffer.alloc(0));
    expect(contents.get('tail.cpp')).toEqual(Buffer.from('// no newline', 'utf8'));
  });

  test('コミットのシンボリックリンクを一覧から除く', () => {
    const root = makeRepo();
    write(root, 'target.cpp', '// target\n');
    execFileSync('git', ['-C', root, 'add', 'target.cpp']);
    const linkObject = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'target.cpp' }).toString('utf8').trim();
    execFileSync('git', ['-C', root, 'update-index', '--add', '--cacheinfo', `120000,${linkObject},link.cpp`]);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'link']);

    const snapshot = createGitSnapshot(root, resolveCommit(root, 'HEAD'));

    expect(snapshot.listFiles()).toEqual(['target.cpp']);
    expect(snapshot.has('link.cpp')).toBe(false);
  });

  test('作業ツリーのシンボリックリンクを一覧から除く', (context) => {
    const root = makeRepo();
    write(root, 'target.cpp', '// target\n');
    try {
      fs.symlinkSync('target.cpp', path.join(root, 'link.cpp'), 'file');
    } catch {
      context.skip();
    }

    const snapshot = createGitSnapshot(root);

    expect(snapshot.listFiles()).toEqual(['target.cpp']);
  });

  test('作業ツリーの一覧は未追跡ファイルを含み、削除済みファイルを除く', () => {
    const root = makeRepo();
    write(root, '.gitignore', 'ignored.cpp\n');
    write(root, 'tracked.cpp', '// base\n');
    write(root, 'deleted.cpp', '// base\n');
    commitAll(root);
    fs.rmSync(path.join(root, 'deleted.cpp'));
    write(root, 'new file.cpp', '// worktree\r\n');
    write(root, 'ignored.cpp', '// ignored\n');

    const snapshot = createGitSnapshot(root);

    expect(snapshot.listFiles()).toContain('new file.cpp');
    expect(snapshot.listFiles()).not.toContain('deleted.cpp');
    expect(snapshot.listFiles()).not.toContain('ignored.cpp');
    expect(snapshot.has('new file.cpp')).toBe(true);
    expect(snapshot.read('new file.cpp')).toEqual(Buffer.from('// worktree\r\n', 'utf8'));
    expect(snapshot.has('deleted.cpp')).toBe(false);
  });
});
