import { EAST_ASIAN_WIDE_RANGES } from '../east-asian-width.js';

function isWide(codePoint) {
  let low = 0;
  let high = EAST_ASIAN_WIDE_RANGES.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = EAST_ASIAN_WIDE_RANGES[middle];
    if (codePoint < start) high = middle - 1;
    else if (codePoint > end) low = middle + 1;
    else return true;
  }
  return false;
}

export function eastAsianWidth(text) {
  let width = 0;
  for (const character of text) width += isWide(character.codePointAt(0)) ? 2 : 1;
  return width;
}
