import { describe, expect, test } from 'vitest';

import { filterToRanges, newViolations } from '../../src/lint/new-violations.js';
import { analyzeComments } from '../../src/lint/rules.js';

function added(before, after, options = {}) {
  const current = analyzeComments('file.js', after, options);
  const baseline = analyzeComments('file.js', before, options);
  return newViolations(current, baseline).map(({ ruleId, startLine }) => ({ ruleId, startLine }));
}

function ruleIds(before, after, options) {
  return added(before, after, options).map(({ ruleId }) => ruleId);
}

function lines(...rows) {
  return `${rows.join('\n')}\n`;
}

describe('新しい違反の絞り込み', () => {
  test('比べる元と同じ内容なら、既存の違反を返さない', () => {
    const source = lines('// 長い説明 #259', '// 二行目', '// 三行目', '// 四行目', 'function a() {}');
    expect(added(source, source)).toEqual([]);
  });

  test('位置が動いただけのコメントを新しい違反にしない', () => {
    const before = lines('// #259 の対応', 'function a() {}');
    const after = lines('const value = 1;', 'const other = 2;', '', '// #259 の対応', 'function a() {}');
    expect(added(before, after)).toEqual([]);
  });

  test('経緯の 1 文だけを削ったブロックの既存の length と issue-ref を報告しない', () => {
    const before = lines(
      '// 一行目の説明。',
      '// 二行目の説明 #259。',
      '// 三行目の説明。',
      '// 以前はこうだったという経緯。',
      '// 五行目の説明。',
      'function a() {}',
    );
    const after = lines(
      '// 一行目の説明。',
      '// 二行目の説明 #259。',
      '// 三行目の説明。',
      '// 五行目の説明。',
      'function a() {}',
    );
    expect(analyzeComments('file.js', after).violations.map(({ ruleId }) => ruleId)).toEqual(['length', 'issue-ref']);
    expect(added(before, after)).toEqual([]);
  });

  test('同じブロックの #259 だけを消しても、残った #300 を報告しない', () => {
    const before = lines('// 一行目 #259', '// 二行目 #300', 'function a() {}');
    const after = lines('// 一行目', '// 二行目 #300', 'function a() {}');
    expect(added(before, after)).toEqual([]);
  });

  test('Issue #259 を #259 に書き換えても報告しない', () => {
    const before = lines('// Issue #259 の対応', 'function a() {}');
    const after = lines('// #259 の対応', 'function a() {}');
    expect(added(before, after)).toEqual([]);
  });

  test('同じ番号を同じファイルの別のブロックへ移しても報告しない', () => {
    const before = lines('// 一つ目 #259', 'function a() {}', '', '// 二つ目', 'function b() {}');
    const after = lines('// 一つ目', 'function a() {}', '', '// 二つ目 #259', 'function b() {}');
    expect(added(before, after)).toEqual([]);
  });

  test('同じ番号をもう 1 か所に足したときは報告する', () => {
    const before = lines('// 一つ目 #259', 'function a() {}', '', '// 二つ目', 'function b() {}', '', '// 三つ目', 'function c() {}');
    const after = lines('// 一つ目', 'function a() {}', '', '// 二つ目 #259', 'function b() {}', '', '// 三つ目 #259', 'function c() {}');
    expect(added(before, after)).toEqual([{ ruleId: 'issue-ref', startLine: 7 }]);
  });

  test('ブロックの番号が増えたときは報告する', () => {
    const before = lines('// 説明 #259', 'function a() {}');
    const after = lines('// 説明 #259 と #300', 'function a() {}');
    expect(added(before, after)).toEqual([{ ruleId: 'issue-ref', startLine: 1 }]);
  });

  test('追跡先を消して番号が残ると issue-ref を報告する', () => {
    const before = lines('// 追跡先 #259', 'function a() {}');
    const after = lines('// 理由の説明 #259', 'function a() {}');
    expect(added(before, after)).toEqual([{ ruleId: 'issue-ref', startLine: 1 }]);
  });

  test('日付は数字の並びで照合し、書式が変わっても報告しない', () => {
    const before = lines('// 2026-10-02 に決めた', 'function a() {}');
    expect(ruleIds(before, lines('// 2026/10/02 に決めた理由', 'function a() {}'))).toEqual([]);
    expect(ruleIds(before, lines('// 2026-10-03 に決めた', 'function a() {}'))).toEqual(['date']);
  });

  test('区切り線は行の前後の空白を除いて照合する', () => {
    const before = lines('// ----------', '// 説明', 'function a() {}');
    expect(ruleIds(before, lines('  // ----------  ', '// 説明を補う', 'function a() {}'))).toEqual([]);
    expect(ruleIds(before, lines('// ==========', '// 説明', 'function a() {}'))).toEqual(['separator']);
  });

  test('経緯の語などは、空白を除いた当たった語で照合する', () => {
    const before = lines('// 以前は別の値だった', 'function a() {}');
    expect(ruleIds(before, lines('// 以前は 別の値を使った', 'function a() {}'))).toEqual([]);
    expect(ruleIds(before, lines('// 以前は別の値だった。従来どおり使う', 'function a() {}'))).toEqual(['history']);
  });

  test('ブロックの行数が増えたときは length を報告する', () => {
    const before = lines('// 一', '// 二', '// 三', '// 四', 'function a() {}');
    const after = lines('// 一', '// 二', '// 三', '// 四', '// 五', 'function a() {}');
    expect(ruleIds(before, after)).toEqual(['length']);
  });

  test('ブロックの行数が減ったときと変わらないときは length を報告しない', () => {
    const before = lines('// 一', '// 二', '// 三', '// 四', '// 五', 'function a() {}');
    expect(ruleIds(before, lines('// 一', '// 二', '// 三', '// 四', 'function a() {}'))).toEqual([]);
    expect(ruleIds(before, lines('// 壱', '// 弐', '// 参', '// 四', '// 五', 'function a() {}'))).toEqual([]);
  });

  test('2 つのブロックを 1 つにまとめて上限を超えたときは length を報告する', () => {
    const before = lines('// a1', '// a2', '// a3', '', '// b1', '// b2', '// b3', 'function f() {}');
    const after = lines('// a1', '// a2', '// a3', '// b1', '// b2', '// b3', 'function f() {}');
    expect(ruleIds(before, after)).toEqual(['length']);
  });

  test('長いコメントの直後の関数の名前だけを変えても報告しない', () => {
    const before = lines('// 一', '// 二', '// 三', '// 四 #259', 'function oldName() {}');
    const after = lines('// 一', '// 二', '// 三', '// 四 #259', 'function newName() {}');
    expect(added(before, after)).toEqual([]);
  });

  test('新しく足したブロックは、すべての違反を報告する', () => {
    const before = lines('// 説明', 'function a() {}');
    const after = lines(
      '// 説明',
      'function a() {}',
      '',
      '// 一',
      '// 二 #77',
      '// 三 2026-10-02',
      '// 四 以前は別だった',
      '// ----------',
      'function b() {}',
    );
    expect(ruleIds(before, after)).toEqual(['length', 'issue-ref', 'date', 'separator', 'history']);
  });

  test('比べる元に無い(空の)ファイルは、すべての違反を報告する', () => {
    const after = lines('// 説明 #259', 'function a() {}');
    expect(ruleIds('', after)).toEqual(['issue-ref']);
  });

  test('直後のコードの行が同じブロックの間の 1 つを消しても、後続の対応がずれない', () => {
    const body = (name, count, word) => [
      `function ${name}() {`,
      ...Array.from({ length: count }, (_, index) => `  // ${name} の説明 ${index + 1} 行目 ${word}`),
      '}',
    ];
    const before = lines(
      ...body('alpha', 4, '元'),
      ...body('beta', 7, '元'),
      ...body('gamma', 4, '元'),
      ...body('delta', 5, '元'),
    );
    const after = lines(
      ...body('alpha', 4, '直'),
      ...body('gamma', 4, '直'),
      ...body('delta', 5, '直'),
    );
    expect(added(before, after)).toEqual([]);
  });

  test('ファイルの末尾や空行を挟んで次もコメントのブロックは、直前のコードの行で対応する', () => {
    const before = lines('const a = 1;', '', '// 一', '// 二', '// 三', '// 四', '', '// 次の説明');
    const after = lines('const a = 1;', '', '// 壱', '// 弐', '// 参', '// 四', '', '// 次の説明');
    expect(added(before, after)).toEqual([]);
  });

  test('allow に当たる語は根拠にしない', () => {
    const options = { allow: [{ pattern: '#259', reason: '試験' }] };
    const before = lines('// 説明 #300', 'function a() {}');
    expect(ruleIds(before, lines('// 説明 #300 と #259', 'function a() {}'), options)).toEqual([]);
    expect(ruleIds(before, lines('// 説明 #300 と #301', 'function a() {}'), options)).toEqual(['issue-ref']);
  });

  test('先頭の当たりが allow のブロックの根拠も、同じ番号の追加を打ち消さない', () => {
    const options = { allow: [{ pattern: '#333', reason: '試験' }] };
    const before = lines('// #333 と #259', 'function a() {}');
    const after = lines('// #333 と #259', 'function a() {}', '// #259', 'function b() {}');
    expect(added(before, after, options)).toEqual([{ ruleId: 'issue-ref', startLine: 3 }]);
  });

  test('本文が同じで行数の違うブロックを関数ごと並べ替えても length を報告しない', () => {
    // 空白を除いた本文が同じになるよう、同じ文を 4、5、6 行に折り返す。
    const wrap = (count) => Array.from({ length: count }, (_, index) => `// ${'あいうえおかきくけこさしすせそたちつてと'.slice(index * 20 / count, (index + 1) * 20 / count)}`);
    const block = (count, name) => [...wrap(count), `function ${name}() {}`];
    const before = lines(...block(4, 'a'), ...block(5, 'b'), ...block(6, 'c'));
    const after = lines(...block(6, 'c'), ...block(5, 'b'), ...block(4, 'a'));
    expect(analyzeComments('file.js', after).violations.map(({ ruleId }) => ruleId)).toEqual(['length', 'length', 'length']);
    expect(added(before, after)).toEqual([]);
  });

  test('指定した行範囲に重なる違反だけを返す', () => {
    const violation = (startLine, endLine = startLine) => ({ startLine, endLine });
    const current = [violation(1, 2), violation(3, 5), violation(6, 8)];
    expect(filterToRanges(current, [{ startLine: 2, endLine: 3 }, { startLine: 8, endLine: 9 }]))
      .toEqual([current[0], current[1], current[2]]);
    expect(filterToRanges(current, [{ startLine: 4, endLine: 4 }])).toEqual([current[1]]);
  });
});
