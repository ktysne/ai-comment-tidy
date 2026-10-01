import { describe, expect, test } from 'vitest';

import { commentBlocks } from '../src/comment-blocks.js';

describe('コメントブロックの抽出', () => {
  test('連続するコメントだけの行をまとめ、空行とコード行で区切る', () => {
    const source = '// first\n/// second\n\nconst value = 1; // trailing\n// after';
    expect(commentBlocks('file.js', source)).toEqual([
      { startLine: 1, endLine: 2, trailing: false, lines: [{ line: 1, text: '// first' }, { line: 2, text: '/// second' }], countedLines: 2, text: 'first\nsecond' },
      { startLine: 4, endLine: 4, trailing: true, lines: [{ line: 4, text: '// trailing' }], countedLines: 1, text: 'trailing' },
      { startLine: 5, endLine: 5, trailing: false, lines: [{ line: 5, text: '// after' }], countedLines: 1, text: 'after' },
    ]);
  });

  test('複数行ブロックコメントを物理行ごとに分けて本文を取り出す', () => {
    const source = '/**\n * summary\n * details\n */';
    expect(commentBlocks('file.cpp', source)).toEqual([
      {
        startLine: 1,
        endLine: 4,
        trailing: false,
        lines: [{ line: 1, text: '/**' }, { line: 2, text: '* summary' }, { line: 3, text: '* details' }, { line: 4, text: '*/' }],
        countedLines: 2,
        text: '\nsummary\ndetails\n',
      },
    ]);
  });

  test('コードと同じ行のコメントを一行の trailing ブロックにする', () => {
    const source = '// before\nconst value = 1; /* explanation */\n// after';
    const blocks = commentBlocks('file.js', source);
    expect(blocks.map(({ startLine, endLine, trailing }) => ({ startLine, endLine, trailing })))
      .toEqual([{ startLine: 1, endLine: 1, trailing: false }, { startLine: 2, endLine: 2, trailing: true }, { startLine: 3, endLine: 3, trailing: false }]);
    expect(blocks[1].text).toBe('explanation');
  });

  test('@param 系の行と字下げされた継続行を数えない', () => {
    const source = [
      '/**',
      ' * Summary',
      ' * @param value description',
      ' *   continued description',
      ' * @return result',
      ' *   continued result',
      ' * @tparam T type',
      ' * @retval 0 success',
      ' *',
      ' */',
    ].join('\n');
    const [block] = commentBlocks('file.cpp', source);
    expect(block.countedLines).toBe(1);
    expect(block.text).toContain('@param value description');
  });

  test('コメント記号だけの行は数えず本文からも除く', () => {
    const [block] = commentBlocks('file.cpp', '/**\n * text\n *\n */');
    expect(block.countedLines).toBe(1);
    expect(block.text).toBe('\ntext\n\n');
    expect(commentBlocks('file.cpp', '/**/')[0]).toMatchObject({ countedLines: 0, text: '' });
  });

  test('CMake の括弧コメントから開閉記号を除く', () => {
    const source = '#[==[\n  first\n  second\n]==]';
    const [block] = commentBlocks('CMakeLists.txt', source);
    expect(block.text).toBe('\nfirst\nsecond\n');
    expect(block.lines.map((line) => line.text)).toEqual(['#[==[', 'first', 'second', ']==]']);
  });

  test('bat の rem と二重コロンの記号を本文から除く', () => {
    expect(commentBlocks('build.cmd', 'rem first\n:: second').map((block) => block.text)).toEqual(['first\nsecond']);
  });

  test('CMake の行コメントと C++ の //! の記号を本文から除く', () => {
    expect(commentBlocks('rules.cmake', '# first\n## second').map((block) => block.text)).toEqual(['first\nsecond']);
    expect(commentBlocks('file.cpp', '//! first\n///< second').map((block) => block.text)).toEqual(['first\nsecond']);
  });

  test('コードと同じ行から始まる複数行のブロックコメントは、同じ行の分だけを trailing にする', () => {
    const source = 'int value = 1; /* first\n   second\n   third */\nint next = 2;';
    expect(commentBlocks('file.cpp', source).map(({ startLine, endLine, trailing }) => ({ startLine, endLine, trailing })))
      .toEqual([{ startLine: 1, endLine: 1, trailing: true }, { startLine: 2, endLine: 3, trailing: false }]);
  });

  test('複数行のブロックコメントが閉じる行にコードが続いても、同じ 1 か所に数える', () => {
    const source = '/* 1\n * 2\n * 3\n * 4 */ int value = 1;\n// after';
    const blocks = commentBlocks('file.cpp', source);
    expect(blocks.map(({ startLine, endLine, trailing, countedLines }) => ({ startLine, endLine, trailing, countedLines })))
      .toEqual([
        { startLine: 1, endLine: 4, trailing: false, countedLines: 4 },
        { startLine: 5, endLine: 5, trailing: false, countedLines: 1 },
      ]);
  });

  test('スラッシュだけの飾りの行は、行数に数える', () => {
    const [block] = commentBlocks('file.cpp', '//////////\n// a\n// b\n// c\n//////////');
    expect(block.countedLines).toBe(5);
  });

  test('ブロックコメントの中の空行でも、1 か所は切れる', () => {
    const source = '/*\nfirst\n\nsecond\n*/';
    expect(commentBlocks('file.cpp', source).map(({ startLine, endLine }) => ({ startLine, endLine })))
      .toEqual([{ startLine: 1, endLine: 2 }, { startLine: 4, endLine: 5 }]);
  });

  test('対応する言語でないファイルは、ブロックを返さない', () => {
    expect(commentBlocks('notes.txt', '// not a comment here')).toEqual([]);
  });

  test('BOM と CRLF を除去して行番号と本文をそろえる', () => {
    const source = '\uFEFF// first\r\n// second\r\n';
    const [block] = commentBlocks('file.js', source);
    expect(block.startLine).toBe(1);
    expect(block.endLine).toBe(2);
    expect(block.lines).toEqual([{ line: 1, text: '// first' }, { line: 2, text: '// second' }]);
    expect(block.text).toBe('first\nsecond');
  });
});
