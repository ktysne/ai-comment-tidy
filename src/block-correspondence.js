import { normalizedCodeTokens } from './lex/normalized-code.js';

// 整列の表の大きさ(要素数)がこれを超えるときは、同じアンカーのブロックを出現順に対応させる。
const MAX_ALIGN_CELLS = 16_000_000;

/** ブロックの本文から空白を除いたもの。本文が同じかどうかの比較に使う。 */
export function compactBlockText(block) {
  return block.text.replace(/\s/g, '');
}

function codeByLine(filePath, rawSource, config) {
  const lines = new Map();
  for (const { value, line } of normalizedCodeTokens(filePath, rawSource, config)) {
    const code = lines.get(line);
    lines.set(line, code === undefined ? value : `${code}${value}`);
  }
  return lines;
}

/**
 * 各ブロックの位置を示すアンカーを返す(`blocks` と同じ並び)。
 * 行末のコメントはその行のコード(`own:`)、それ以外は直後のコードの行(`next:`)で、
 * 直後が無ければ直前のコードの行(`prev:`)、直前も無ければ先頭からのブロックの順位(`head:`)になる。
 */
export function blockAnchors(filePath, rawSource, config, blocks) {
  const code = codeByLine(filePath, rawSource, config);
  const commentLines = new Set(blocks.flatMap((block) => block.lines.map(({ line }) => line)));
  const lineCount = rawSource.split('\n').length;

  return blocks.map((block, blockIndex) => {
    if (block.trailing) return `own:${code.get(block.startLine) ?? ''}`;
    // 空行は読み飛ばし、次のコメントの行に当たったら直後にコードは無いとみなす。
    for (let line = block.endLine; line <= lineCount; line++) {
      const next = code.get(line);
      if (next !== undefined) return `next:${next}`;
      if (line > block.endLine && commentLines.has(line)) break;
    }
    for (let line = block.startLine - 1; line >= 1; line--) {
      const previous = code.get(line);
      if (previous !== undefined) return `prev:${previous}`;
    }
    // コードより前にあるブロックは、ファイルの冒頭の説明など。順位が同じものを同じブロックとみなす。
    return `head:${blockIndex}`;
  });
}

// アンカーが同じ候補の中から、本文の頭と末尾がより長く一致するほうを選ぶための値(0 から 1)。
function similarity(left, right) {
  const limit = Math.min(left.length, right.length);
  let prefix = 0;
  while (prefix < limit && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (suffix < limit - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 1 : (prefix + suffix) / longest;
}

function alignByOrder(baseIndexes, currentIndexes, baseBlocks, currentBlocks) {
  const queues = new Map();
  for (const index of baseIndexes) {
    const anchor = baseBlocks[index].anchor;
    if (!queues.has(anchor)) queues.set(anchor, []);
    queues.get(anchor).push(index);
  }
  const pairs = [];
  for (const index of currentIndexes) {
    const queue = queues.get(currentBlocks[index].anchor);
    if (queue?.length) pairs.push([queue.shift(), index]);
  }
  return pairs;
}

/**
 * アンカー列の最長共通部分列で、2 つのブロック列を順序を保って対応付ける。
 * 長さが同じ対応のうちでは、本文の頭と末尾がより長く一致する組を選ぶ。
 */
function alignByAnchor(baseIndexes, currentIndexes, baseBlocks, currentBlocks) {
  const bases = baseIndexes.filter((index) => baseBlocks[index].anchor !== null);
  const currents = currentIndexes.filter((index) => currentBlocks[index].anchor !== null);
  const rows = bases.length;
  const columns = currents.length;
  if (rows === 0 || columns === 0) return [];
  if ((rows + 1) * (columns + 1) > MAX_ALIGN_CELLS) return alignByOrder(bases, currents, baseBlocks, currentBlocks);

  const width = columns + 1;
  // 同順位の組の加点の合計が 1 を超えないようにして、対応の数が必ず優先されるようにする。
  const unit = 1 / (2 * (Math.min(rows, columns) + 1));
  const weight = (row, column) => {
    const base = baseBlocks[bases[row]];
    const current = currentBlocks[currents[column]];
    return base.anchor === current.anchor ? 1 + unit * similarity(base.compact, current.compact) : 0;
  };
  const score = new Float64Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      let best = Math.max(score[(row + 1) * width + column], score[row * width + column + 1]);
      const gain = weight(row, column);
      if (gain > 0) best = Math.max(best, score[(row + 1) * width + column + 1] + gain);
      score[row * width + column] = best;
    }
  }

  const pairs = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    const gain = weight(row, column);
    if (gain > 0 && score[row * width + column] === score[(row + 1) * width + column + 1] + gain) {
      pairs.push([bases[row], currents[column]]);
      row++;
      column++;
    } else if (score[(row + 1) * width + column] >= score[row * width + column + 1]) {
      row++;
    } else {
      column++;
    }
  }
  return pairs;
}

function groupByText(baseBlocks, currentBlocks) {
  const groups = new Map();
  const groupOf = (text) => {
    if (!groups.has(text)) groups.set(text, { bases: [], currents: [] });
    return groups.get(text);
  };
  baseBlocks.forEach((block, index) => groupOf(block.compact).bases.push(index));
  currentBlocks.forEach((block, index) => groupOf(block.compact).currents.push(index));
  return [...groups.values()];
}

/**
 * 比べる元のブロックと作業中のブロック(`{ compact, anchor }`)を、本文が同じもの、
 * 残りのアンカー列の最長共通部分列の順に対応付ける。
 * 戻り値は作業中のブロックごとの、対応する元のブロックの番号(無ければ -1)。
 */
export function correspondBlocks(baseBlocks, currentBlocks) {
  const pairing = new Array(currentBlocks.length).fill(-1);
  const baseTaken = new Array(baseBlocks.length).fill(false);
  const link = (baseIndex, currentIndex) => {
    pairing[currentIndex] = baseIndex;
    baseTaken[baseIndex] = true;
  };

  for (const { bases, currents } of groupByText(baseBlocks, currentBlocks)) {
    if (bases.length === 0 || currents.length === 0) continue;
    for (const [baseIndex, currentIndex] of alignByAnchor(bases, currents, baseBlocks, currentBlocks)) {
      link(baseIndex, currentIndex);
    }
    const restBases = bases.filter((index) => !baseTaken[index]);
    const restCurrents = currents.filter((index) => pairing[index] < 0);
    for (let index = 0; index < Math.min(restBases.length, restCurrents.length); index++) {
      link(restBases[index], restCurrents[index]);
    }
  }

  const restBases = baseBlocks.map((_, index) => index).filter((index) => !baseTaken[index]);
  const restCurrents = currentBlocks.map((_, index) => index).filter((index) => pairing[index] < 0);
  for (const [baseIndex, currentIndex] of alignByAnchor(restBases, restCurrents, baseBlocks, currentBlocks)) {
    link(baseIndex, currentIndex);
  }
  return pairing;
}
