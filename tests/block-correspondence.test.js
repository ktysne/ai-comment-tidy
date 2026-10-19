import { describe, expect, test } from 'vitest';

import { blockAnchors, compactBlockText, correspondBlocks } from '../src/block-correspondence.js';
import { commentBlocks } from '../src/comment-blocks.js';

function anchorsOf(source, filePath = 'file.js') {
  return blockAnchors(filePath, source, undefined, commentBlocks(filePath, source));
}

function described(entries) {
  return entries.map(([compact, anchor]) => ({ compact, anchor }));
}

describe('コメントのブロックのアンカー', () => {
  test('直後のコードの行を、空白を詰めてアンカーにする', () => {
    expect(anchorsOf('// 説明\nfunction  a( x ) {\n}\n')).toEqual(['next:functiona(x){']);
  });

  test('空行を挟んでもコードがあれば、それを直後のコードとする', () => {
    expect(anchorsOf('// 説明\n\n\nconst value = 1;\n')).toEqual(['next:constvalue=1;']);
  });

  test('行末のコメントは、その行のコードの部分をアンカーにする', () => {
    expect(anchorsOf('const value = 1; // 説明\nconst other = 2;\n')).toEqual(['own:constvalue=1;']);
  });

  test('直後がファイルの末尾なら、直前のコードの行を直前の印を付けてアンカーにする', () => {
    expect(anchorsOf('const value = 1;\n\n// 説明\n')).toEqual(['prev:constvalue=1;']);
  });

  test('空行を挟んで次もコメントなら、直前のコードの行をアンカーにする', () => {
    const source = 'const value = 1;\n\n// 一つ目\n\n// 二つ目\nconst other = 2;\n';
    expect(anchorsOf(source)).toEqual(['prev:constvalue=1;', 'next:constother=2;']);
  });

  test('直前にも直後にもコードが無ければ、先頭からの順位をアンカーにする', () => {
    expect(anchorsOf('// 一つ目\n\n// 二つ目\n')).toEqual(['head:0', 'head:1']);
  });

  test('ブロックの本文は空白を除いて比べる', () => {
    const [block] = commentBlocks('file.js', '//  a   b\n// c\n');
    expect(compactBlockText(block)).toBe('abc');
  });
});

describe('ブロックの対応付け', () => {
  test('本文が同じブロックは、位置とアンカーが変わっても対応させる', () => {
    const base = described([['alpha', 'next:a'], ['beta', 'next:b']]);
    const current = described([['beta', 'next:renamed'], ['alpha', 'next:c']]);
    expect(correspondBlocks(base, current)).toEqual([1, 0]);
  });

  test('本文が変わったブロックは、アンカーが同じ元のブロックに対応させる', () => {
    const base = described([['alpha', 'next:a'], ['beta', 'next:b']]);
    const current = described([['alpha2', 'next:a'], ['beta2', 'next:b']]);
    expect(correspondBlocks(base, current)).toEqual([0, 1]);
  });

  test('本文もアンカーも違うブロックは対応なしにする', () => {
    const base = described([['alpha', 'next:a']]);
    expect(correspondBlocks(base, described([['beta', 'next:b']]))).toEqual([-1]);
  });

  test('アンカーを持たないブロックは、本文が同じときだけ対応させる', () => {
    const base = described([['alpha', null]]);
    expect(correspondBlocks(base, described([['alpha2', null]]))).toEqual([-1]);
    expect(correspondBlocks(base, described([['alpha', null]]))).toEqual([0]);
  });

  test('対応は元の順序を保つ', () => {
    const base = described([['one', 'next:x'], ['two', 'next:y']]);
    const current = described([['two-edited', 'next:y'], ['one-edited', 'next:x']]);
    const pairing = correspondBlocks(base, current);
    expect(pairing.filter((index) => index >= 0)).toHaveLength(1);
  });

  test('頻出のアンカーの途中のブロックを消しても、後続のブロックの対応がずれない', () => {
    const base = described([
      ['first', 'next:}'],
      ['second', 'next:}'],
      ['third', 'next:}'],
      ['tail', 'next:return;'],
      ['last', 'next:end'],
    ]);
    const current = described([
      ['first!', 'next:}'],
      ['third!', 'next:}'],
      ['tail!', 'next:return;'],
      ['last!', 'next:end'],
    ]);
    const pairing = correspondBlocks(base, current);
    expect(pairing.slice(2)).toEqual([3, 4]);
    expect(pairing[0]).toBe(0);
    expect(pairing[1]).toBe(2);
  });

  test('本文が同じブロックが複数あるときは、アンカーが近い順に対応させ、余りは出現順に対応させる', () => {
    const base = described([['same', 'next:a'], ['same', 'next:b'], ['same', 'next:c']]);
    const current = described([['same', 'next:c'], ['same', 'next:z']]);
    expect(correspondBlocks(base, current)).toEqual([2, 0]);
  });

  test('1 つの元のブロックを複数のブロックへ対応させない', () => {
    const base = described([['alpha', 'next:a']]);
    const current = described([['alpha1', 'next:a'], ['alpha2', 'next:a']]);
    const pairing = correspondBlocks(base, current).filter((index) => index >= 0);
    expect(pairing).toEqual([0]);
  });

  test('空の入力を扱える', () => {
    expect(correspondBlocks([], described([['a', 'next:a']]))).toEqual([-1]);
    expect(correspondBlocks(described([['a', 'next:a']]), [])).toEqual([]);
  });
});
