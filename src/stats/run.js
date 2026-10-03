import { DEFAULT_SCOPE_EXCLUDES } from '../lint/config.js';
import { languageOf } from '../lex/index.js';
import { fileStats, InvalidUtf8Error, VALUE_NAMES } from './file-stats.js';

function emptyValues() {
  return Object.fromEntries(VALUE_NAMES.map((name) => [name, 0]));
}

function isExcluded(filePath) {
  return filePath.split('/').some((part) => DEFAULT_SCOPE_EXCLUDES.includes(part));
}

function isSelected(filePath, prefixes) {
  return prefixes.length === 0 || prefixes.some((prefix) => filePath.startsWith(prefix));
}

function areaOf(filePath) {
  const separator = filePath.indexOf('/');
  return separator < 0 ? '.' : filePath.slice(0, separator);
}

export function statsForSnapshot(snapshot, { prefixes = [] } = {}) {
  const files = Object.create(null);
  const totals = Object.create(null);
  const warnings = [];
  const paths = snapshot.listFiles().map((filePath) => filePath.replace(/\\/g, '/')).sort()
    .filter((filePath) => snapshot.has(filePath) && languageOf(filePath) && !isExcluded(filePath) && isSelected(filePath, prefixes));
  const contents = snapshot.readMany(paths);

  for (const filePath of paths) {
    try {
      const values = fileStats(filePath, contents.get(filePath));
      files[filePath] = values;
      const area = areaOf(filePath);
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
