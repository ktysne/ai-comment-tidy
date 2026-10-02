function bracketDelimiter(source, position) {
  const match = /^\[(=*)\[/.exec(source.slice(position, position + 64));
  return match ? match[1] : null;
}

export function lexCmake(source) {
  const segments = [];
  let index = 0;
  let codeStart = 0;
  const sourceLength = source.length;
  const flushCode = (end) => { if (end > codeStart) segments.push({ kind: 'code', start: codeStart, end }); };

  while (index < sourceLength) {
    const character = source[index];
    if (character === '#') {
      flushCode(index);
      const delimiter = bracketDelimiter(source, index + 1);
      let end;
      if (delimiter !== null) {
        const close = source.indexOf(`]${delimiter}]`, index + 1);
        end = close < 0 ? sourceLength : close + delimiter.length + 2;
        segments.push({ kind: 'comment', start: index, end, style: 'block' });
      } else {
        end = source.indexOf('\n', index);
        if (end < 0) end = sourceLength;
        if (end > index && source[end - 1] === '\r') end--;
        segments.push({ kind: 'comment', start: index, end, style: 'hash' });
      }
      index = end;
      codeStart = index;
      continue;
    }
    if (character === '"') {
      flushCode(index);
      let end = index + 1;
      while (end < sourceLength) {
        if (source[end] === '\\') { end += 2; continue; }
        if (source[end] === '"') { end++; break; }
        end++;
      }
      segments.push({ kind: 'string', start: index, end });
      index = end;
      codeStart = index;
      continue;
    }
    if (character === '[') {
      const delimiter = bracketDelimiter(source, index);
      if (delimiter !== null) {
        flushCode(index);
        const close = source.indexOf(`]${delimiter}]`, index + 1);
        const end = close < 0 ? sourceLength : close + delimiter.length + 2;
        segments.push({ kind: 'string', start: index, end });
        index = end;
        codeStart = index;
        continue;
      }
    }
    index++;
  }
  flushCode(sourceLength);
  return segments;
}

export const language = {
  id: 'cmake',
  extensions: ['cmake'],
  lex: lexCmake,
  docCommentMarkers: [],
  separatorPattern: /^#+\s*(?:[=*~#_-]{4,}|[=-]{3,}\s.*\s[=-]{3,}\s*)$/i,
};
