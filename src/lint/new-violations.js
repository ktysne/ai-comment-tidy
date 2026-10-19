import { correspondBlocks } from '../block-correspondence.js';

function countOf(evidence) {
  const counts = new Map();
  for (const item of evidence) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

function consume(counts, item) {
  const count = counts.get(item) ?? 0;
  if (count === 0) return false;
  counts.set(item, count - 1);
  return true;
}

// 規則の根拠が増えたブロックの添字を返す。
// 対応するブロックの根拠を先に消し込み、残りを、ファイル内で消し込まれずに余った元の根拠で消し込む。
function blocksWithNewEvidence(ruleId, current, baseline, pairing) {
  const leftovers = baseline.blocks.map((block) => countOf(block.evidence[ruleId] ?? []));
  const remaining = new Map();
  for (const [index, block] of current.blocks.entries()) {
    if (!block.reported[ruleId]) continue;
    const paired = pairing[index] >= 0 ? leftovers[pairing[index]] : null;
    remaining.set(index, (block.evidence[ruleId] ?? []).filter((item) => !(paired && consume(paired, item))));
  }

  const pool = new Map();
  for (const counts of leftovers) {
    for (const [item, count] of counts) pool.set(item, (pool.get(item) ?? 0) + count);
  }
  const added = new Set();
  for (const [index, evidence] of remaining) {
    if (evidence.filter((item) => !consume(pool, item)).length > 0) added.add(index);
  }
  return added;
}

/**
 * 作業中のコメントの違反のうち、比べる元に無かったものを返す。
 * 比べる元のブロックと対応付け、`length` は対応が無いか行数が増えたとき、
 * ほかの規則は根拠(当たった語)が増えたときに新しい違反とする。
 *
 * @param {{ violations: object[], blocks: object[] }} current `analyzeComments` の結果
 * @param {{ blocks: object[] }} baseline 比べる元のブロック。複数のファイルのものを連ねてよい
 */
export function newViolations(current, baseline) {
  const pairing = correspondBlocks(baseline.blocks, current.blocks);
  const added = new Set();

  for (const [index, block] of current.blocks.entries()) {
    const violation = block.reported.length;
    if (!violation) continue;
    const base = pairing[index] >= 0 ? baseline.blocks[pairing[index]] : null;
    if (!base || block.lineCount > base.lineCount) added.add(violation);
  }

  const ruleIds = new Set(current.violations.map(({ ruleId }) => ruleId));
  ruleIds.delete('length');
  for (const ruleId of ruleIds) {
    for (const index of blocksWithNewEvidence(ruleId, current, baseline, pairing)) {
      added.add(current.blocks[index].reported[ruleId]);
    }
  }

  return current.violations.filter((violation) => added.has(violation));
}

export function filterToRanges(violations, ranges) {
  return violations.filter((violation) => ranges.some((range) => (
    violation.startLine <= range.endLine && violation.endLine >= range.startLine
  )));
}
