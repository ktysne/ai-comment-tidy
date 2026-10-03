import { languageOf } from '../lex/index.js';

const VALUE_NAMES = Object.freeze([
  'lines',
  'code',
  'comment',
  'commentOnly',
  'trailing',
  'doc',
  'separator',
  'commentChars',
]);

export class InvalidUtf8Error extends Error {}

function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new InvalidUtf8Error(`${label} を UTF-8 として読めません`);
  }
}

function normalizedSource(source) {
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return withoutBom.replace(/\r\n/g, '\n');
}

function sourceLines(source) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== '\n') continue;
    lines.push({ start, end: index, intervalEnd: index + 1, comment: false, code: false, doc: false, separator: false });
    start = index + 1;
  }
  if (start < source.length) {
    lines.push({ start, end: source.length, intervalEnd: source.length, comment: false, code: false, doc: false, separator: false });
  }
  return lines;
}

function emptyStats(lines) {
  return {
    lines: lines.length,
    code: 0,
    comment: 0,
    commentOnly: 0,
    trailing: 0,
    doc: 0,
    separator: 0,
    commentChars: 0,
  };
}

export { VALUE_NAMES };

export function fileStats(filePath, buffer) {
  const source = normalizedSource(decodeUtf8(buffer, filePath));
  const language = languageOf(filePath);
  if (!language) throw new Error(`対応する言語ではありません: ${filePath}`);

  const lines = sourceLines(source);
  const stats = emptyStats(lines);
  const segments = language.lex(source);

  for (const segment of segments) {
    if (segment.kind === 'comment') {
      stats.commentChars += [...source.slice(segment.start, segment.end).replace(/\s/g, '')].length;
    }

    let low = 0;
    let high = lines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (lines[middle].intervalEnd <= segment.start) low = middle + 1;
      else high = middle;
    }
    for (let lineIndex = low; lineIndex < lines.length && lines[lineIndex].start < segment.end; lineIndex++) {
      const line = lines[lineIndex];
      if (segment.kind === 'comment') {
        line.doc ||= segment.style === 'doc' || segment.style === 'docblock';
        const text = source.slice(Math.max(segment.start, line.start), Math.min(segment.end, line.end));
        if (text.trim()) {
          line.comment = true;
          if (language.separatorPattern?.test(text.trim())) line.separator = true;
        }
      } else {
        const text = source.slice(Math.max(segment.start, line.start), Math.min(segment.end, line.end));
        if (text.trim()) line.code = true;
      }
    }
  }

  for (const line of lines) {
    if (line.code) stats.code++;
    if (line.comment) {
      stats.comment++;
      if (line.code) stats.trailing++;
      else stats.commentOnly++;
    }
    if (line.doc) stats.doc++;
    if (line.separator) stats.separator++;
  }

  return stats;
}
