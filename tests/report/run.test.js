import { describe, expect, test, vi } from 'vitest';
import { parseReport } from '../../src/report/run.js';

const batch = { files: ['src/a.cpp'] };
const empty = { docsCandidates: [], needsDecision: [], codeImprovements: [] };
const candidate = { file: 'src/a.cpp', lines: '1-3', summary: '仕様を資料へ移す' };
function options() {
  return { batch, runId: 'run-1', baseline: { has: (file) => batch.files.includes(file),
    readMany: vi.fn((files) => new Map(files.map((file) => [file, Buffer.from('// 一\r\n// 二\r\nint a;\r\n')]))) } };
}
function report(value = empty) {
  return `codex-agent: agent=impl-standard\ncodex-agent: run=run-1\n## やったこと\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\ncodex-agent: result=ok\n`;
}

describe('最終報告の解析', () => {
  test('三つの候補を読み、基準ファイルをまとめて確認する', () => {
    const config = options();
    const value = { docsCandidates: [candidate], needsDecision: [{ ...candidate, lines: '2' }], codeImprovements: [] };
    expect(parseReport(report(value), config)).toEqual({ report: value, notes: [] });
    expect(config.baseline.readMany).toHaveBeenCalledWith(['src/a.cpp']);
  });
  test('本文の最後のJSONだけを読み、監査行の後でも見つける', () => {
    const value = { ...empty, needsDecision: [candidate] };
    expect(parseReport(`${report(empty)}\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, options()).report).toEqual(value);
  });
  test('外側のコードフェンス内のJSONらしい行を候補として読まない', () => {
    const text = `\`\`\`\`markdown\n\`\`\`json\n{}\n\`\`\`\n\`\`\`\`\n${report()}`;
    expect(parseReport(text, options()).report).toEqual(empty);
    expect(parseReport('```markdown\n```json\n{}\n```\n', options()).report).toBeNull();
  });
  test('チルダ、長いフェンス、大文字のJSON、CRLFを扱う', () => {
    const text = report().replaceAll('```json', '~~~~JSON').replaceAll('```', '~~~~').replaceAll('\n', '\r\n');
    expect(parseReport(text, options())).toEqual({ report: empty, notes: [] });
  });
  test('JSONや監査行がない場合は記録を添え、検証警告と失敗結果も保持する', () => {
    expect(parseReport('本文のみ', options())).toEqual({ report: null, notes: ['監査行なし', '報告の JSON なし'] });
    const text = report().replace('result=ok', 'warning=child-spawn-failed\ncodex-agent: warning=sandbox-build-failed\ncodex-agent: result=failed');
    expect(parseReport(text, options()).notes).toEqual(['実行結果: failed', '実行者の検証未完了: child-spawn-failed', '実行者の検証未完了: sandbox-build-failed']);
    expect(parseReport(report().replace('agent=impl-standard', 'other=value'), options()).notes).toContain('監査行なし');
    expect(parseReport(report().replace('result=ok', 'other=value'), options()).notes).toContain('監査行なし');
  });
  test('実行IDが未記録か監査行にない報告も取り込める', () => {
    expect(parseReport(report(), { ...options(), runId: null }).report).toEqual(empty);
    expect(parseReport(report().replace('run=run-1', 'other=value'), options()).report).toEqual(empty);
  });
  test('別の実行IDや複数の実行IDは拒否する', () => {
    expect(() => parseReport(report().replace('run=run-1', 'run=other'), options())).toThrow('実行 ID');
    expect(() => parseReport(`${report()}codex-agent: run=other`, { ...options(), runId: null })).toThrow('実行 ID');
  });
  test.each(['```json\n{\n```', '```json\n{}', '```json\n[]\n```', '```json\n{}\n```'])('壊れた最後のJSONを拒否する: %s', (text) => {
    expect(() => parseReport(text, options())).toThrow();
  });
  test.each([{ file: '../a.cpp' }, { file: 'src/other.cpp' }, { file: 'src\\a.cpp' }, { lines: '0' }, { lines: '3-1' },
    { lines: '1-4' }, { lines: '1.5' }, { lines: '9007199254740992' }, { lines: 1 }, { summary: '' }, { summary: null }])('候補の不正な値を拒否する: %j', (change) => {
    expect(() => parseReport(report({ ...empty, docsCandidates: [{ ...candidate, ...change }] }), options())).toThrow();
  });
  test('基準ファイルの欠落や不正なUTF8を拒否する', () => {
    const config = options();
    config.baseline.has = () => false;
    expect(() => parseReport(report({ ...empty, docsCandidates: [candidate] }), config)).toThrow('基準コミット');
    config.baseline.has = () => true;
    config.baseline.readMany = () => new Map([['src/a.cpp', Buffer.from([0xff])]]);
    expect(() => parseReport(report({ ...empty, docsCandidates: [candidate] }), config)).toThrow('UTF-8');
  });
});
