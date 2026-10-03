function csharpStringStart(source, index) {
  let prefixEnd = index;
  let dollarCount = 0;
  while (source[prefixEnd] === '$') {
    dollarCount++;
    prefixEnd++;
  }
  let interpolated = dollarCount > 0;
  let verbatim = false;

  if (dollarCount > 0) {
    if (source[prefixEnd] === '@') {
      if (dollarCount > 1) return null;
      verbatim = true;
      prefixEnd++;
    }
  } else if (source[index] === '@') {
    verbatim = true;
    prefixEnd++;
    if (source[prefixEnd] === '$') {
      interpolated = true;
      dollarCount = 1;
      prefixEnd++;
    }
  }

  const quote = source[prefixEnd];
  if (quote !== '"' && quote !== "'") return null;
  if (quote === "'" && prefixEnd !== index) return null;

  let quoteCount = 1;
  if (quote === '"') {
    while (source[prefixEnd + quoteCount] === '"') quoteCount++;
  }
  const raw = quote === '"' && quoteCount >= 3;
  if (dollarCount > 1 && !raw) return null;

  return {
    start: index,
    contentStart: prefixEnd + (raw ? quoteCount : 1),
    quote,
    quoteCount: raw ? quoteCount : 1,
    raw,
    interpolated,
    verbatim,
    interpolationBraceCount: raw ? dollarCount : 1,
  };
}

function freeformDirectiveEnd(source, index) {
  if (source[index] !== '#') return null;

  let lineStart = index;
  while (lineStart > 0 && source[lineStart - 1] !== '\n' && source[lineStart - 1] !== '\r') lineStart--;
  let prefix = source.slice(lineStart, index);
  if (lineStart === 0 && prefix.startsWith('\uFEFF')) prefix = prefix.slice(1);
  if (!/^[\t\v\f ]*$/.test(prefix)) return null;

  const directive = /^#[\t ]*(?:region|endregion|error|warning)(?=$|[\t \r\n])/u.exec(source.slice(index));
  if (!directive) return null;

  let end = index + directive[0].length;
  while (end < source.length && source[end] !== '\r' && source[end] !== '\n') end++;
  return end;
}

function lexCSharp(source) {
  const segments = [];
  const sourceLength = source.length;

  const addSegment = (kind, start, end, style) => {
    if (end > start) segments.push({ kind, start, end, ...(style ? { style } : {}) });
  };

  const consumeString = (stringStart) => {
    const {
      contentStart,
      quote,
      quoteCount,
      raw,
      interpolated,
      verbatim,
      interpolationBraceCount,
    } = stringStart;
    if (!interpolated) {
      let end = contentStart;
      while (end < sourceLength) {
        if (raw) {
          let run = 0;
          while (source[end + run] === '"') run++;
          if (run === quoteCount) return end + quoteCount;
          end += Math.max(run, 1);
          continue;
        }
        if (verbatim && quote === '"' && source[end] === '"' && source[end + 1] === '"') {
          end += 2;
          continue;
        }
        if (!verbatim && source[end] === '\\') {
          if (source[end + 1] === '\r' || source[end + 1] === '\n') return end + 1;
          end += 2;
          continue;
        }
        if (source[end] === quote) return end + 1;
        if (!raw && !verbatim && (source[end] === '\r' || source[end] === '\n')) return end;
        end++;
      }
      return sourceLength;
    }

    let chunkStart = stringStart.start;
    let index = contentStart;
    while (index < sourceLength) {
      if (raw) {
        let quoteRun = 0;
        while (source[index + quoteRun] === '"') quoteRun++;
        if (quoteRun === quoteCount) {
          addSegment('string', chunkStart, index + quoteCount);
          return index + quoteCount;
        }
      } else if (source[index] === quote) {
        if (verbatim && source[index + 1] === quote) {
          index += 2;
          continue;
        }
        addSegment('string', chunkStart, index + 1);
        return index + 1;
      }

      if (!raw && !verbatim && (source[index] === '\r' || source[index] === '\n')) {
        addSegment('string', chunkStart, index);
        return index;
      }
      if (!raw && !verbatim && source[index] === '\\') {
        if (source[index + 1] === '\r' || source[index + 1] === '\n') {
          addSegment('string', chunkStart, index + 1);
          return index + 1;
        }
        index += 2;
        continue;
      }
      if (!raw && source[index] === '{' && source[index + 1] === '{') {
        index += 2;
        continue;
      }
      if (!raw && source[index] === '}' && source[index + 1] === '}') {
        index += 2;
        continue;
      }
      if (source[index] === '{') {
        let braceRun = 0;
        while (source[index + braceRun] === '{') braceRun++;
        if (braceRun < interpolationBraceCount) {
          index += braceRun;
          continue;
        }
        // 並んだ波括弧のうち補間を開くのは最後の N 個で、手前の余りは文字列の内容である。
        index += braceRun - interpolationBraceCount;

        addSegment('string', chunkStart, index + interpolationBraceCount);
        const expressionEnd = scanCode(index + interpolationBraceCount, true, interpolationBraceCount);
        if (expressionEnd < sourceLength && source[expressionEnd] === '}') {
          addSegment('string', expressionEnd, expressionEnd + interpolationBraceCount);
          index = expressionEnd + interpolationBraceCount;
          chunkStart = index;
          continue;
        }
        return sourceLength;
      }
      index++;
    }
    addSegment('string', chunkStart, sourceLength);
    return sourceLength;
  };

  const scanCode = (start, interpolationExpression = false, interpolationBraceCount = 1) => {
    let index = start;
    let codeStart = start;
    let braceDepth = 0;

    const flushCode = (end) => addSegment('code', codeStart, end);

    while (index < sourceLength) {
      const character = source[index];
      if (interpolationExpression && character === '}') {
        if (braceDepth === 0) {
          let closeBraceRun = 0;
          while (source[index + closeBraceRun] === '}') closeBraceRun++;
          if (closeBraceRun >= interpolationBraceCount) {
            flushCode(index);
            return index;
          }
          index++;
          continue;
        }
        braceDepth--;
        index++;
        continue;
      }
      if (interpolationExpression && character === '{') {
        braceDepth++;
        index++;
        continue;
      }
      const directiveEnd = freeformDirectiveEnd(source, index);
      if (directiveEnd !== null) {
        index = directiveEnd;
        continue;
      }
      if (character === '/' && source[index + 1] === '/') {
        flushCode(index);
        let end = index;
        while (end < sourceLength && source[end] !== '\n') end++;
        if (end > index && source[end - 1] === '\r') end--;
        const style = source[index + 2] === '/' && source[index + 3] !== '/' ? 'doc' : 'line';
        addSegment('comment', index, end, style);
        index = end;
        codeStart = index;
        continue;
      }
      if (character === '/' && source[index + 1] === '*') {
        flushCode(index);
        const close = source.indexOf('*/', index + 2);
        const end = close < 0 ? sourceLength : close + 2;
        const style = source[index + 2] === '*' && source[index + 3] !== '/' ? 'docblock' : 'block';
        addSegment('comment', index, end, style);
        index = end;
        codeStart = index;
        continue;
      }

      const stringStart = csharpStringStart(source, index);
      if (stringStart) {
        flushCode(index);
        if (stringStart.interpolated) {
          index = consumeString(stringStart);
        } else {
          const end = consumeString(stringStart);
          addSegment('string', index, end);
          index = end;
        }
        codeStart = index;
        continue;
      }
      index++;
    }
    flushCode(sourceLength);
    return sourceLength;
  };

  scanCode(0);
  return segments;
}

export const language = {
  id: 'csharp',
  extensions: ['cs'],
  lex(source) { return lexCSharp(source); },
  docCommentMarkers: ['///', '/**'],
  separatorPattern: /^\/\/+\s*(?:[=*~#_-]{4,}|[=-]{3,}\s.*\s[=-]{3,}\s*)$/i,
};
