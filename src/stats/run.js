import { isTargetFile } from '../config.js';
import { matchesGlob } from '../glob.js';
import { fileStats, InvalidUtf8Error, VALUE_NAMES } from './file-stats.js';

function emptyValues() {
  return Object.fromEntries(VALUE_NAMES.map((name) => [name, 0]));
}

function isSelected(filePath, prefixes) {
  return prefixes.length === 0 || prefixes.some((prefix) => filePath.startsWith(prefix));
}

function areaOf(filePath, config) {
  if (config?.areas !== undefined) {
    for (const [name, patterns] of Object.entries(config.areas)) {
      if (patterns.some((pattern) => matchesGlob(filePath, pattern))) return name;
    }
    return '(なし)';
  }
  const separator = filePath.indexOf('/');
  return separator < 0 ? '.' : filePath.slice(0, separator);
}

export function statsForSnapshot(snapshot, { prefixes = [], config } = {}) {
  const files = Object.create(null);
  const totals = Object.create(null);
  const warnings = [];
  const paths = snapshot.listFiles().map((filePath) => filePath.replace(/\\/g, '/')).sort()
    .filter((filePath) => snapshot.has(filePath) && isTargetFile(filePath, config) && isSelected(filePath, prefixes));
  const contents = snapshot.readMany(paths);

  for (const filePath of paths) {
    try {
      const values = fileStats(filePath, contents.get(filePath), config);
      files[filePath] = values;
      const area = areaOf(filePath, config);
      const areaTotals = totals[area] ??= emptyValues();
      for (const name of VALUE_NAMES) areaTotals[name] += values[name];
    } catch (error) {
      if (error instanceof InvalidUtf8Error) {
        warnings.push({ path: filePath, message: error.message });
      } else {
        throw error;
      }
    }
  }

  return { files, totals, warnings };
}

export { areaOf, emptyValues };
