export function lexBat(source) {
  const segments = [];
  let position = 0;
  for (const line of source.split('\n')) {
    const end = position + line.length;
    const body = line.endsWith('\r') ? line.slice(0, -1) : line;
    const trimmed = body.trimStart();
    if (/^@?rem(\s|$)/i.test(trimmed) || trimmed.startsWith('::')) {
      const start = position + (body.length - trimmed.length);
      if (start > position) segments.push({ kind: 'code', start: position, end: start });
      segments.push({ kind: 'comment', start, end: position + body.length, style: 'rem' });
      if (end + 1 <= source.length) segments.push({ kind: 'code', start: position + body.length, end: Math.min(end + 1, source.length) });
    } else {
      segments.push({ kind: 'code', start: position, end: Math.min(end + 1, source.length) });
    }
    position = end + 1;
  }
  return segments;
}

export const language = {
  id: 'bat',
  extensions: ['bat', 'cmd'],
  lex: lexBat,
  docCommentMarkers: [],
  separatorPattern: /^(?:rem\b|::)\s*(?:[=*~#_-]{4,}|[=-]{3,}\s.*\s[=-]{3,}\s*)$/i,
};
