import { describe, expect, test } from 'vitest';

import { language } from '../../src/lex/js.js';

describe('JavaScript の字句解析', () => {
  test('文字列とテンプレート内のコメント記号をコメントにしない', () => {
    const source = 'const text = "// not a comment /* either */";\nconst template = `/* literal */`;';
    expect(language.lex(source).filter((segment) => segment.kind === 'comment')).toEqual([]);
  });

  test('入れ子のテンプレート式のコード内にあるコメントを認識する', () => {
    const source = 'const value = `outer ${{ nested: `${item /* nested */}` } /* outer */}`;';
    const comments = language.lex(source).filter((segment) => segment.kind === 'comment').map((segment) => source.slice(segment.start, segment.end));
    expect(comments).toEqual(['/* nested */', '/* outer */']);
  });

  test('正規表現のエスケープと文字クラスを読み、割り算を文字列にしない', () => {
    const source = String.raw`const slash = /\/\//;
const characterClass = /[/]/;
const ratio = total / count;`;
    const strings = language.lex(source).filter((segment) => segment.kind === 'string').map((segment) => source.slice(segment.start, segment.end));
    expect(strings).toEqual(['/\\/\\//', '/[/]/']);
    expect(language.lex(source).filter((segment) => segment.kind === 'code').map((segment) => source.slice(segment.start, segment.end)).join(''))
      .toContain('total / count');
  });

  test('言語固有の拡張子と区切り線を公開する', () => {
    expect(language.extensions).toEqual(['js', 'mjs', 'cjs']);
    expect(language.separatorPattern.test('// ---- heading ----')).toBe(true);
  });
});
