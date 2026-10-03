import { describe, expect, test } from 'vitest';

import { languageOf, languages, lex } from '../../src/lex/index.js';

describe('字句解析の言語選択', () => {
  test('6 言語を公開し、未対応のパスには null を返す', () => {
    expect(languages.map((language) => language.id)).toEqual(['cpp', 'csharp', 'js', 'ts', 'cmake', 'bat']);
    expect(languageOf('src/Engine/Audio.CS')?.id).toBe('csharp');
    expect(languageOf('readme.md')).toBeNull();
  });

  test('TypeScript の .ts、.mts、.cts を選び、.tsx は対象外にする', () => {
    expect(languageOf('src/file.ts')?.id).toBe('ts');
    expect(languageOf('src/file.mts')?.id).toBe('ts');
    expect(languageOf('src/file.cts')?.id).toBe('ts');
    expect(languageOf('src/file.tsx')).toBeNull();
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
