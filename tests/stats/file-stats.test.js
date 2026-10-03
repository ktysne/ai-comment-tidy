import { describe, expect, test } from 'vitest';

import { fileStats } from '../../src/stats/file-stats.js';

const stats = (filePath, source) => fileStats(filePath, Buffer.from(source, 'utf8'));

describe('stats のファイル集計', () => {
  test('BOM と CRLF を正規化し、末尾の改行の後を数えない', () => {
    expect(stats('src/example.js', '\uFEFF// one\r\nconst text = "literal"; // two\r\n')).toEqual({
      lines: 2,
      code: 1,
      comment: 2,
      commentOnly: 1,
      trailing: 1,
      doc: 0,
      separator: 0,
      commentChars: 10,
    });
  });

  test('C++ の行コメント、doc コメント、区切り線と行末コメントを数える', () => {
    expect(stats('source.cpp', 'int value = 1; // trailing\n// comment\n/// docs\n// ----')).toEqual({
      lines: 4,
      code: 1,
      comment: 4,
      commentOnly: 3,
      trailing: 1,
      doc: 1,
      separator: 1,
      commentChars: 32,
    });
  });

  test('C# の行とブロックの doc コメントを数える', () => {
    expect(stats('source.cs', '/// docs\n/** block */\nint value;')).toEqual({
      lines: 3,
      code: 1,
      comment: 2,
      commentOnly: 2,
      trailing: 0,
      doc: 2,
      separator: 0,
      commentChars: 17,
    });
  });

  test('JavaScript の文字列内のコメント記号をコメントとして数えない', () => {
    expect(stats('source.js', 'const text = "// string"; // note')).toEqual({
      lines: 1,
      code: 1,
      comment: 1,
      commentOnly: 0,
      trailing: 1,
      doc: 0,
      separator: 0,
      commentChars: 6,
    });
  });

  test('CMake のブロックコメントを複数行に数え、doc と区切り線を 0 にする', () => {
    expect(stats('CMakeLists.txt', 'set(value 1) # note\n#[=[multi\nline]=]')).toEqual({
      lines: 3,
      code: 1,
      comment: 3,
      commentOnly: 2,
      trailing: 1,
      doc: 0,
      separator: 0,
      commentChars: 21,
    });
  });

  test('bat のコメントを数え、doc コメントと区切り線が無い入力では 0 にする', () => {
    expect(stats('build.bat', '@echo off\nrem note\n:: third\n')).toEqual({
      lines: 3,
      code: 1,
      comment: 2,
      commentOnly: 2,
      trailing: 0,
      doc: 0,
      separator: 0,
      commentChars: 14,
    });
  });

  test('文字列だけの行をコード行として数える', () => {
    expect(stats('source.js', '"only a string"\n')).toMatchObject({ lines: 1, code: 1, comment: 0 });
  });

  test('文字列の後ろにコメントが並ぶ行を行末コメントとして数える', () => {
    expect(stats('source.js', '"text" // comment')).toMatchObject({ lines: 1, code: 1, comment: 1, commentOnly: 0, trailing: 1 });
  });

  test('コメント文字数を Unicode コードポイントで数える', () => {
    expect(stats('source.js', '// 😀')).toMatchObject({ commentChars: 3 });
  });

  test('空ファイルと末尾の改行が無いファイルの行数を数える', () => {
    expect(stats('empty.js', '')).toMatchObject({ lines: 0 });
    expect(stats('source.js', 'const value = 1;')).toMatchObject({ lines: 1 });
  });
});
