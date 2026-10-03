import { describe, expect, test } from 'vitest';

import { matchesGlob } from '../src/glob.js';

describe('glob', () => {
  test('**/*.h はルート直下のファイルにも当たる', () => {
    expect(matchesGlob('a.h', '**/*.h')).toBe(true);
  });

  test('波括弧の候補を照合する', () => {
    for (const filePath of ['a.h', 'src/b.hpp', 'deep/c.cpp']) {
      expect(matchesGlob(filePath, '**/*.{h,hpp,cpp}')).toBe(true);
    }
    expect(matchesGlob('src/a.c', '**/*.{h,hpp,cpp}')).toBe(false);
  });

  test('スラッシュを含まないパターンは深い階層の名前にも当たる', () => {
    expect(matchesGlob('one/two/build.bat', '*.bat')).toBe(true);
    expect(matchesGlob('one/third_party/src/file.cpp', 'third_party')).toBe(true);
    expect(matchesGlob('one/third_partyish/file.cpp', 'third_party')).toBe(false);
  });

  test('単一のワイルドカードはスラッシュをまたがない', () => {
    expect(matchesGlob('src/file.cpp', 'src/*.cpp')).toBe(true);
    expect(matchesGlob('src/nested/file.cpp', 'src/*.cpp')).toBe(false);
    expect(matchesGlob('src/nested/file.cpp', 'src/?.cpp')).toBe(false);
  });

  test('フォルダーに当たるパターンは配下のファイルにも当たる', () => {
    expect(matchesGlob('one/third_party/lib/file.cpp', 'third_party')).toBe(true);
    expect(matchesGlob('src/lib/file.cpp', 'src')).toBe(true);
  });
});
