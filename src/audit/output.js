import { writeManagedFile } from '../run/artifacts.js';
import { AUDIT_CHECKS } from './checks.js';

function codeBlock(lines) {
  const text = lines.join('\n');
  const longest = Math.max(2, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

export function formatAudit(result) {
  const { baseChars, currentChars, ratio, reductionRate } = result.reduction;
  const lines = [`# 束 ${result.batch} の監査`, '', `回: ${result.pass}`, `基準コミット: ${result.base}`,
    `監査日時: ${result.auditedAt}`, '', `コメント文字数: ${baseChars} → ${currentChars}`,
    `基準比: ${ratio === null ? '算出不可' : `${ratio.toFixed(1)}%`}`,
    `削減率: ${reductionRate === null ? '算出不可' : `${reductionRate.toFixed(1)}%`}`, '',
    '削減率は (基準のコメント文字数 - 現在のコメント文字数) / 基準のコメント文字数です。',
    '行番号は作業ツリーの行です。削った文は基準コミット、足した文は作業ツリーから取得しています。'];
  for (const check of AUDIT_CHECKS) {
    const findings = result.findings.filter((finding) => finding.check === check.name);
    lines.push('', `## ${check.label} (${check.name}): ${findings.length} 件`);
    if (!findings.length) lines.push('', '該当なし。');
    for (const finding of findings) {
      lines.push('', `### ${finding.file}:${finding.line}`, '', finding.detail, '', '削った文:', '',
        codeBlock(finding.removed), '', '足した文:', '', codeBlock(finding.added));
    }
  }
  for (const [key, label] of Object.entries({ docsCandidates: '資料へ移す候補', needsDecision: '判断が要る事項', codeImprovements: 'コード改善の候補' })) {
    lines.push('', `## ${label}`, '', '行番号は基準コミットの行です。');
    if (!result.reports[key].length) lines.push('', '候補なし。');
    for (const candidate of result.reports[key]) {
      lines.push('', `### ${candidate.file}:${candidate.lines}`, '', candidate.summary);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function writeAudit(repoRoot, outputs, result) {
  // 後の段階が読む JSON を先に書き、Markdown だけが新しく残る状態を作らない。
  writeManagedFile(repoRoot, outputs.json, `${JSON.stringify(result, null, 2)}\n`);
  writeManagedFile(repoRoot, outputs.markdown, formatAudit(result));
}
