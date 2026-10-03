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

  test('括弧などに続く番号は、番号だけを当たった語として報告する', () => {
    expect(violations('// 原因(#12)').map(({ matched }) => matched)).toEqual(['#12']);
    expect(violations('// 原因(#12)', 'file.js', { allow: [{ pattern: '#12', reason: '試験' }] })).toEqual([]);
  });

  test('日付を確定違反として検出する', () => {
    for (const text of ['created on 2026-10-02', 'updated in 2026 年 10 月', '2026年10月2日に決めた', '2026/10/02 に決めた']) {
      expect(violations(`// ${text}`).map(({ ruleId }) => ruleId)).toEqual(['date']);
    }
  });

  test('パスの一部と見出し参照に含まれる日付は検出しない', () => {
    for (const text of [
      'docs/handover/2026-08-19.md',
      'docs\\handover\\2026-08-19.md',
      'archive/2026-08-19 の記録',
      '資料 2026-08-19.md を参照',
      'docs/03.md「決定事項(2026-08-12)」',
    ]) {
      expect(violations(`// ${text}`).map(({ ruleId }) => ruleId)).not.toContain('date');
    }
    expect(violations('// 2026-07-25: 3 件では').map(({ ruleId }) => ruleId)).toEqual(['date']);
    expect(violations('// docs/03.md「決定事項(\n// 2026-08-12)」').map(({ ruleId }) => ruleId)).toEqual(['date']);
  });

  test('チケットに見えるだけの語がある TODO は、チケットなしとして扱う', () => {
    for (const text of ['TODO: UTF-8 対応', 'TODO: x-1 の値', 'TODO: tracking 方法を決める']) {
      expect(violations(`// ${text}`).map(({ ruleId }) => ruleId)).toEqual(['todo-no-ticket']);
    }
  });

  test('言語ごとの区切り線を確定違反として検出する', () => {
    expect(violations('// ----------------', 'file.cpp').map(({ ruleId }) => ruleId)).toEqual(['separator']);
    expect(violations('//////////', 'file.cs').map(({ ruleId }) => ruleId)).toEqual(['separator']);
    expect(violations('//////////\n// heading\n// body', 'file.js').map(({ ruleId }) => ruleId)).toContain('separator');
    expect(violations('# ----------------', 'file.cmake').map(({ ruleId }) => ruleId)).toEqual(['separator']);
    expect(violations('rem ----------------', 'file.bat').map(({ ruleId }) => ruleId)).toEqual(['separator']);
  });

  test('経緯と変更の記録を見直し候補として検出する', () => {
    for (const text of ['以前はこの値を使っていた', '従来はこの値を使う', '旧実装の制約', '当初はこの値を使った']) {
      expect(violations(`// ${text}`).map(({ ruleId, severity }) => ({ ruleId, severity })))
        .toContainEqual({ ruleId: 'history', severity: 'review' });
    }
    expect(violations('// 値を変更した').map(({ ruleId, severity }) => ({ ruleId, severity })))
      .toEqual([{ ruleId: 'change-log', severity: 'review' }]);
  });

  test('実行時の状態を表す変更記録候補は検出しない', () => {
    for (const text of ['動作中だった', '参照していたパス', '埋まっていた。', '現行になったので']) {
      expect(violations(`// ${text}`).map(({ ruleId }) => ruleId)).not.toContain('change-log');
    }
  });

  test('変更の動詞は文末か理由の接続で検出する', () => {
    for (const text of [
      '値に変えた。',
      'Y に変えたので',
      '値へ変えたので',
      '使用をやめた。',
      '機能を廃止した。',
      '値に直した。',
      '値を直した。',
      'コードを修正した。',
      '設定を変更した。',
      'X を追加した。',
      'X を追加\n//した。',
      '値を変更した。\r\n// 次の行',
      'Z を削除した',
      '項目を入れ替えた。',
      'テイクを置き換えた。',
      'メニューへ移した。',
      '(m.level をここへ移した)',
      '使えるようになったので',
      '使えるようになったため',
    ]) {
      expect(violations(`// ${text}`).map(({ ruleId }) => ruleId)).toContain('change-log');
    }
  });

  test('文末や理由の接続でない変更の動詞は検出しない', () => {
    for (const text of [
      '追加したトラックごと控えへ戻す',
      '全部を削除した状態',
      '置き換えたテイクがある',
      '階層を直した値',
      'メニューへ移した操作は使える',
      '項目を追加したばかりの状態',
      'ファイルを削除した後に処理する',
      '値を移した先を参照する',
      'X を追加した\n// トラックごと控えへ戻す',
      '値を変更した\n// 理由は X のため',
    ]) {
      expect(violations(`// ${text}`).map(({ ruleId }) => ruleId)).not.toContain('change-log');
    }
  });

  test('実行時の状態やテスト手順に使う履歴候補語は検出しない', () => {
    for (const text of ['以前の出力', '最初はバイパスのまま', 'リリース前のため旧形式の互換は持たない']) {
      expect(violations(`// ${text}`).map(({ ruleId }) => ruleId)).not.toContain('history');
    }
  });

  test('レビュー、作業意図、マイルストーン、手順番号を見直し候補にする', () => {
    for (const phrase of ['レビュー指摘で追加', '今回の対応', 'M3: 完了条件', 'フェーズ 2', 'ステップ 3']) {
      expect(violations(`// ${phrase}`).map(({ ruleId, severity }) => ({ ruleId, severity })))
        .toEqual([{ ruleId: 'work-note', severity: 'review' }]);
    }
  });

  test('段階ラベルの参照と試みの説明は作業記録として検出しない', () => {
    for (const text of [
      '確保しようとした結果',
      'docs/07-ui-design.md「波形編集の操作(M3)」',
      'docs/11 段階 4',
      'docs/06-milestones.md M2 完了条件',
      '戻し先は全区間の組(docs/11 段階 4)。',
      '設定を復元する (docs/06-milestones.md M2 完了条件 1)。',
    ]) {
      expect(violations(`// ${text}`).map(({ ruleId }) => ruleId)).not.toContain('work-note');
    }
    expect(violations('// docs/07-ui-design.md「波形編集の操作(\n//M3)」').map(({ ruleId }) => ruleId))
      .toContain('work-note');
  });

  test('作業意図の語と参照でない段階ラベルを検出する', () => {
    for (const text of [
      '消したかった',
      '削ろうとした',
      '直したかった',
      'フェーズ 2 で導入する',
      'ステップ 3: 値を更新する',
    ]) {
      expect(violations(`// ${text}`).map(({ ruleId }) => ruleId)).toContain('work-note');
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

  test('C# のコメントだけを検査し、文字列内の Issue 番号を無視する', () => {
    expect(violations('// #12', 'file.cs').map(({ ruleId }) => ruleId)).toEqual(['issue-ref']);
    expect(violations('var text = "// #12";', 'file.cs')).toEqual([]);
  });

  test('TypeScript のコメントだけを検査し、文字列内の Issue 番号を無視する', () => {
    expect(violations('// #12', 'file.ts').map(({ ruleId }) => ruleId)).toEqual(['issue-ref']);
    expect(violations('const text = "// #12";', 'file.ts')).toEqual([]);
  });

  test('ライセンスとツール注記だけのブロックを全規則から除外する', () => {
    expect(violations('// eslint-disable-next-line no-alert #123')).toEqual([]);
  });
});
