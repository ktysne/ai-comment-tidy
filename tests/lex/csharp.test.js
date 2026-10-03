import { describe, expect, test } from 'vitest';

import { language } from '../../src/lex/csharp.js';

describe('C# の字句解析', () => {
  test('通常文字列と文字リテラルの中のコメント記号を文字列として扱う', () => {
    const source = String.raw`var text = "// not a comment /* either */";
var empty = "";
var emptyVerbatim = @"";
var emptyInterpolated = $"";
var escaped = "quote: \" // still a string /* too */";
var quote = '\''; // trailing comment`;
    const segments = language.lex(source);

    expect(segments.filter((segment) => segment.kind === 'string').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual([
        '"// not a comment /* either */"',
        '""',
        '@""',
        '$""',
        String.raw`"quote: \" // still a string /* too */"`,
        "'\\''",
      ]);
    expect(segments.filter((segment) => segment.kind === 'comment').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['// trailing comment']);
  });

  test('逐語的文字列と補間文字列のコメント記号を文字列として扱う', () => {
    const source = [
      'var verbatim = @"// not a comment /* either */ and "" quote"; // after verbatim',
      'var interpolated = $"// not a comment /* either */ {{literal}} {GetValue("// expression string")}"; // after interpolated',
      'var verbatimInterpolated = $@"// not a comment /* either */ {{literal}} {GetValue("/* expression string */")}"; // after verbatim interpolation',
      'var reversedPrefix = @$"// not a comment /* either */ {{literal}} {GetValue("// expression string")}"; // after reversed prefix',
    ].join('\n');

    expect(language.lex(source).filter((segment) => segment.kind === 'comment').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual([
        '// after verbatim',
        '// after interpolated',
        '// after verbatim interpolation',
        '// after reversed prefix',
      ]);
  });

  test('生文字列と補間生文字列のコメント記号を文字列として扱う', () => {
    const source = [
      'var raw = """"',
      '// not a comment /* either */',
      '""" still inside the raw string',
      '""""; // after raw',
      'var interpolatedRaw = $"""',
      '// not a comment /* either */ {{literal}}',
      '{GetValue("// expression string")}',
      '"""; // after interpolated raw',
    ].join('\n');

    expect(language.lex(source).filter((segment) => segment.kind === 'comment').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['// after raw', '// after interpolated raw']);
  });

  test('補間式の中にある入れ子の補間文字列を解析する', () => {
    const source = 'var nested = $"outer {Format($@"inner {GetValue("/* string */")}")}"; // trailing';
    expect(language.lex(source).filter((segment) => segment.kind === 'comment').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['// trailing']);
  });

  test('文書コメントと通常コメントを区別する', () => {
    const source = '/// docs\n/** block docs */\n//// ordinary\n//! ordinary';
    expect(language.lex(source).filter((segment) => segment.kind === 'comment').map((segment) => segment.style))
      .toEqual(['doc', 'docblock', 'line', 'line']);
    expect(language.docCommentMarkers).toEqual(['///', '/**']);
  });

  test('プリプロセッサの行をコードとして扱い、行末のバックスラッシュでコメントを継続しない', () => {
    const source = '#region Example\n#endregion\n// first line \\\nvar text = "// string";';
    const segments = language.lex(source);
    expect(segments.filter((segment) => segment.kind === 'comment').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['// first line \\']);
    expect(segments.some((segment) => segment.kind === 'code' && source.slice(segment.start, segment.end).includes('#region Example')))
      .toBe(true);
  });

  test('C# の拡張子と区切り線の正規表現を公開する', () => {
    expect(language.extensions).toEqual(['cs']);
    expect(language.separatorPattern.test('// =====')).toBe(true);
  });
});
