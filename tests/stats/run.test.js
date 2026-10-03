import { describe, expect, test } from 'vitest';

import { statsForSnapshot } from '../../src/stats/run.js';

function makeSnapshot(files) {
  return {
    listFiles: () => Object.keys(files),
    has: (filePath) => Object.hasOwn(files, filePath),
    read: (filePath) => files[filePath],
    readMany: (filePaths) => new Map(filePaths.map((filePath) => [filePath, files[filePath]])),
  };
}

describe('stats の対象選択と集計', () => {
  test('既定の除外、言語の無いファイル、接頭辞、領域ごとの合計を扱う', () => {
    const result = statsForSnapshot(makeSnapshot({
      'root.cpp': Buffer.from('// root', 'utf8'),
      'src/one.cpp': Buffer.from('int one; // note', 'utf8'),
      'src/two.js': Buffer.from('// note', 'utf8'),
      'third_party/skip.cpp': Buffer.from('// skip', 'utf8'),
      'notes.txt': Buffer.from('// skip', 'utf8'),
    }), { prefixes: ['src/'] });

    expect(Object.keys(result.files)).toEqual(['src/one.cpp', 'src/two.js']);
    expect(result.totals.src).toEqual({
      lines: 2,
      code: 1,
      comment: 2,
      commentOnly: 1,
      trailing: 1,
      doc: 0,
      separator: 0,
      commentChars: 12,
    });
    expect(result.warnings).toEqual([]);
  });

  test('UTF-8 として読めないファイルを除外して警告に記録する', () => {
    const result = statsForSnapshot(makeSnapshot({ 'src/broken.cpp': Buffer.from([0xff, 0xfe]) }));

    expect(Object.keys(result.files)).toEqual([]);
    expect(Object.keys(result.totals)).toEqual([]);
    expect(result.warnings).toEqual([{ path: 'src/broken.cpp', message: 'src/broken.cpp を UTF-8 として読めません' }]);
  });

  test('ルート直下のファイルを . 領域へまとめる', () => {
    const result = statsForSnapshot(makeSnapshot({ 'source.cpp': Buffer.from('int value;', 'utf8') }));

    expect(result.totals['.'].lines).toBe(1);
  });

  test('設定の対象範囲と言語を使い、最初の領域と未分類をまとめる', () => {
    const result = statsForSnapshot(makeSnapshot({
      'src/core/one.cpp': Buffer.from('// core', 'utf8'),
      'src/unassigned.cpp': Buffer.from('// unassigned', 'utf8'),
      'src/private/skip.cpp': Buffer.from('// excluded', 'utf8'),
      'outside.cpp': Buffer.from('// outside', 'utf8'),
      'src/ignored.js': Buffer.from('// no configured language', 'utf8'),
    }), {
      config: {
        scope: { include: ['src/**'], exclude: ['src/private'] },
        languages: { cpp: ['src/**/*.cpp'] },
        areas: { core: ['src/core/**'], other: ['tests/**'] },
      },
    });

    expect(Object.keys(result.files)).toEqual(['src/core/one.cpp', 'src/unassigned.cpp']);
    expect(result.totals.core.comment).toBe(1);
    expect(result.totals['(なし)'].comment).toBe(1);
    expect(result.totals.other).toBeUndefined();
  });
});
