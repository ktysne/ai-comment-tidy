import { describe, expect, test } from 'vitest';

import { language } from '../../src/lex/typescript.js';

describe('TypeScript の字句解析', () => {
  test('型注釈とジェネリクスの後のコメントを認識する', () => {
    const source = 'const m: Map<string, number[]> = new Map(); // c';
    const comments = language.lex(source).filter((segment) => segment.kind === 'comment');

    expect(comments.map((segment) => source.slice(segment.start, segment.end))).toEqual(['// c']);
  });

  test('非 null 表明の後の割り算と否定の後の正規表現を区別する', () => {
    const division = 'const r = a! / b; // c';
    const negatedRegex = String.raw`if (!/a\/\/b/.test(s)) {} // c`;

    expect(language.lex(division)
      .filter((segment) => segment.kind === 'comment')
      .map((segment) => division.slice(segment.start, segment.end))).toEqual(['// c']);
    expect(language.lex(negatedRegex)
      .filter((segment) => segment.kind === 'comment')
      .map((segment) => negatedRegex.slice(segment.start, segment.end))).toEqual(['// c']);
  });

  test('コメントを挟んだ非 null 表明、重ねた !、キーワードと同じ名前のプロパティの後の / を割り算として読む', () => {
    for (const source of [
      'const r = a! /* note */ / b; // #12',
      'const r = a!! / b; // #12',
      'const r = obj.return! / b; // #12',
    ]) {
      expect(language.lex(source).filter((segment) => segment.kind === 'comment').map((segment) => source.slice(segment.start, segment.end)).at(-1))
        .toBe('// #12');
      expect(language.lex(source).some((segment) => segment.kind === 'string')).toBe(false);
    }
  });

  test('return などのキーワードの後の ! は非 null 表明にせず、続く正規表現を読む', () => {
    // 正規表現の中に /* を置き、割り算と読み誤るとブロックコメントが後ろのコードを飲み込む形にする。
    const source = 'function g(s: string) { return !/[/*]/.test(s); } const x = 1; // c';
    const segments = language.lex(source);

    expect(segments.filter((segment) => segment.kind === 'string').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['/[/*]/']);
    expect(segments.filter((segment) => segment.kind === 'comment').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['// c']);
  });

  test('テンプレート文字列の本文を保護し、式の中のコメントを認識する', () => {
    const source = 'const text = `literal // text ${value // interpolation comment\n} tail // text`;';
    const comments = language.lex(source).filter((segment) => segment.kind === 'comment');

    expect(comments.map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['// interpolation comment']);
  });

  test('doc コメントを区別する', () => {
    const source = '/** documented */';
    const comment = language.lex(source).find((segment) => segment.kind === 'comment');

    expect(source.slice(comment.start, comment.end)).toBe('/** documented */');
    expect(comment.style).toBe('docblock');
    expect(language.docCommentMarkers).toEqual(['///', '//!', '/**', '/*!']);
  });

  test('BOM と CRLF を含む入力でも区間の位置を保つ', () => {
    const source = '\uFEFFconst value: number = 1;\r\n// note\r\n';
    const segments = language.lex(source);
    const comment = segments.find((segment) => segment.kind === 'comment');

    expect(source.slice(comment.start, comment.end)).toBe('// note');
    expect(comment.style).toBe('line');
    expect(segments.at(-1).end).toBe(source.length);
  });

  test('TypeScript の拡張子と区切り線を公開する', () => {
    expect(language.extensions).toEqual(['ts', 'mts', 'cts']);
    expect(language.separatorPattern).toEqual(/^\/\/+\s*(?:[=*~#_-]{4,}|[=-]{3,}\s.*\s[=-]{3,}\s*)$/i);
  });
});
