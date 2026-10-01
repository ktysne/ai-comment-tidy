export function newViolations(current, baseline) {
  const remaining = new Map();
  for (const violation of baseline) {
    remaining.set(violation.key, (remaining.get(violation.key) ?? 0) + 1);
  }

  const added = [];
  for (const violation of current) {
    const count = remaining.get(violation.key) ?? 0;
    if (count > 0) remaining.set(violation.key, count - 1);
    else added.push(violation);
  }
  return added;
}

export function filterToRanges(violations, ranges) {
  return violations.filter((violation) => ranges.some((range) => (
    violation.startLine <= range.endLine && violation.endLine >= range.startLine
  )));
}
