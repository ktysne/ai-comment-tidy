import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { createGitSnapshot, resolveCommit } from '../snapshot/git.js';
import { VALUE_NAMES } from './file-stats.js';
import { emptyValues, statsForSnapshot } from './run.js';

function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} の後に値を指定してください`);
  return value;
}

function parseArgs(argv) {
  const parsed = { prefixes: [] };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--repo' || argument === '--ref' || argument === '--out' || argument === '--config') {
      if (seen.has(argument)) throw new Error(`${argument} は 1 つだけ指定できます`);
      seen.add(argument);
      parsed[{
        '--repo': 'repoRoot',
        '--ref': 'ref',
        '--out': 'out',
        '--config': 'configPath',
      }[argument]] = requiredValue(argv, index, argument);
      index++;
    } else if (argument === '--paths') {
      const start = index + 1;
      while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) parsed.prefixes.push(argv[++index].replace(/\\/g, '/'));
      if (index + 1 === start) throw new Error('--paths の後に接頭辞を 1 つ以上指定してください');
    } else {
      throw new Error(`認識できない引数です: ${argument}`);
    }
  }
  if (parsed.configPath !== undefined && !path.isAbsolute(parsed.configPath) && !path.win32.isAbsolute(parsed.configPath)) {
    throw new Error('--config には絶対パスを指定してください');
  }
  return parsed;
}

function isStats(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readComparison(label, filePath) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} の JSON を読めません: ${error.message}`, { cause: error });
  }
  if (!isStats(value) || value.schemaVersion !== 1 || !isStats(value.totals)) {
    throw new Error(`${label} は schemaVersion 1 の集計 JSON ではありません`);
  }
  for (const [area, totals] of Object.entries(value.totals)) {
    if (!isStats(totals) || VALUE_NAMES.some((name) => !Number.isFinite(totals[name]) || totals[name] < 0)) {
      throw new Error(`${label} の領域 ${area} の集計値が不正です`);
    }
  }
  return { label, totals: value.totals };
}

function metricTotals(totals) {
  const result = emptyValues();
  for (const values of Object.values(totals)) {
    for (const name of VALUE_NAMES) result[name] += values[name];
  }
  return result;
}

function markdownCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function comparisonTable(title, comparisons) {
  const header = `| 値 | ${comparisons.map(({ label }) => markdownCell(label)).join(' | ')} |`;
  const separator = `|---|${comparisons.map(() => '---:').join('|')}|`;
  const body = VALUE_NAMES.map((name) => `| ${name} | ${comparisons.map(({ totals }) => totals[name] ?? 0).join(' | ')} |`);
  return [`## ${markdownCell(title)}`, header, separator, ...body].join('\n');
}

export function formatComparison(comparisons) {
  const areas = [...new Set(comparisons.flatMap(({ totals }) => Object.keys(totals)))].sort();
  const tables = areas.map((area) => comparisonTable(area, comparisons.map(({ label, totals }) => ({ label, totals: totals[area] ?? emptyValues() }))));
  const wholeTotals = comparisons.map(({ label, totals }) => ({ label, totals: metricTotals(totals) }));
  tables.push(comparisonTable('全体', wholeTotals));
  return tables.join('\n\n');
}

function parseComparisons(argv) {
  if (argv.length < 3) throw new Error('--compare には名前=JSONファイルを 2 つ以上指定してください');
  const names = new Set();
  return argv.slice(1).map((item) => {
    const separator = item.indexOf('=');
    const label = separator < 1 ? '' : item.slice(0, separator);
    const filePath = separator < 0 ? '' : item.slice(separator + 1);
    if (!label || !filePath) throw new Error(`比較対象は名前=JSONファイルで指定してください: ${item}`);
    if (names.has(label)) throw new Error(`比較名が重複しています: ${label}`);
    names.add(label);
    return readComparison(label, filePath);
  });
}

function markdownSummary(totals) {
  const columns = ['領域', ...VALUE_NAMES];
  const header = `| ${columns.join(' | ')} |`;
  const separator = `|${columns.map((_, index) => index === 0 ? '---' : '---:').join('|')}|`;
  const rows = Object.entries(totals).sort(([left], [right]) => left.localeCompare(right)).map(([area, values]) => `| ${area} | ${VALUE_NAMES.map((name) => values[name]).join(' | ')} |`);
  const overall = metricTotals(totals);
  rows.push(`| 全体 | ${VALUE_NAMES.map((name) => overall[name]).join(' | ')} |`);
  return [header, separator, ...rows].join('\n');
}

export function runStatsCommand(argv, io) {
  if (argv[0] === '--compare') {
    io.stdout(formatComparison(parseComparisons(argv)));
    return 0;
  }

  const options = parseArgs(argv);
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const config = loadConfig(repoRoot, options.configPath);
  const ref = options.ref === undefined ? null : resolveCommit(repoRoot, options.ref);
  const snapshot = createGitSnapshot(repoRoot, ref);
  const result = {
    schemaVersion: 1,
    source: { ref, worktree: ref === null },
    ...statsForSnapshot(snapshot, { prefixes: options.prefixes, config }),
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out === undefined) {
    io.stdout(json.trimEnd());
  } else {
    fs.writeFileSync(path.resolve(options.out), json, 'utf8');
    io.stdout(`${markdownSummary(result.totals)}\n警告: ${result.warnings.length} 件`);
  }
  return 0;
}
