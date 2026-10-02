import { describe, expect, test } from 'vitest';

import { languageOf, languages, lex } from '../../src/lex/index.js';

describe('字句解析の言語選択', () => {
  test('4 言語を公開し、未対応のパスには null を返す', () => {
    expect(languages.map((language) => language.id)).toEqual(['cpp', 'js', 'cmake', 'bat']);
    expect(languageOf('readme.md')).toBeNull();
  });

  test('BOM と CRLF を含む入力でも区間の位置を保つ', () => {
    const source = '\uFEFFconst value = 1;\r\n// note\r\n';
    const segments = lex('file.js', source);
    const comment = segments.find((segment) => segment.kind === 'comment');
    expect(source.slice(comment.start, comment.end)).toBe('// note');
    expect(comment.style).toBe('line');
    expect(segments.at(-1).end).toBe(source.length);
  });
});
