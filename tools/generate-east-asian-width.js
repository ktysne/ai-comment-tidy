const fs = require('node:fs');
const path = require('node:path');

const [sourcePath, outputPath = 'src/east-asian-width.js'] = process.argv.slice(2);
if (!sourcePath) throw new Error('使い方: node tools/generate-east-asian-width.js <EastAsianWidth.txt> [出力先]');

const ranges = [];
for (const line of fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/)) {
  const match = /^\s*([0-9A-F]+)(?:\.\.([0-9A-F]+))?\s*;\s*([A-Z])(?:\s*#.*)?$/.exec(line);
  if (!match || (match[3] !== 'F' && match[3] !== 'W')) continue;
  ranges.push([Number.parseInt(match[1], 16), Number.parseInt(match[2] ?? match[1], 16)]);
}

ranges.sort(([left], [right]) => left - right);
const merged = [];
for (const [start, end] of ranges) {
  const previous = merged.at(-1);
  if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
  else merged.push([start, end]);
}

const rows = merged.map(([start, end]) => `  [0x${start.toString(16)}, 0x${end.toString(16)}],`);
const output = `export const EAST_ASIAN_WIDE_RANGES = Object.freeze([\n${rows.join('\n')}\n]);\n`;
fs.writeFileSync(path.resolve(outputPath), output, 'utf8');
