import { lex } from './index.js';

const CODE_TOKEN = /[A-Za-z0-9_$]+|->\*|<<=|>>=|<=>|\.\.\.|::|->|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\.\*|##|=>|\?\?|\?\.|\S/g;

export function normalizedCode(filePath, rawSource) {
  // 比較するコードは CRLF と LF の差を無視するため、改行を LF に統一して解析する。
  const source = rawSource.replace(/\r\n/g, '\n');
  const tokens = [];
  // コメントを空白に置き換えてコード区間をつなぎ、演算子の最長一致で差を保つ。
  let run = '';
  const flush = () => {
    tokens.push(...(run.match(CODE_TOKEN) ?? []));
    run = '';
  };

  for (const segment of lex(filePath, source)) {
    const text = source.slice(segment.start, segment.end);
    if (segment.kind === 'string') { flush(); tokens.push(text); }
    else if (segment.kind === 'code') run += text;
    else run += ' ';
  }
  flush();
  return tokens.join(' ');
}
