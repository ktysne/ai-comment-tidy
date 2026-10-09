import { describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { inspectHunks } from '../../src/audit/checks.js';
import { auditCommentLines } from '../../src/audit/hunks.js';
import { formatAudit } from '../../src/audit/output.js';

function inspect(before, after, { documents = {}, extraComments = '', config = loadConfig('unused') } = {}) {
  const file = 'src/a.cpp';
  const removed = [...auditCommentLines(file, Buffer.from(before), config).values()];
  const added = [...auditCommentLines(file, Buffer.from(after), config).values()];
  const currentLines = auditCommentLines(file, Buffer.from(after + extraComments), config);
  return inspectHunks({ hunks: [{ file, line: 1, removed, added, context: [] }], currentLines, config,
    target: { listFiles: () => Object.keys(documents), read: (name) => Buffer.from(documents[name]) } });
}

describe('監査の既定の検査', () => {
  test('CRLFとBOMを除いて行を対応させ、文字列やコメントの空本文を含めない', () => {
    const rows = auditCommentLines('src/a.cpp', Buffer.from('\ufeffconst char* x = "// スレッド";\r\nint a; // 所有\r\n/*\r\n * 丸め\r\n */ int b;\r\n'), loadConfig('unused'));
    expect([...rows.keys()]).toEqual([2, 4]);
    expect([...rows.values()].map((row) => row.body)).toEqual(['所有', '丸め']);
  });
  test('ライセンスのブロックから重要語や逃げ言葉を拾わない', () => {
    expect(inspect('// Copyright\n// スレッド\n', '// Copyright\n// 適宜\n')).toEqual([]);
  });
  test('追加、他のコメント、参照先で保持された語を消失にしない', () => {
    expect(inspect('// スレッド\n', '// スレッドを管理する\n')).toEqual([]);
    expect(inspect('// スレッド\n', '', { extraComments: '// スレッドを管理する\n' })).toEqual([]);
    expect(inspect('// スレッド\n', '// docs/policy「制約」\n', {
      documents: { 'docs/policy.md': '# 制約（補足）\nスレッドの制約\n' },
    })).toEqual([]);
  });
  test('未参照の資料の語や英字の部分一致では重要語を保持したことにしない', () => {
    const findings = inspect('// atomic ms TODO\n', '// atomically items TODOs\n', {
      documents: { 'docs/policy.md': '# 制約\natomic ms TODO\n' },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('keyword-loss');
    for (const word of ['atomic', 'ms', 'TODO']) expect(findings[0].detail).toContain(word);
    expect(inspect('// atomically items TODOs\n', '')).toEqual([]);
  });
  test('設定の語群を既定の語群へ追加し、新しい名前も使う', () => {
    const config = loadConfig('unused');
    config.audit = { keywordGroups: { '互換': ['独自キー'], '仕様': ['規約'] } };
    const [finding] = inspect('// 互換 独自キー 規約\n', '', { config });
    expect(finding.detail).toContain('互換: 互換、独自キー');
    expect(finding.detail).toContain('仕様: 規約');
  });
  test('空行を除いて4行以上のコメントの削除を拾い、追加があれば拾わない', () => {
    const source = '/*\n * 一\n * 二\n *\n * 三\n * 四\n */\n';
    expect(inspect(source, '').map((finding) => finding.check)).toEqual(['full-delete']);
    expect(inspect(source, '// 要約\n')).toEqual([]);
    expect(inspect('/*\n * 一\n * 二\n *\n */\n', '')).toEqual([]);
  });
  test('逃げ言葉と不存在の見出しを拾い、資料のコードフェンス内の見出しを認めない', () => {
    const findings = inspect('', '// など 適宜 必要に応じて 適切に\n// docs/policy「偽の節」\n// docs/policy「有効」\n', {
      documents: { 'docs/policy.md': '# 有効な節（補足）\n```md\n# 偽の節\n```\n' },
    });
    expect(findings.map((finding) => finding.check)).toEqual(['hedge', 'missing-ref']);
    expect(findings[1]).toMatchObject({ line: 2, detail: '実在しない参照: policy「偽の節」' });
  });
  test('hunkがなければ資料を読まず該当なしにする', () => {
    expect(inspectHunks({ hunks: [], currentLines: new Map(), config: loadConfig('unused'), target: null })).toEqual([]);
  });
  test('Markdownに全該当の削除と追加、削減率と報告候補を残す', () => {
    const findings = inspect('// 所有\n', '// 適宜\n');
    const markdown = formatAudit({ pass: 'volume', batch: 'V01', base: 'a'.repeat(40), auditedAt: '2026-10-09T00:00:00Z',
      findings, reduction: { baseChars: 4, currentChars: 3, ratio: 75, reductionRate: 25 },
      reports: { docsCandidates: [{ file: 'src/a.cpp', lines: '1', summary: '資料に書く' }], needsDecision: [], codeImprovements: [] } });
    for (const finding of findings) {
      expect(markdown).toContain(finding.detail);
      expect(markdown).toContain(`${finding.file}:${finding.line}`);
      for (const line of [...finding.removed, ...finding.added]) expect(markdown).toContain(line);
    }
    expect(markdown).toContain('削減率: 25.0%');
    expect(markdown).toContain('資料に書く');
  });
});
