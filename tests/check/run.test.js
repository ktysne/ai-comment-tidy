import { describe, expect, test } from 'vitest';

import { runCheck } from '../../src/check/run.js';
import { lineEndingSignature } from '../../src/check/line-endings.js';
import { sha256 } from '../../src/snapshot/hash-list.js';

const config = {
  maxCommentLines: 3,
  maxLineWidth: 108,
  docs: { root: 'docs', refPattern: 'docs/(?<doc>[\\w.-]+)「(?<heading>[^」]+)」' },
  licensePatterns: ['Copyright', 'SPDX-License-Identifier', 'この表示を残すこと'],
};

function snapshot(files, metadata = {}) {
  return Object.assign({
    listFiles: () => Object.keys(files).sort(),
    has: (filePath) => Object.hasOwn(files, filePath),
    read: (filePath) => files[filePath],
    readMany: (filePaths) => new Map(filePaths.map((filePath) => [filePath, files[filePath]])),
  }, metadata);
}

function buffers(files) {
  return Object.fromEntries(Object.entries(files).map(([filePath, source]) => [
    filePath,
    Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8'),
  ]));
}

function check(before, after, options = {}) {
  const beforeBuffers = buffers(before);
  const afterBuffers = buffers(after);
  const changedFiles = options.baselineMetadata?.changedFiles ?? (() => Object.keys(beforeBuffers)
    .filter((filePath) => !afterBuffers[filePath] || !beforeBuffers[filePath].equals(afterBuffers[filePath])));
  return runCheck({
    files: options.files ?? ['src/a.cpp'],
    baseline: snapshot(beforeBuffers, { ...options.baselineMetadata, changedFiles }),
    target: snapshot(afterBuffers),
    hashList: options.hashList ?? null,
    config: { ...config, ...options.config },
    offline: options.offline ?? false,
  });
}

describe('check の字句の同一性', () => {
  test('コメントを消して行を詰めてもコードトークンが同じなら合格する', () => {
    const result = check(
      { 'src/a.cpp': 'int first; // remove\nint second;\n' },
      { 'src/a.cpp': 'int first; int second;\n' },
    );

    expect(result.failures.filter(({ check: name }) => name === 'token-identity')).toEqual([]);
  });

  test('文字列リテラルの値が変わると不合格にする', () => {
    const result = check(
      { 'src/a.cpp': 'const char* value = "before";\n' },
      { 'src/a.cpp': 'const char* value = "after";\n' },
    );

    expect(result.failures[0]).toMatchObject({ check: 'token-identity', file: 'src/a.cpp', line: 1 });
    expect(result.failures[0].detail).toContain('before');
  });
});

describe('check の担当外の変更', () => {
  test('担当外のファイルが同じなら合格する', () => {
    const result = check(
      { 'src/a.cpp': 'int a;\n', 'src/other.js': 'const b = 1;\n' },
      { 'src/a.cpp': 'int a; // note\n', 'src/other.js': 'const b = 1;\n' },
    );

    expect(result.failures.filter(({ check: name }) => name === 'out-of-scope-change')).toEqual([]);
  });

  test('担当外のファイルが変更されると不合格にする', () => {
    const result = check(
      { 'src/a.cpp': 'int a;\n', 'src/other.js': 'const b = 1;\n' },
      { 'src/a.cpp': 'int a; // note\n', 'src/other.js': 'const b = 2;\n' },
    );

    expect(result.failures).toContainEqual(expect.objectContaining({ check: 'out-of-scope-change', file: 'src/other.js' }));
  });

  test('offline でハッシュ一覧の担当外ファイルを照合する', () => {
    const untouched = Buffer.from('const b = 1;\n');
    const result = runCheck({
      files: ['src/a.cpp'],
      baseline: snapshot(buffers({ 'src/a.cpp': 'int a;\n' }), { baseDir: 'base-copy' }),
      target: snapshot(buffers({ 'src/a.cpp': 'int a; // note\n', 'src/other.js': untouched })),
      hashList: { algorithm: 'sha256', files: { 'src/other.js': sha256(untouched) } },
      config,
      offline: true,
    });

    expect(result.ok).toBe(true);
    expect(result.offline).toBe(true);
  });

  test('offline で担当外ファイルのハッシュが変わると不合格にする', () => {
    const result = runCheck({
      files: ['src/a.cpp'],
      baseline: snapshot(buffers({ 'src/a.cpp': 'int a;\n' }), { baseDir: 'base-copy' }),
      target: snapshot(buffers({ 'src/a.cpp': 'int a; // note\n', 'src/other.js': 'const b = 2;\n' })),
      hashList: { algorithm: 'sha256', files: { 'src/other.js': sha256(Buffer.from('const b = 1;\n')) } },
      config,
      offline: true,
    });

    expect(result.failures).toContainEqual(expect.objectContaining({ check: 'out-of-scope-change', file: 'src/other.js' }));
  });
});

describe('check のコメント行数', () => {
  test('上限以内のコメントブロックを通す', () => {
    const result = check(
      { 'src/a.cpp': 'int value;\n' },
      { 'src/a.cpp': 'int value;\n// one\n// two\n// three\n' },
    );

    expect(result.failures.filter(({ check: name }) => name === 'comment-lines')).toEqual([]);
  });

  test('上限を超えるコメントブロックを不合格にする', () => {
    const result = check(
      { 'src/a.cpp': 'int value;\n' },
      { 'src/a.cpp': 'int value;\n// one\n// two\n// three\n// four\n' },
    );

    expect(result.failures).toContainEqual(expect.objectContaining({ check: 'comment-lines', line: 2 }));
  });

  test('複数行コメントの開始行にコードがあってもコメント全体を数える', () => {
    const result = check(
      { 'src/a.cpp': 'int value;\n' },
      { 'src/a.cpp': 'int begin; /* first\n * second\n * third\n * fourth */ int end;\n' },
    );

    expect(result.failures).toContainEqual(expect.objectContaining({ check: 'comment-lines', line: 1 }));
  });

  test('開始行と終了行にコードがある複数行コメントを境界行ごと含めて判定する', () => {
    const result = check(
      { 'src/a.cpp': 'int value;\n' },
      { 'src/a.cpp': 'int begin; /* first\n * second\n * third */ int end;\n' },
    );

    expect(result.failures.filter(({ check: name }) => name === 'comment-lines')).toEqual([]);
  });
});

describe('check の行末', () => {
  test('CRLF を保ったコメント変更を通す', () => {
    const result = check(
      { 'src/a.cpp': Buffer.from('// before\r\nint value;\r\n') },
      { 'src/a.cpp': Buffer.from('// after\r\nint value;\r\n') },
    );

    expect(result.failures.filter(({ check: name }) => name === 'line-ending')).toEqual([]);
  });

  test('CRLF が LF に変わると不合格にする', () => {
    const result = check(
      { 'src/a.cpp': Buffer.from('// before\r\nint value;\r\n') },
      { 'src/a.cpp': Buffer.from('// after\nint value;\n') },
    );

    expect(result.failures).toContainEqual(expect.objectContaining({ check: 'line-ending', file: 'src/a.cpp' }));
  });

  test('blob の行末が作業ツリーと同じならフィルター後の行末が異なっても通す', () => {
    const rawBaseline = Buffer.from('// before\nint value;\n');
    const result = check(
      { 'src/a.cpp': Buffer.from('// before\r\nint value;\r\n') },
      { 'src/a.cpp': Buffer.from('// after\nint value;\n') },
      { baselineMetadata: { readManyRaw: () => new Map([['src/a.cpp', rawBaseline]]) } },
    );

    expect(result.failures.filter(({ check: name }) => name === 'line-ending')).toEqual([]);
  });

  test('BOM が変わると不合格にする', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const result = check(
      { 'src/a.cpp': Buffer.concat([bom, Buffer.from('int value;\n')]) },
      { 'src/a.cpp': Buffer.from('int value;\n') },
    );

    expect(result.failures).toContainEqual(expect.objectContaining({ check: 'line-ending', file: 'src/a.cpp' }));
  });

  test('末尾の改行が変わると不合格にする', () => {
    const result = check(
      { 'src/a.cpp': '// before\nint value;\n' },
      { 'src/a.cpp': '// after\nint value;' },
    );

    expect(result.failures).toContainEqual(expect.objectContaining({ check: 'line-ending', file: 'src/a.cpp' }));
  });

  test('混在する行末を識別する', () => {
    expect(lineEndingSignature(Buffer.from('one\r\ntwo\n'))).toMatchObject({ style: 'mixed', finalNewline: true });
  });
});

describe('check のコメント警告', () => {
  test('上限以内の追加コメント行は行幅の警告にならない', () => {
    const result = check(
      { 'src/a.cpp': '// old\n' },
      { 'src/a.cpp': '// short\n' },
      { config: { maxLineWidth: 8 } },
    );

    expect(result.warnings.filter(({ check: name }) => name === 'line-width')).toEqual([]);
  });

  test('全角文字を 2 桁として追加コメントの行幅を警告する', () => {
    const result = check(
      { 'src/a.cpp': '// old\n' },
      { 'src/a.cpp': '// １２３\n' },
      { config: { maxLineWidth: 8 } },
    );

    expect(result.warnings).toContainEqual(expect.objectContaining({ check: 'line-width', file: 'src/a.cpp', line: 1 }));
  });

  test('変更していない長いコメント行は行幅を警告しない', () => {
    const longComment = `// ${'x'.repeat(30)}\n`;
    const result = check(
      { 'src/a.cpp': `// before\n${longComment}` },
      { 'src/a.cpp': `// after\n${longComment}` },
      { config: { maxLineWidth: 10 } },
    );

    expect(result.warnings.filter(({ check: name }) => name === 'line-width')).toEqual([]);
  });

  test('存在する見出しへの追加参照を通す', () => {
    const result = check(
      { 'src/a.cpp': 'int value;\n', 'docs/guide.md': '# 整合性（詳説）\n' },
      { 'src/a.cpp': '// docs/guide「整合性」\nint value;\n', 'docs/guide.md': '# 整合性（詳説）\n' },
    );

    expect(result.warnings.filter(({ check: name }) => name === 'doc-ref')).toEqual([]);
  });

  test('存在しない見出しへの追加参照を警告する', () => {
    const result = check(
      { 'src/a.cpp': 'int value;\n', 'docs/guide.md': '# 有効な節\n' },
      { 'src/a.cpp': '// docs/guide「無い節」\nint value;\n', 'docs/guide.md': '# 有効な節\n' },
    );

    expect(result.warnings).toContainEqual(expect.objectContaining({ check: 'doc-ref', file: 'src/a.cpp', line: 1 }));
  });

  test('資料の参照は同名の Markdown だけを照合し、画像や接頭辞が同じ資料を読まない', () => {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
    const docs = { 'docs/guide.png': image, 'docs/guide-old.md': '# 古い節\n', 'docs/guide.md': '# 概要\n' };
    const result = check(
      { 'src/a.cpp': 'int value;\n', ...docs },
      { 'src/a.cpp': '// docs/guide「概要」\n// docs/guide「古い節」\nint value;\n', ...docs },
    );

    expect(result.warnings).toEqual([expect.objectContaining({ check: 'doc-ref', line: 2 })]);
  });
});
