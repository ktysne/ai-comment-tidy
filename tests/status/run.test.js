import { describe, expect, test, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { transitionState } from '../../src/state.js';
import { formatStatus, statusForBatches } from '../../src/status/run.js';

function snapshot(contents) {
  return { has: (file) => Object.hasOwn(contents, file), readMany: vi.fn((files) => new Map(files.map((file) => [file, Buffer.from(contents[file])]))) };
}
function setup(statuses = [null, 'prepared', 'delegated', 'reported', 'checked', 'applied']) {
  const definition = { pass: 'volume', base: 'a'.repeat(40), batches: statuses.map((_, index) => ({ id: `V0${index + 1}`, area: 'src', files: [`${index}.cpp`], commentChars: 999 })) };
  const baseline = snapshot(Object.fromEntries(statuses.map((_, index) => [`${index}.cpp`, '// abcd\n'])));
  const current = snapshot(Object.fromEntries(statuses.map((_, index) => [`${index}.cpp`, '// a\n'])));
  const states = new Map(statuses.map((status, index) => [definition.batches[index].id, status === null ? null : { status, runId: 'run-123', notes: [], report: null }]));
  return { definition, baseline, states, currentByBatch: new Map(definition.batches.map((batch) => [batch.id, { snapshot: current, source: '束の作業ツリー' }])), config: loadConfig('unused') };
}

describe('束の状態と進み具合', () => {
  test('状態の日本語、委譲中の実行ID、基準から読み直した文字数を表示する', () => {
    const options = setup();
    const result = statusForBatches(options);
    expect(result.rows.map((row) => row.label)).toEqual(['未着手', '用意済み', '委譲中', '報告あり', '検査済み', '取り込み済み']);
    expect(result.rows[0]).toMatchObject({ baseChars: 6, currentChars: 3, ratio: 50, runId: null });
    expect(result.rows[2].runId).toBe('run-123');
    expect(options.baseline.readMany).toHaveBeenCalledTimes(1);
    expect(result.next).toEqual(['V01']);
    expect(formatStatus(result)).toContain('50.0%');
  });
  test('委譲中の数を差し引き、未着手と用意済みだけを定義順で選ぶ', () => {
    const options = setup(['reported', 'prepared', null, 'checked']);
    expect(statusForBatches(options).next).toEqual(['V02', 'V03']);
    options.config.implementer.parallel = 1;
    expect(statusForBatches(options).next).toEqual(['V02']);
    expect(statusForBatches(setup(['delegated', 'delegated', 'delegated', null])).next).toEqual([]);
  });
  test('基準がゼロ、現在値が増加、作業ツリーなし、欠落を区別する', () => {
    const options = setup([null, null, null, null]);
    options.baseline = snapshot({ '0.cpp': 'int x;', '1.cpp': '// a', '2.cpp': '// a', '3.cpp': '// a' });
    options.currentByBatch.set('V02', { snapshot: snapshot({ '1.cpp': '// abcd' }), source: '束の作業ツリー' });
    options.currentByBatch.delete('V03');
    options.currentByBatch.set('V04', { snapshot: snapshot({}), source: '束の作業ツリー' });
    const result = statusForBatches(options);
    expect(result.rows[0]).toMatchObject({ baseChars: 0, ratio: null });
    expect(result.rows[1].ratio).toBe(200);
    expect(result.rows[2]).toMatchObject({ source: '作業ツリーなし', currentChars: null });
    expect(result.rows[3]).toMatchObject({ currentChars: null, missing: ['3.cpp'] });
    expect(formatStatus(result)).toContain('担当ファイル欠落: 3.cpp');
  });
  test('基準の欠落、未対応の言語、壊れたUTF8を誤って集計しない', () => {
    const options = setup([null]);
    options.baseline = snapshot({});
    expect(() => statusForBatches(options)).toThrow('基準コミット');
    options.baseline = { has: () => true, readMany: () => new Map([['0.cpp', Buffer.from([0xff])]]) };
    expect(() => statusForBatches(options)).toThrow('UTF-8');
    options.baseline = snapshot({ '0.cpp': '// a' });
    options.config.languages = { js: ['**/*.js'] };
    expect(() => statusForBatches(options)).toThrow('対応する言語');
  });
  test('報告の候補を束をまたいで集め、表の区切りや改行を処理する', () => {
    const options = setup(['reported', 'checked']);
    for (const state of options.states.values()) state.report = { needsDecision: [{ file: 'a.cpp', lines: '1-3', summary: 'A|B\n判断' }] };
    options.states.get('V01').notes = ['監査行なし'];
    const result = statusForBatches(options);
    expect(result.reports.needsDecision.map((entry) => entry.batch)).toEqual(['V01', 'V02']);
    expect(formatStatus(result)).toContain('A\\|B 判断');
    expect(formatStatus(result)).toContain('監査行なし');
    options.states.get('V01').report.docsCandidates = {};
    expect(() => statusForBatches(options)).toThrow('docsCandidates');
  });
  test('束がない回でも空の表示と空の候補を返す', () => {
    const result = statusForBatches(setup([]));
    expect(result.next).toEqual([]);
    expect(formatStatus(result)).toContain('束はありません');
  });
  test('実際の状態遷移でできた記録を読み取れる', () => {
    const options = setup(['prepared']);
    options.states.set('V01', transitionState(null, 'prepared', { pass: 'volume', batch: 'V01' }));
    expect(statusForBatches(options).rows[0].label).toBe('用意済み');
  });
});
