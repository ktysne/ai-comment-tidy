import { describe, expect, test } from 'vitest';

import { language } from '../../src/lex/cmake.js';
import { languageOf } from '../../src/lex/index.js';

describe('CMake の字句解析', () => {
  test('引用符と括弧引数の中のコメント記号を文字列として扱う', () => {
    const source = 'set(a "# quoted")\nset(b [=[# bracket argument]=]) # line comment';
    const segments = language.lex(source);
    expect(segments.filter((segment) => segment.kind === 'string').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['"# quoted"', '[=[# bracket argument]=]']);
    expect(segments.filter((segment) => segment.kind === 'comment').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['# line comment']);
    expect(segments.find((segment) => segment.kind === 'comment').style).toBe('hash');
  });

  test('等号の有無が異なる括弧コメントを閉じ記号まで認識する', () => {
    const source = '#[[short\ncomment]]\n#[==[long\ncomment]==]';
    expect(language.lex(source).filter((segment) => segment.kind === 'comment').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['#[[short\ncomment]]', '#[==[long\ncomment]==]']);
    expect(language.lex(source).filter((segment) => segment.kind === 'comment').map((segment) => segment.style))
      .toEqual(['block', 'block']);
  });

  test('CMakeLists.txt と cmake 拡張子を言語として扱う', () => {
    expect(languageOf('SRC\\CMakeLists.TXT')).toBe(language);
    expect(languageOf('build\\Rules.CMAKE')).toBe(language);
    expect(language.separatorPattern.test('# =====')).toBe(true);
  });
});
