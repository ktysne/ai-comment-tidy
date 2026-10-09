import { execFileSync } from 'node:child_process';
import { commentBlocks } from '../comment-blocks.js';

export function auditCommentLines(file, buffer, config) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch (error) { throw new Error(`${file} を UTF-8 として読めません`, { cause: error }); }
  const lines = new Map();
  for (const block of commentBlocks(file, source, config)) {
    if (config.licensePatterns.some((pattern) => new RegExp(pattern).test(block.text))) continue;
    const bodies = block.text.split('\n');
    for (const [index, row] of block.lines.entries()) {
      if (bodies[index].trim()) lines.set(row.line, { ...row, body: bodies[index] });
    }
  }
  return lines;
}

export function extractHunks({ worktree, base, file, before, after, config }) {
  const removedLines = auditCommentLines(file, before, config);
  const currentLines = auditCommentLines(file, after, config);
  // ファイルごとに差分を取ることで、Git のパス表示の引用形式に依存しない。
  const diff = execFileSync('git', ['-C', worktree, '-c', 'core.quotePath=false', '-c', 'diff.suppressBlankEmpty=false', 'diff',
    '--no-ext-diff', '--no-textconv', '--no-color', '--text', '-U3', '--inter-hunk-context=0',
    '--output-indicator-new=+', '--output-indicator-old=-', '--output-indicator-context= ',
    '--no-renames', base, '--', `:(literal)${file}`],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  const hunks = [];
  let hunk;
  let oldLine;
  let newLine;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const row of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      oldRemaining = Number(header[2] ?? 1);
      newRemaining = Number(header[4] ?? 1);
      hunk = { file, line: Math.max(1, newLine), oldLine: Math.max(1, oldLine), removed: [], added: [], context: [] };
      hunks.push(hunk);
    } else if (hunk && (oldRemaining || newRemaining)) {
      if (row.startsWith('-')) {
        if (removedLines.has(oldLine)) hunk.removed.push(removedLines.get(oldLine));
        oldLine++;
        oldRemaining--;
      } else if (row.startsWith('+')) {
        if (currentLines.has(newLine)) hunk.added.push(currentLines.get(newLine));
        newLine++;
        newRemaining--;
      } else if (row.startsWith(' ')) {
        if (currentLines.has(newLine)) hunk.context.push(currentLines.get(newLine));
        oldLine++;
        newLine++;
        oldRemaining--;
        newRemaining--;
      }
    }
  }
  return { hunks, currentLines };
}
