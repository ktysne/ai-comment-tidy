import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { EXIT_OK, EXIT_USAGE, run } from '../../src/cli.js';

const roots = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-init-'));
  roots.push(root);
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  return root;
}

function writeFile(root, filePath, content = '') {
  const absolutePath = path.join(root, ...filePath.split('/'));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
  return absolutePath;
}

function track(root, filePaths) {
  execFileSync('git', ['-C', root, 'add', '--', ...filePaths]);
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('init', () => {
  test.each([false, true])('サブディレクトリからの実行でもルートへ生成する (--repo: %s)', async (explicitRepo) => {
    const root = makeRoot();
    writeFile(root, 'src/main.cpp', 'int main() {}\n');
    track(root, ['src/main.cpp']);
    const result = capture();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(path.join(root, 'src'));
    try {
      expect(await run(['init', ...(explicitRepo ? ['--repo', path.join(root, 'src')] : [])], result.io)).toBe(EXIT_OK);
    } finally {
      cwdSpy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(path.join(root, '.comment-tidy/config.json'), 'utf8')).scope.include)
      .toEqual(['src/**']);
    expect(fs.existsSync(path.join(root, 'src/.comment-tidy'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(true);
  });

  test('CMakeLists の追跡名の大文字小文字を生成パターンに保持する', async () => {
    const root = makeRoot();
    writeFile(root, 'cmakelists.txt', 'project(example)\n');
    track(root, ['cmakelists.txt']);
    expect(await run(['init', '--repo', root], capture().io)).toBe(EXIT_OK);
    expect(JSON.parse(fs.readFileSync(path.join(root, '.comment-tidy/config.json'), 'utf8')).languages.cmake)
      .toEqual(['**/cmakelists.txt']);
  });

  test('リンクの .gitignore を無変更で拒否し成果物を作らない', async () => {
    const root = makeRoot();
    writeFile(root, 'shared-ignore', '.cache/\n');
    const ignorePath = path.join(root, '.gitignore');
    const lstat = fs.lstatSync.bind(fs);
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
      if (filePath === ignorePath) return { isFile: () => false, isSymbolicLink: () => true };
      return lstat(filePath, ...args);
    });
    const result = capture();
    try {
      expect(await run(['init', '--repo', root], result.io)).toBe(EXIT_USAGE);
    } finally {
      spy.mockRestore();
    }
    expect(result.err.join('\n')).toContain('通常ファイル');
    expect(fs.readFileSync(path.join(root, 'shared-ignore'), 'utf8')).toBe('.cache/\n');
    expect(fs.existsSync(path.join(root, '.comment-tidy'))).toBe(false);
    expect(fs.existsSync(ignorePath)).toBe(false);
  });

  test('.comment-tidy のジャンクションをたどらず書き込みを拒否する', async (context) => {
    for (const gitignoreContent of [null, '.cache/\n']) {
      const root = makeRoot();
      const target = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-init-target-'));
      roots.push(target);
      const managedPath = path.join(root, '.comment-tidy');
      const ignorePath = path.join(root, '.gitignore');
      if (gitignoreContent !== null) writeFile(root, '.gitignore', gitignoreContent);
      try {
        fs.symlinkSync(target, managedPath, 'junction');
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
          context.skip(`リンク作成不可: ${error.code}`);
          return;
        }
        throw error;
      }
      const result = capture();

      expect(await run(['init', '--repo', root], result.io)).toBe(EXIT_USAGE);
      expect(result.err.join('\n')).toContain('リンクかディレクトリ以外');
      expect(fs.readdirSync(target)).toEqual([]);
      expect(fs.existsSync(ignorePath)).toBe(gitignoreContent !== null);
      if (gitignoreContent !== null) expect(fs.readFileSync(ignorePath, 'utf8')).toBe(gitignoreContent);
    }
  });

  test('--config で .comment-tidy 配下のジャンクションを通る先を指定しても書き込みを拒否する', async (context) => {
    const root = makeRoot();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-init-target-'));
    roots.push(target);
    const managedPath = path.join(root, '.comment-tidy');
    fs.mkdirSync(managedPath);
    try {
      fs.symlinkSync(target, path.join(managedPath, 'shared'), 'junction');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        context.skip(`リンク作成不可: ${error.code}`);
        return;
      }
      throw error;
    }
    const result = capture();

    expect(await run(['init', '--repo', root, '--config', path.join(managedPath, 'shared', 'config.json')], result.io)).toBe(EXIT_USAGE);
    expect(result.err.join('\n')).toContain('リンクかディレクトリ以外');
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.readdirSync(managedPath)).toEqual(['shared']);
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
  });

  test.skipIf(process.platform !== 'win32')('--config の管理用の置き場の名前は大文字小文字が違っても受け付ける', async () => {
    const root = makeRoot();
    writeFile(root, 'src/a.js', 'export const a = 1;\n');
    track(root, ['src/a.js']);
    const result = capture();

    expect(await run(['init', '--repo', root, '--config', path.join(root, '.COMMENT-TIDY', 'config.json')], result.io)).toBe(EXIT_OK);
    expect(fs.existsSync(path.join(root, '.comment-tidy', 'config.json'))).toBe(true);
  });

  test('追跡ファイルから設定を作り、ルートの CMakeLists と配下のソースを含める', async () => {
    const root = makeRoot();
    const originalGitignore = '.cache/\r\n.comment-tidy/work\r\n';
    writeFile(root, '.gitignore', originalGitignore);
    writeFile(root, 'CMakeLists.txt', 'project(example)\n');
    writeFile(root, 'index.js', 'export {};\n');
    writeFile(root, 'src/main.cpp', 'int main() {}\n');
    writeFile(root, 'tests/Example.cs', 'class Example {}\n');
    writeFile(root, 'untracked.ts', 'export {};\n');
    track(root, ['.gitignore', 'CMakeLists.txt', 'index.js', 'src/main.cpp', 'tests/Example.cs']);
    const configPath = path.join(root, '.comment-tidy', 'custom.json');
    const result = capture();

    expect(await run(['init', '--pass', 'history', '--repo', root, '--config', configPath], result.io)).toBe(EXIT_OK);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config).toMatchObject({
      rulesPaths: ['~/.claude/CLAUDE.md', '~/.claude/skills/comment-writing/SKILL.md'],
      scope: { include: ['src/**', 'tests/**', 'CMakeLists.txt', 'index.js'] },
      languages: {
        cpp: ['**/*.cpp'],
        csharp: ['**/*.cs'],
        js: ['**/*.js'],
        cmake: ['**/CMakeLists.txt'],
      },
      areas: {
        src: ['src/**'],
        tests: ['tests/**'],
        root: ['CMakeLists.txt', 'index.js'],
      },
      passes: { history: { criteria: 'criteria-history.md' } },
    });
    expect(Object.keys(config.areas)).toEqual(['src', 'tests', 'root']);
    expect(config.languages).not.toHaveProperty('ts');
    expect(fs.readFileSync(path.join(root, '.comment-tidy', 'criteria-history.md'), 'utf8'))
      .toBe(fs.readFileSync(new URL('../../templates/criteria.md', import.meta.url), 'utf8'));
    const updatedGitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(updatedGitignore.startsWith(originalGitignore)).toBe(true);
    expect(updatedGitignore.split(/\r?\n/u).filter((line) => /^\.comment-tidy\/work\/?$/u.test(line))).toHaveLength(1);
    expect(updatedGitignore).toContain('.comment-tidy/worktrees/');
    expect(result.out.join('\n')).toContain('criteria-history.md');
  });

  test('省略した回は volume を使う', async () => {
    const root = makeRoot();
    writeFile(root, 'src/main.cpp', 'int main() {}\n');
    track(root, ['src/main.cpp']);
    const result = capture();

    expect(await run(['init', '--repo', root], result.io)).toBe(EXIT_OK);
    expect(JSON.parse(fs.readFileSync(path.join(root, '.comment-tidy', 'config.json'), 'utf8')))
      .toMatchObject({ passes: { volume: { criteria: 'criteria-volume.md' } } });
    expect(fs.existsSync(path.join(root, '.comment-tidy', 'criteria-volume.md'))).toBe(true);
  });

  test('既存の設定があれば書き込まず終了コード 2 を返す', async () => {
    const root = makeRoot();
    const configPath = path.join(root, '.comment-tidy', 'config.json');
    const originalConfig = '{"existing":true}\n';
    writeFile(root, '.comment-tidy/config.json', originalConfig);
    const originalGitignore = '.cache/\n';
    writeFile(root, '.gitignore', originalGitignore);
    const result = capture();

    expect(await run(['init', '--repo', root], result.io)).toBe(EXIT_USAGE);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalConfig);
    expect(fs.existsSync(path.join(root, '.comment-tidy', 'criteria-volume.md'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe(originalGitignore);
    expect(result.err.join('\n')).toContain('既存の成果物');
  });

  test('criteria の衝突を検出して設定と .gitignore を変更しない', async () => {
    const root = makeRoot();
    const criteriaPath = path.join(root, '.comment-tidy', 'criteria-volume.md');
    const originalCriteria = '手書きの判定基準\n';
    writeFile(root, '.comment-tidy/criteria-volume.md', originalCriteria);
    const originalGitignore = '.cache/\n';
    writeFile(root, '.gitignore', originalGitignore);
    const result = capture();

    expect(await run(['init', '--repo', root], result.io)).toBe(EXIT_USAGE);
    expect(fs.readFileSync(criteriaPath, 'utf8')).toBe(originalCriteria);
    expect(fs.existsSync(path.join(root, '.comment-tidy', 'config.json'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe(originalGitignore);
  });

  test('二つ目の成果物を作れない場合は先に作った設定を取り除く', async () => {
    const root = makeRoot();
    writeFile(root, 'src/main.cpp', 'int main() {}\n');
    track(root, ['src/main.cpp']);
    const linkFile = fs.linkSync.bind(fs);
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      if (linkSpy.mock.calls.length === 2) throw new Error('テスト用の書き込み失敗');
      return linkFile(source, target);
    });
    const result = capture();

    try {
      expect(await run(['init', '--repo', root], result.io)).toBe(EXIT_USAGE);
    } finally {
      linkSpy.mockRestore();
    }

    expect(result.err.join('\n')).toContain('テスト用の書き込み失敗');
    expect(fs.existsSync(path.join(root, '.comment-tidy', 'config.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.comment-tidy', 'criteria-volume.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
    expect(fs.readdirSync(path.join(root, '.comment-tidy'))).toEqual([]);
  });

  test('追跡ディレクトリ名が glob の列挙と衝突する場合は書き込まず止める', async () => {
    const root = makeRoot();
    writeFile(root, 'src{one,two}/main.cpp', 'int main() {}\n');
    track(root, ['src{one,two}/main.cpp']);
    const result = capture();

    expect(await run(['init', '--repo', root], result.io)).toBe(EXIT_USAGE);
    expect(result.err.join('\n')).toContain('glob の特殊文字');
    expect(fs.existsSync(path.join(root, '.comment-tidy', 'config.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.comment-tidy', 'criteria-volume.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
  });

  test('--config が絶対パスでない場合は書き込まず終了コード 2 を返す', async () => {
    const root = makeRoot();
    const result = capture();

    expect(await run(['init', '--repo', root, '--config', 'custom.json'], result.io)).toBe(EXIT_USAGE);
    expect(result.err.join('\n')).toContain('絶対パス');
    expect(fs.existsSync(path.join(root, '.comment-tidy'))).toBe(false);
  });
});
