import { fileStats } from '../stats/file-stats.js';
import { statusLabel } from '../state.js';

const REPORT_LABELS = {
  docsCandidates: '資料へ移す候補', needsDecision: '判断が要る事項', codeImprovements: 'コード改善の候補',
};

function commentChars(snapshot, files, config) {
  const missing = files.filter((file) => !snapshot.has(file));
  if (missing.length) return { value: null, missing };
  const contents = snapshot.readMany(files);
  return { value: files.reduce((sum, file) => sum + fileStats(file, contents.get(file), config).commentChars, 0), missing };
}

export function statusForBatches({ definition, baseline, currentByBatch, states, config }) {
  const files = definition.batches.flatMap((batch) => batch.files);
  const missing = files.filter((file) => !baseline.has(file));
  if (missing.length) throw new Error(`基準コミットに担当ファイルがありません: ${missing.join('、')}`);
  const contents = baseline.readMany(files);
  const baselineValues = new Map(files.map((file) => [file, fileStats(file, contents.get(file), config).commentChars]));
  const rows = definition.batches.map((batch) => {
    const state = states.get(batch.id) ?? null;
    const current = currentByBatch.get(batch.id);
    const baseChars = batch.files.reduce((sum, file) => sum + baselineValues.get(file), 0);
    const measured = current ? commentChars(current.snapshot, batch.files, config) : { value: null, missing: [] };
    return {
      id: batch.id, area: batch.area, status: state?.status ?? null, label: statusLabel(state),
      baseChars, currentChars: measured.value,
      ratio: baseChars === 0 || measured.value === null ? null : measured.value / baseChars * 100,
      source: current?.source ?? '作業ツリーなし', missing: measured.missing,
      runId: state?.status === 'delegated' ? state.runId : null, notes: state?.notes ?? [],
    };
  });
  const delegated = rows.filter((row) => row.status === 'delegated').length;
  const slots = Math.max(0, config.implementer.parallel - delegated);
  const next = rows.filter((row) => row.status === null || row.status === 'prepared').slice(0, slots).map((row) => row.id);
  const reports = Object.fromEntries(Object.keys(REPORT_LABELS).map((key) => [key, []]));
  for (const batch of definition.batches) {
    const report = states.get(batch.id)?.report;
    for (const key of Object.keys(reports)) {
      if (report?.[key] === undefined) continue;
      if (!Array.isArray(report[key]) || report[key].some((entry) => !entry || ['file', 'lines', 'summary'].some((field) => typeof entry[field] !== 'string'))) {
        throw new Error(`報告の ${key} の形が不正です: ${batch.id}`);
      }
      reports[key].push(...report[key].map((entry) => ({ ...entry, batch: batch.id })));
    }
  }
  return { pass: definition.pass, base: definition.base, rows, delegated, slots, next, reports, implementer: config.implementer };
}

function cell(value) {
  return String(value).replace(/\|/gu, '\\|').replace(/[\r\n]/gu, ' ');
}

export function formatStatus(result) {
  const lines = [
    `回: ${result.pass}`, `基準コミット: ${result.base}`,
    `実行者: ${result.implementer.agent} / 同時委譲の目安: ${result.implementer.parallel} / 委譲中: ${result.delegated} / 空き: ${result.slots}`,
    '', '| 束 | 領域 | 状態 | 基準の文字数 | 現在の文字数 | 基準比 | 読み取り先 | 実行 ID | 記録 |',
    '|---|---|---|---:|---:|---:|---|---|---|',
  ];
  for (const row of result.rows) {
    const notes = [...row.notes, ...(row.missing.length ? [`担当ファイル欠落: ${row.missing.join('、')}`] : [])];
    lines.push(`| ${[row.id, row.area, row.label, row.baseChars, row.currentChars ?? '未計測', row.ratio === null ? '算出不可' : `${row.ratio.toFixed(1)}%`, row.source, row.status === 'delegated' ? row.runId ?? '未記録' : '-', notes.join('、')].map(cell).join(' | ')} |`);
  }
  if (!result.rows.length) lines.push('', '束はありません。');
  lines.push('', '基準比は現在のコメント文字数 / 基準のコメント文字数です。基準が 0 の束は算出不可です。',
    `次に渡せる束: ${result.next.length ? result.next.join('、') : 'なし'}`);
  for (const [key, label] of Object.entries(REPORT_LABELS)) {
    if (!result.reports[key].length) continue;
    lines.push('', `## ${label}`, '', '| 束 | ファイル | 基準の行 | 内容 |', '|---|---|---|---|');
    for (const entry of result.reports[key]) lines.push(`| ${[entry.batch, entry.file, entry.lines, entry.summary].map(cell).join(' | ')} |`);
  }
  return lines.join('\n');
}
