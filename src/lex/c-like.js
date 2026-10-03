const isIdentifierCharacter = (character) => character !== undefined && /[A-Za-z0-9_$]/.test(character);
const REGEX_PRECEDING_KEYWORDS = ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'];

export function lexCppLike(source, options) {
  const isJavaScriptLike = options.language === 'js' || options.language === 'ts';
  const segments = [];
  let index = 0;
  let codeStart = 0;
  const sourceLength = source.length;
  let lastSignificant = '';
  let lastWord = '';
  const templateDepth = [];

  const flushCode = (end) => {
    if (end > codeStart) {
      segments.push({ kind: 'code', start: codeStart, end });
      const text = source.slice(codeStart, end).replace(/\s+$/, '');
      if (text.length) {
        lastSignificant = text[text.length - 1];
        const word = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(text);
        lastWord = word ? word[1] : '';
      }
    }
  };

  while (index < sourceLength) {
    const character = source[index];
    if (character === '/' && source[index + 1] === '/') {
      flushCode(index);
      let end = index;
      while (end < sourceLength && source[end] !== '\n') {
        if (!isJavaScriptLike && source[end] === '\\' && (source[end + 1] === '\n' || (source[end + 1] === '\r' && source[end + 2] === '\n'))) {
          end += source[end + 1] === '\r' ? 3 : 2;
          continue;
        }
        end++;
      }
      if (end > index && source[end - 1] === '\r') end--;
      const isDoc = (source[index + 2] === '/' && source[index + 3] !== '/') || source[index + 2] === '!';
      segments.push({ kind: 'comment', start: index, end, style: isDoc ? 'doc' : 'line' });
      index = end;
      codeStart = index;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      flushCode(index);
      const close = source.indexOf('*/', index + 2);
      const end = close < 0 ? sourceLength : close + 2;
      const isDoc = (source[index + 2] === '*' && source[index + 3] !== '/') || source[index + 2] === '!';
      segments.push({ kind: 'comment', start: index, end, style: isDoc ? 'docblock' : 'block' });
      index = end;
      codeStart = index;
      continue;
    }
    if (isJavaScriptLike && character === '/') {
      const pending = source.slice(codeStart, index).replace(/\s+$/, '');
      if (pending.length) {
        lastSignificant = pending[pending.length - 1];
        const word = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(pending);
        lastWord = word ? word[1] : '';
      }
      const beforeBang = /(?:([A-Za-z_$][A-Za-z0-9_$]*)|[)\]])\s*!\s*$/.exec(pending);
      const isTsNonNullAssertion = options.language === 'ts' && beforeBang !== null
        && !REGEX_PRECEDING_KEYWORDS.includes(beforeBang[1]);
      const regexAllowed = !isTsNonNullAssertion && (
        lastSignificant === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant)
        || REGEX_PRECEDING_KEYWORDS.includes(lastWord)
      );
      if (regexAllowed) {
        flushCode(index);
        let end = index + 1;
        let inCharacterClass = false;
        while (end < sourceLength && source[end] !== '\n') {
          if (source[end] === '\\') { end += 2; continue; }
          if (source[end] === '[') inCharacterClass = true;
          else if (source[end] === ']') inCharacterClass = false;
          else if (source[end] === '/' && !inCharacterClass) break;
          end++;
        }
        end++;
        while (end < sourceLength && /[a-z]/i.test(source[end])) end++;
        segments.push({ kind: 'string', start: index, end });
        lastSignificant = '"';
        lastWord = '';
        index = end;
        codeStart = index;
        continue;
      }
    }
    if (isJavaScriptLike && character === '`') {
      flushCode(index);
      let end = index + 1;
      while (end < sourceLength) {
        if (source[end] === '\\') { end += 2; continue; }
        if (source[end] === '`') { end++; break; }
        if (source[end] === '$' && source[end + 1] === '{') { end += 2; break; }
        end++;
      }
      segments.push({ kind: 'string', start: index, end });
      if (source[end - 1] === '{') templateDepth.push(0);
      lastSignificant = '"';
      lastWord = '';
      index = end;
      codeStart = index;
      continue;
    }
    if (isJavaScriptLike && templateDepth.length && (character === '{' || character === '}')) {
      if (character === '{') {
        templateDepth[templateDepth.length - 1]++;
      } else if (templateDepth[templateDepth.length - 1] === 0) {
        flushCode(index);
        templateDepth.pop();
        let end = index + 1;
        while (end < sourceLength) {
          if (source[end] === '\\') { end += 2; continue; }
          if (source[end] === '`') { end++; break; }
          if (source[end] === '$' && source[end + 1] === '{') { end += 2; break; }
          end++;
        }
        segments.push({ kind: 'string', start: index, end });
        if (source[end - 1] === '{') templateDepth.push(0);
        lastSignificant = '"';
        lastWord = '';
        index = end;
        codeStart = index;
        continue;
      } else {
        templateDepth[templateDepth.length - 1]--;
      }
      index++;
      continue;
    }
    if (character === '"' || character === "'") {
      if (!isJavaScriptLike && character === "'") {
        let previous = index - 1;
        while (previous >= 0 && /[0-9A-Za-z_.']/.test(source[previous])) previous--;
        if (previous + 1 < index && /[0-9]/.test(source[previous + 1])) {
          index++;
          continue;
        }
      }
      if (!isJavaScriptLike && character === '"') {
        let previous = index - 1;
        while (previous >= 0 && isIdentifierCharacter(source[previous])) previous--;
        const word = source.slice(previous + 1, index);
        if (['R', 'u8R', 'uR', 'UR', 'LR'].includes(word)) {
          const openParen = source.indexOf('(', index + 1);
          const delimiter = source.slice(index + 1, openParen);
          const close = source.indexOf(`)${delimiter}"`, openParen + 1);
          const end = close < 0 ? sourceLength : close + delimiter.length + 2;
          flushCode(index);
          segments.push({ kind: 'string', start: index, end });
          lastSignificant = '"';
          lastWord = '';
          index = end;
          codeStart = index;
          continue;
        }
      }
      flushCode(index);
      let end = index + 1;
      while (end < sourceLength) {
        if (source[end] === '\\') { end += 2; continue; }
        if (source[end] === character) { end++; break; }
        if (source[end] === '\n') break;
        end++;
      }
      segments.push({ kind: 'string', start: index, end });
      lastSignificant = '"';
      lastWord = '';
      index = end;
      codeStart = index;
      continue;
    }
    index++;
  }
  flushCode(sourceLength);
  return segments;
}
