import { describe, expect, test } from 'vitest';

import { formatReport } from '../../src/lint/report.js';

describe('lint の表示', () => {
  test('違反を一件一行で表示し、件数を末尾に出す', () => {
    const report = formatReport({
      files: [{ path: 'src/foo.cpp', violations: [{
        ruleId: 'length', severity: 'confirmed', startLine: 12, endLine: 16,
        matched: '5 行', hint: '3 行までに縮める。',
      }] }],
      confirmed: 1,
      review: 0,
    });
    expect(report).toBe('src/foo.cpp:12-16 [確定] length: 5 行 → 3 行までに縮める。\n確定: 1 件、見直し候補: 0 件');
  });

  test('見直し候補があるときは読み直す案内を添える', () => {
    expect(formatReport({
      files: [{ path: 'src/foo.js', violations: [{
        ruleId: 'history', severity: 'review', startLine: 1, endLine: 1,
        matched: '以前は', hint: '現在の仕様として書く。',
      }] }],
      confirmed: 0,
      review: 1,
    })).toContain('見直し候補は、読み直して問題が無ければそのままでよい');
  });

  test('違反が無ければ空文字を返す', () => {
    expect(formatReport({ files: [], confirmed: 0, review: 0 })).toBe('');
  });
});
