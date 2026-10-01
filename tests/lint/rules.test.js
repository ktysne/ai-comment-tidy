import { describe, expect, test } from 'vitest';

import { findViolations } from '../../src/lint/rules.js';

function violations(source, filePath = 'file.js', options = {}) {
  return findViolations(filePath, source, options);
}

describe('コメント規則', () => {
  test('コメントが 3 行なら長さ違反にせず、4 行なら確定違反にする', () => {
    expect(violations('// one\n// two\n// three')).toEqual([]);
    expect(violations('// one\n// two\n// three\n// four').map(({ ruleId, matched }) => ({ ruleId, matched })))
      .toEqual([{ ruleId: 'length', matched: '4 行' }]);
  });

  test('@param とその継続行を長さに数えない', () => {
    const source = '/**\n * one\n * two\n * three\n * @param value description\n *   continued description\n */';
    expect(violations(source, 'file.cpp')).toEqual([]);
  });

  test('ツールの注記行を長さに数えない', () => {
    expect(violations('// one\n// eslint-disable-next-line no-alert\n// two\n// three')).toEqual([]);
  });

  test('ライセンス表示を含むブロックを対象外にする', () => {
    const source = '// Copyright 2026 Example\n// one\n// two\n// three\n// four';
    expect(violations(source)).toEqual([]);
  });

  test('Issue と PR の番号を検出する', () => {
    for (const reference of ['#123', 'PR #45', 'Issue #6']) {
      expect(violations(`// ${reference}`).map(({ ruleId, matched }) => ({ ruleId, matched })))
        .toEqual([{ ruleId: 'issue-ref', matched: reference }]);
    }
  });

  test('色の値と TODO 付きブロック内の番号を番号違反にしない', () => {
    expect(violations('// background is #ff00aa')).toEqual([]);
    expect(violations('// TODO implement this #123')).toEqual([]);
  });

  test('日付を確定違反として検出する', () => {
    expect(violations('// created on 2026-10-02').map(({ ruleId }) => ruleId)).toEqual(['date']);
    expect(violations('// updated in 2026 年 10 月').map(({ ruleId }) => ruleId)).toEqual(['date']);
  });

  test('言語ごとの区切り線を確定違反として検出する', () => {
    expect(violations('// ----------------', 'file.cpp').map(({ ruleId }) => ruleId)).toEqual(['separator']);
    expect(violations('//////////\n// heading\n// body', 'file.js').map(({ ruleId }) => ruleId)).toContain('separator');
    expect(violations('# ----------------', 'file.cmake').map(({ ruleId }) => ruleId)).toEqual(['separator']);
    expect(violations('rem ----------------', 'file.bat').map(({ ruleId }) => ruleId)).toEqual(['separator']);
  });

  test('経緯と変更の記録を見直し候補として検出する', () => {
    expect(violations('// 以前はこの値を使っていた').map(({ ruleId, severity }) => ({ ruleId, severity })))
      .toEqual([{ ruleId: 'history', severity: 'review' }]);
    expect(violations('// 値を変更した').map(({ ruleId, severity }) => ({ ruleId, severity })))
      .toEqual([{ ruleId: 'change-log', severity: 'review' }]);
  });

  test('レビュー、作業意図、マイルストーン、手順番号を見直し候補にする', () => {
    for (const phrase of ['レビュー指摘で追加', '今回の対応', 'フェーズ 2', 'ステップ 3']) {
      expect(violations(`// ${phrase}`).map(({ ruleId, severity }) => ({ ruleId, severity })))
        .toEqual([{ ruleId: 'work-note', severity: 'review' }]);
    }
  });

  test('チケット番号のない TODO、FIXME、HACK を見直し候補にする', () => {
    for (const marker of ['TODO', 'FIXME', 'HACK']) {
      expect(violations(`// ${marker}: implement this`).map(({ ruleId, severity }) => ({ ruleId, severity })))
        .toEqual([{ ruleId: 'todo-no-ticket', severity: 'review' }]);
    }
    for (const ticket of ['ABC-123', '#123', 'https://example.test/ticket/1', 'Tracking']) {
      expect(violations(`// TODO: implement this ${ticket}`)).toEqual([]);
    }
  });

  test('折り返しで分かれた語をつないで検出する', () => {
    expect(violations('// 今回の\n// 対応').map(({ ruleId }) => ruleId)).toEqual(['work-note']);
  });

  test('行末の番号は、次の行が数字で始まっても検出する', () => {
    expect(violations('// 原因は #123\n// 2 回目の呼び出しで起きる').map(({ ruleId }) => ruleId)).toEqual(['issue-ref']);
  });

  test('行末にチケットの番号がある TODO は、次の行が数字で始まっても違反にしない', () => {
    expect(violations('// TODO: 互換の処理を消す #123\n// 2 つの経路がある')).toEqual([]);
  });

  test('allow に指定した一致語を違反にしない', () => {
    expect(violations('// 今回の対応で値を変更した', 'file.js', {
      allow: [{ pattern: '今回の対応', reason: '現行の処理を指す' }],
    }).map(({ ruleId }) => ruleId)).toEqual(['change-log']);
  });

  test('C++、JavaScript、CMake、bat の各言語でコメントを検査する', () => {
    expect(violations('// #12', 'file.cpp').map(({ ruleId }) => ruleId)).toEqual(['issue-ref']);
    expect(violations('// 2026-10-02', 'file.js').map(({ ruleId }) => ruleId)).toEqual(['date']);
    expect(violations('# フェーズ 2', 'file.cmake').map(({ ruleId }) => ruleId)).toEqual(['work-note']);
    expect(violations('rem TODO: later', 'file.bat').map(({ ruleId }) => ruleId)).toEqual(['todo-no-ticket']);
  });

  test('ライセンスとツール注記だけのブロックを全規則から除外する', () => {
    expect(violations('// eslint-disable-next-line no-alert #123')).toEqual([]);
  });
});
