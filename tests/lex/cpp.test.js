import { describe, expect, test } from 'vitest';

import { language } from '../../src/lex/cpp.js';
import { languageOf, lex } from '../../src/lex/index.js';

describe('C++ の字句解析', () => {
  test('文字列、文字リテラル、数値区切り、生文字列を区別する', () => {
    const source = String.raw`auto raw = R"x(// and " quote)x";
auto quoted = "/* not a comment */";
int value = 1'000;
char quote = '"';
char apostrophe = '\'';
// continued \
still comment
int after = 1;`;
    const segments = language.lex(source);

    expect(segments.filter((segment) => segment.kind === 'string').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['"x(// and " quote)x"', '"/* not a comment */"', "'" + '"' + "'", "'\\''"]);
    expect(segments.filter((segment) => segment.kind === 'comment').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['// continued \\\nstill comment']);
  });

  test('行コメントとブロックコメントの文書用記号を識別する', () => {
    const source = '/// doc\n//! important\n//// ordinary\n/** block doc */\n/*! special */\n/**/';
    expect(language.lex(source).filter((segment) => segment.kind === 'comment').map((segment) => segment.style))
      .toEqual(['doc', 'doc', 'line', 'docblock', 'docblock', 'block']);
  });

  test('拡張子と区切り線の正規表現を公開する', () => {
    expect(language.extensions).toEqual(['h', 'hpp', 'hh', 'hxx', 'c', 'cc', 'cpp', 'cxx', 'inl', 'ipp']);
    expect(language.separatorPattern.test('// =====')).toBe(true);
    expect(language.separatorPattern.test('# =====')).toBe(false);
  });

  test('パスの大文字小文字と区切り記号を問わず言語を返す', () => {
    expect(languageOf('SRC\\Engine\\Audio.CPP')).toBe(language);
    expect(languageOf('CMakeLists.txt').id).toBe('cmake');
    expect(languageOf('cmake')).toBeNull();
    expect(lex('notes.txt', 'plain text')).toEqual([{ kind: 'code', start: 0, end: 10 }]);
  });
});
