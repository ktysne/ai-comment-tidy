import { relativeFilePath } from '../paths.js';

const CANDIDATE_KEYS = ['docsCandidates', 'needsDecision', 'codeImprovements'];

function lastJsonBlock(body) {
  let fence = null;
  let contents = [];
  let last = null;
  for (const line of body.split(/\r?\n/u)) {
    if (fence !== null) {
      const closing = /^ {0,3}(`+|~+)\s*$/u.exec(line);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
        if (fence.json) last = contents.join('\n');
        fence = null;
      } else if (fence.json) contents.push(line);
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/u.exec(line);
    if (!opening || (opening[1][0] === '`' && opening[2].includes('`'))) continue;
    fence = { marker: opening[1][0], length: opening[1].length, json: opening[2].trim().toLowerCase() === 'json' };
    contents = [];
  }
  if (fence?.json) throw new Error('報告の最後の JSON ブロックが閉じられていません');
  return last;
}

function candidateReport(value, batch, baseline) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('報告の JSON は候補の配列を持つオブジェクトが必要です');
  const selected = new Set(batch.files);
  const report = {};
  for (const key of CANDIDATE_KEYS) {
    if (!Array.isArray(value[key])) throw new Error(`報告の ${key} は配列が必要です`);
    report[key] = value[key].map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.lines !== 'string' || !/^[1-9]\d*(?:-[1-9]\d*)?$/u.test(entry.lines)
        || typeof entry.summary !== 'string' || !entry.summary.trim()) throw new Error(`報告の ${key} の候補の形が不正です`);
      const file = relativeFilePath(entry.file);
      if (file !== entry.file || !selected.has(file)) throw new Error(`報告の候補が担当ファイルではありません: ${entry.file}`);
      const [start, end = start] = entry.lines.split('-').map(Number);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) throw new Error(`基準の行番号の範囲が不正です: ${entry.lines}`);
      return { file, lines: entry.lines, summary: entry.summary };
    });
  }
  const candidates = Object.values(report).flat();
  const files = [...new Set(candidates.map((entry) => entry.file))];
  if (files.some((file) => !baseline.has(file))) throw new Error('報告の候補が基準コミットにありません');
  const contents = baseline.readMany(files);
  const lineCounts = new Map(files.map((file) => {
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(contents.get(file)); }
    catch (error) { throw new Error(`基準ファイルを UTF-8 として読めません: ${file}`, { cause: error }); }
    const count = source.length ? source.split('\n').length - (source.endsWith('\n') ? 1 : 0) : 0;
    return [file, count];
  }));
  for (const entry of candidates) {
    const end = Number(entry.lines.split('-').at(-1));
    if (end > lineCounts.get(entry.file)) throw new Error(`報告の行番号が基準ファイルの範囲外です: ${entry.file}:${entry.lines}`);
  }
  return report;
}

export function parseReport(text, { batch, baseline, runId = null }) {
  const lines = text.split(/\r?\n/u);
  const audit = lines.filter((line) => line.startsWith('codex-agent:'));
  const fieldValues = (field) => audit.flatMap((line) => [...line.matchAll(new RegExp(`(?:^|\\s)${field}=(\\S+)`, 'gu'))].map((match) => match[1]));
  const runIds = [...new Set(fieldValues('run'))];
  if (runIds.length > 1 || (runId !== null && runIds.some((id) => id !== runId))) throw new Error('報告の実行 ID が委譲の記録と一致しません');
  const notes = [];
  const results = fieldValues('result');
  if (!fieldValues('agent').length || !results.length) notes.push('監査行なし');
  for (const result of results) if (result !== 'ok') notes.push(`実行結果: ${result}`);
  for (const warning of fieldValues('warning')) {
    if (['child-spawn-failed', 'sandbox-build-failed'].includes(warning)) notes.push(`実行者の検証未完了: ${warning}`);
  }
  const body = lines.filter((line) => !line.startsWith('codex-agent:')).join('\n');
  const json = lastJsonBlock(body);
  let report = null;
  if (json === null) notes.push('報告の JSON なし');
  else {
    let value;
    try { value = JSON.parse(json); }
    catch (error) { throw new Error(`報告の最後の JSON を読めません: ${error.message}`, { cause: error }); }
    report = candidateReport(value, batch, baseline);
  }
  return { report, notes: [...new Set(notes)] };
}
