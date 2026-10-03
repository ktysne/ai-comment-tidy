function globSource(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === '*' && next === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index++;
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else if (character === '{') {
      const close = pattern.indexOf('}', index + 1);
      if (close >= 0 && pattern.slice(index + 1, close).includes(',')) {
        const alternatives = pattern.slice(index + 1, close).split(',');
        source += '(?:' + alternatives.map(globSource).join('|') + ')';
        index = close;
      } else {
        source += '\\{';
      }
    } else if (character === '}') {
      source += '\\}';
    } else {
      source += '.+^$()|[]{}\\'.includes(character) ? '\\' + character : character;
    }
  }
  return source;
}

export function matchesGlob(relativePath, pattern) {
  const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
  const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '').replace(/\/$/, '');
  const hasSlash = normalizedPattern.includes('/');
  const source = globSource(normalizedPattern);
  // パターンがフォルダーに当たるときは、その下のファイルにも当てる(.gitignore と同じ感覚で書けるように)。
  const expression = hasSlash
    ? new RegExp('^' + source + '(?:/.*)?$')
    : new RegExp('(?:^|/)' + source + '(?:/|$)');
  return expression.test(normalizedPath);
}

