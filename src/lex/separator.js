const BOX_DRAWING = '─-╿';
const LINE_ONLY = `[=*~#_${BOX_DRAWING}-]{4,}`;
const HEADING_RULE = `[=${BOX_DRAWING}-]`;
// 罫線文字の見出しは `── 本体 ───` のように左を 2 文字で書くことが多い。ASCII だけの左側は 3 文字以上のまま保つ。
const HEADING_LEFT = `(?:[=-]{3,}|(?=[=-]*[${BOX_DRAWING}])${HEADING_RULE}{2,})`;

/**
 * 行コメントの開始記号に続けて区切り線か、線で見出しを挟んだ形だけを書いた行に当たる正規表現を作る。
 * 右側の線を必須にするのは、`// ── 注意: 本文` のような 1 行の本文に当てないためである。
 */
export function separatorPattern(commentStart) {
  return new RegExp(`^${commentStart.source}\\s*(?:${LINE_ONLY}|${HEADING_LEFT}\\s.*\\s${HEADING_RULE}{3,}\\s*)$`, 'i');
}
