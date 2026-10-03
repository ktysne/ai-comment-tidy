import { lex } from './index.js';

const CODE_TOKEN = /[A-Za-z0-9_$]+|->\*|<<=|>>=|<=>|\.\.\.|::|->|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\.\*|##|=>|\?\?|\?\.|\S/g;

function lineStartsOf(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineOf(position, lineStarts) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

export function normalizedCodeTokens(filePath, rawSource) {
  // 比較するコードは CRLF と LF の差を無視するため、改行を LF に統一して解析する。
  const source = rawSource.replace(/\r\n/g, '\n');
  const lineStarts = lineStartsOf(source);
  const tokens = [];
  // コメントを空白に置き換えてコード区間をつなぎ、演算子の最長一致で差を保つ。
  let run = '';
  let offsets = [];
  const flush = () => {
    const matcher = new RegExp(CODE_TOKEN.source, 'g');
    for (const match of run.matchAll(matcher)) {
      tokens.push({ value: match[0], line: lineOf(offsets[match.index], lineStarts) });
    }
    run = '';
    offsets = [];
  };

  for (const segment of lex(filePath, source)) {
    const text = source.slice(segment.start, segment.end);
    if (segment.kind === 'string') {
      flush();
      tokens.push({ value: text, line: lineOf(segment.start, lineStarts) });
    } else if (segment.kind === 'code') {
      run += text;
      for (let index = segment.start; index < segment.end; index++) offsets.push(index);
    } else {
      run += ' ';
      offsets.push(segment.start);
    }
  }
  flush();
  return tokens;
}

export function normalizedCode(filePath, rawSource) {
  return normalizedCodeTokens(filePath, rawSource).map(({ value }) => value).join(' ');
}
