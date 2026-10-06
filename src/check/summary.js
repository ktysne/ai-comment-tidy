export function formatSummary(result) {
  const lines = [
    `check: ${result.ok ? '合格' : '不合格'}`,
    `対象ファイル: ${result.files.length} 件`,
    `不合格: ${result.failures.length} 件、警告: ${result.warnings.length} 件`,
  ];
  for (const item of [...result.failures, ...result.warnings]) {
    lines.push(`${item.file}${item.line === undefined ? '' : `:${item.line}`} [${item.check}] ${item.detail}`);
  }
  return lines.join('\n');
}
