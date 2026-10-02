import { describe, expect, test } from 'vitest';

import { normalizedCode } from '../../src/lex/normalized-code.js';

const same = (before, after) => normalizedCode('x.cpp', before) === normalizedCode('x.cpp', after);

describe('コメントを除いたコードの正規化', () => {
  test('コメントを消して演算子がつながると、別のコードとして検出する', () => {
    expect(same('int f() { return a + /* c */ ++b; }', 'int f() { return a +++b; }')).toBe(false);
    expect(same('auto p = q - /* c */ >r;', 'auto p = q->r;')).toBe(false);
    expect(same('int foo/* c */bar;', 'int foobar;')).toBe(false);
  });

  test('コメントの削除と空白の違いだけなら、同じコードとして扱う', () => {
    expect(same('int f() { return a + /* c */ ++b; }', 'int f() { return a + ++b; }')).toBe(true);
    expect(same('x = 1; // 理由\ny = 2;', 'x = 1;\ny = 2;')).toBe(true);
    expect(same('std::vector<std::vector<int> /* c */ > v;', 'std::vector<std::vector<int> > v;')).toBe(true);
  });

  test('文字列リテラル内のコメント記号はコードの差として残す', () => {
    expect(same('auto s = "a // b";', 'auto s = "a  b";')).toBe(false);
    expect(same('auto s = "a /* b */ c";', 'auto s = "a /* b */ c"; // 末尾')).toBe(true);
  });

  test('生文字列の改行コードの違いは正規化結果に影響しない', () => {
    expect(normalizedCode('x.cpp', 'auto s = R"x(a\nb)x";'))
      .toBe(normalizedCode('x.cpp', 'auto s = R"x(a\r\nb)x";'));
  });
});
