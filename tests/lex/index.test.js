import { describe, expect, test } from 'vitest';

import { commentBlocks } from '../../src/comment-blocks.js';
import { fileStats } from '../../src/stats/file-stats.js';
import { languageFor, languageOf, languages, lex } from '../../src/lex/index.js';

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

  test('設定した言語パターンが拡張子による判定を置き換える', () => {
    const config = { languages: { js: ['src/**/*.cpp'], cpp: ['src/special.cpp'] } };
    const source = '// note\nconst value = 1;\n';

    expect(languageFor('src/app.cpp', config)?.id).toBe('js');
    expect(languageFor('src/special.cpp', config)?.id).toBe('js');
    expect(languageFor('src/app.js', config)).toBeNull();
    expect(lex('src/app.cpp', source, config).some((segment) => segment.kind === 'comment')).toBe(true);
    expect(commentBlocks('src/app.cpp', source, config)).toHaveLength(1);
    expect(fileStats('src/app.cpp', Buffer.from(source), config).comment).toBe(1);
  });
});
