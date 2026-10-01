import { languageOf, lex } from './lex/index.js';

function lineStartsOf(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function commentBody(text, languageId, closingMarker) {
  let body = text;
  if (languageId === 'cpp' || languageId === 'js') {
    if (body === '/**/') return '';
    body = body.replace(/^\/\/+!?<?/, '').replace(/^\/\*+!?<?/, '');
    body = body.replace(/^\*(?!\/)/, '').replace(/\*\/$/, '');
  } else if (languageId === 'cmake') {
    const bracket = /^#\[(=*)\[/.exec(body);
    if (bracket) body = body.slice(bracket[0].length);
    else body = body.replace(/^#+/, '');
    if (closingMarker && body.endsWith(closingMarker)) body = body.slice(0, -closingMarker.length);
  } else if (languageId === 'bat') {
    body = body.replace(/^@?rem\b/i, '').replace(/^::/, '');
  }
  return body;
}

function countedLineCount(lines) {
  let count = 0;
  let inParameter = false;
  for (const line of lines) {
    const body = line.body;
    if (/^\s*[@\\](param|return|tparam|retval)\b/.test(body)) {
      inParameter = true;
      continue;
    }
    if (inParameter && /^\s{2,}\S/.test(body) && !/^\s*[@\\]/.test(body)) continue;
    inParameter = false;
    if (!/^\s*$/.test(body)) count++;
  }
  return count;
}

function flushBlock(blocks, pending) {
  if (!pending) return;
  blocks.push({
    startLine: pending.startLine,
    endLine: pending.endLine,
    trailing: pending.trailing,
    lines: pending.lines.map(({ line, text }) => ({ line, text })),
    countedLines: countedLineCount(pending.lines),
    text: pending.lines.map((line) => line.body.trim()).join('\n'),
  });
}

export function commentBlocks(filePath, rawSource) {
  const withoutBom = rawSource.charCodeAt(0) === 0xfeff ? rawSource.slice(1) : rawSource;
  const source = withoutBom.replace(/\r\n/g, '\n');
  const languageId = languageOf(filePath)?.id ?? null;
  const lineStarts = lineStartsOf(source);
  const rows = lineStarts.map((start, index) => ({
    start,
    end: index + 1 < lineStarts.length ? lineStarts[index + 1] - 1 : source.length,
    comments: [],
    hasCode: false,
  }));
  const lineOf = (position) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= position) low = middle;
      else high = middle - 1;
    }
    return low;
  };

  for (const segment of lex(filePath, source)) {
    const firstLine = lineOf(segment.start);
    const lastLine = lineOf(Math.max(segment.start, segment.end - 1));
    const cmakeBracket = languageId === 'cmake' && segment.kind === 'comment'
      ? /^#\[(=*)\[/.exec(source.slice(segment.start, segment.end))
      : null;
    const closingMarker = cmakeBracket ? `]${cmakeBracket[1]}]` : '';
    for (let lineIndex = firstLine; lineIndex <= lastLine; lineIndex++) {
      const row = rows[lineIndex];
      const start = Math.max(segment.start, row.start);
      const end = Math.min(segment.end, row.end);
      if (end <= start) continue;
      const text = source.slice(start, end);
      if (segment.kind === 'comment') {
        if (text.trim()) row.comments.push({
          text: text.trim(),
          body: commentBody(text.trim(), languageId, closingMarker),
        });
      } else if (text.trim()) {
        row.hasCode = true;
      }
    }
  }

  const blocks = [];
  let pending = null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row.comments.length) {
      flushBlock(blocks, pending);
      pending = null;
      continue;
    }
    const lines = [{
      line: index + 1,
      text: row.comments.map((comment) => comment.text).join(' '),
      body: row.comments.map((comment) => comment.body).join(' '),
    }];
    if (row.hasCode) {
      flushBlock(blocks, pending);
      pending = null;
      flushBlock(blocks, { startLine: index + 1, endLine: index + 1, trailing: true, lines });
      continue;
    }
    if (pending && pending.endLine === index) {
      pending.endLine = index + 1;
      pending.lines.push(...lines);
    } else {
      flushBlock(blocks, pending);
      pending = { startLine: index + 1, endLine: index + 1, trailing: false, lines };
    }
  }
  flushBlock(blocks, pending);
  return blocks;
}
