import { describe, expect, test } from 'vitest';

import { filterToRanges, newViolations } from '../../src/lint/new-violations.js';

function violation(key, startLine, endLine = startLine) {
  return { key, startLine, endLine };
}

describe('新しい違反の絞り込み', () => {
  test('比べる元にある違反を返さない', () => {
    const current = [violation('issue-ref:a', 4), violation('date:b', 7)];
    expect(newViolations(current, [violation('issue-ref:a', 1)])).toEqual([violation('date:b', 7)]);
  });

  test('コメントの位置だけが動いても新しい違反にしない', () => {
    expect(newViolations([violation('history:body', 9)], [violation('history:body', 2)])).toEqual([]);
  });

  test('本文が変わった違反を新しく返す', () => {
    expect(newViolations([violation('issue-ref:new', 4)], [violation('issue-ref:old', 4)]))
      .toEqual([violation('issue-ref:new', 4)]);
  });

  test('同じ key が増えた数だけ後ろの違反を返す', () => {
    const current = [violation('date:same', 3), violation('date:same', 8)];
    expect(newViolations(current, [violation('date:same', 1)])).toEqual([violation('date:same', 8)]);
  });

  test('指定した行範囲に重なる違反だけを返す', () => {
    const current = [violation('a', 1, 2), violation('b', 3, 5), violation('c', 6, 8)];
    expect(filterToRanges(current, [{ startLine: 2, endLine: 3 }, { startLine: 8, endLine: 9 }]))
      .toEqual([current[0], current[1], current[2]]);
    expect(filterToRanges(current, [{ startLine: 4, endLine: 4 }])).toEqual([current[1]]);
  });
});
