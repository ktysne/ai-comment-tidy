function lineRange(violation) {
  return `${violation.startLine}-${violation.endLine}`;
}

export function formatReport(result) {
  const violations = result.files.flatMap(({ path, violations: fileViolations }) => (
    fileViolations.map((violation) => ({ path, violation }))
  ));
  if (violations.length === 0) return '';

  const lines = violations.map(({ path, violation }) => {
    const severity = violation.severity === 'confirmed' ? '確定' : '見直し候補';
    return `${path}:${lineRange(violation)} [${severity}] ${violation.ruleId}: ${violation.matched} → ${violation.hint}`;
  });
  lines.push(`確定: ${result.confirmed} 件、見直し候補: ${result.review} 件`);
  if (result.review > 0) lines.push('見直し候補は、読み直して問題が無ければそのままでよい');
  return lines.join('\n');
}
