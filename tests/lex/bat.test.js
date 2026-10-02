import { describe, expect, test } from 'vitest';

import { language } from '../../src/lex/bat.js';
import { languageOf } from '../../src/lex/index.js';

describe('bat の字句解析', () => {
  test('rem、@rem、二重コロンをコメントとして扱う', () => {
    const source = 'rem first\n  @REM second\n:: third\nremove = 1\nremark = 2';
    const comments = language.lex(source).filter((segment) => segment.kind === 'comment').map((segment) => source.slice(segment.start, segment.end));
    expect(comments).toEqual(['rem first', '@REM second', ':: third']);
    expect(language.lex(source).filter((segment) => segment.kind === 'comment').map((segment) => segment.style))
      .toEqual(['rem', 'rem', 'rem']);
  });

  test('rem で始まっても別の語はコードのままにする', () => {
    const source = 'remove = 1\nremovable = 2\n@echo off';
    expect(language.lex(source).filter((segment) => segment.kind === 'comment')).toEqual([]);
  });

  test('bat と cmd の拡張子および区切り線を公開する', () => {
    expect(language.extensions).toEqual(['bat', 'cmd']);
    expect(languageOf('scripts\\Build.CMD')).toBe(language);
    expect(language.separatorPattern.test('rem =====')).toBe(true);
    expect(language.separatorPattern.test('@rem =====')).toBe(false);
  });
});
