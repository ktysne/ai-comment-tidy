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

  test('文字リテラルの改行で区間を閉じ、次の行の文字列を保つ', () => {
    const source = `#region Player's
var s = "it's http://example.com/v1 2024-01-01";`;
    const segments = language.lex(source);

    expect(segments.filter((segment) => segment.kind === 'string').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual([`"it's http://example.com/v1 2024-01-01"`]);
    expect(segments.filter((segment) => segment.kind === 'comment')).toEqual([]);
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

  test('複数ドルの補間生文字列で指定数の波括弧だけを式にする', () => {
    const source = 'var text = $$""" {x} {{x}} """;';
    const segments = language.lex(source);

    expect(segments.filter((segment) => segment.kind === 'string').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['$$""" {x} {{', '}}', ' """']);
    expect(segments.filter((segment) => segment.kind === 'code').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['var text = ', 'x', ';']);
  });

  test('複数ドルの補間生文字列を閉じて後続のコメントを解析する', () => {
    const source = `var j = $$"""
{ it's }
""";
int a; // c1
var u = "http://x";`;
    const segments = language.lex(source);

    expect(segments.filter((segment) => segment.kind === 'string').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual([`$$"""
{ it's }
"""`, '"http://x"']);
    expect(segments.filter((segment) => segment.kind === 'comment').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['// c1']);
  });

  test('通常の補間文字列の内容部分を改行で閉じる', () => {
    const source = '$"unfinished\n// comment';
    const segments = language.lex(source);

    expect(segments.filter((segment) => segment.kind === 'string').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['$"unfinished']);
    expect(segments.filter((segment) => segment.kind === 'comment').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['// comment']);
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

  test('自由形式のプリプロセッサ行をコードとして扱い、通常の指示子のコメントは解析する', () => {
    const source = [
      "#region Player's // region text",
      '// actual comment',
      '#endregion // endregion text',
      '#error message // error text',
      '#warning message // warning text',
      '#pragma warning disable 123 // pragma text',
      '#if DEBUG // reason',
      '// following comment',
    ].join('\n');
    const segments = language.lex(source);

    expect(segments.filter((segment) => segment.kind === 'comment').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['// actual comment', '// reason', '// following comment']);
    expect(segments.some((segment) => segment.kind === 'code' && source.slice(segment.start, segment.end).includes("#region Player's // region text")))
      .toBe(true);
  });

  test('BOM と CRLF を含む入力でコメント区間と末尾位置を保つ', () => {
    const source = '\uFEFFint a;\r\n// note\r\nvar s = @"a\r\nb"; // t\r\n';
    const segments = language.lex(source);

    expect(segments.filter((segment) => segment.kind === 'comment').map((segment) => source.slice(segment.start, segment.end)))
      .toEqual(['// note', '// t']);
    expect(segments.at(-1)?.end).toBe(source.length);
  });

  test('C# の拡張子と区切り線の正規表現を公開する', () => {
    expect(language.extensions).toEqual(['cs']);
    expect(language.separatorPattern.test('// =====')).toBe(true);
  });
});
