const REQUIRED_SECTIONS = Object.freeze([
  ['purpose', '目的'],
  ['preserve', '落とさないもの'],
  ['excluded', '対象外'],
]);

const FORBIDDEN_TERMS = Object.freeze([
  { label: 'git', pattern: /git/giu },
  { label: 'commit', pattern: /commit|コミット/giu },
  { label: 'push', pattern: /push|プッシュ/giu },
  { label: '実行者の選択', pattern: /(?:\b(?:codex|claude(?:\s+code)?|impl-[a-z0-9-]+)\b|モデル役割分担|(?:実行者|エージェント).{0,8}(?:選ぶ|選択|指定|決める))/giu },
]);

/** 判定基準から依頼文へ埋め込む三つの節を取り出す。 */
export function parseCriteriaSections(markdown) {
  if (typeof markdown !== 'string') throw new Error('判定基準は文字列で指定してください');

  const lines = markdown.split(/\r?\n/u);
  const headings = lines.flatMap((line, index) => {
    const match = /^## ([^\r\n]+?)\s*$/u.exec(line);
    return match ? [{ title: match[1], index }] : [];
  });
  const sections = {};

  for (const [key, title] of REQUIRED_SECTIONS) {
    const matches = headings.filter((heading) => heading.title === title);
    if (matches.length !== 1) {
      throw new Error(`判定基準には「## ${title}」の見出しを 1 つだけ指定してください`);
    }
    const start = matches[0].index + 1;
    const nextHeading = headings.find((heading) => heading.index > matches[0].index);
    sections[key] = lines.slice(start, nextHeading?.index ?? lines.length).join('\n').trim();
  }

  return sections;
}

/** 埋め込み対象の文に依頼文で禁止する語があるかを行ごとに返す。 */
export function findForbiddenTerms(text) {
  if (typeof text !== 'string') throw new Error('検査対象は文字列で指定してください');

  const matches = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    for (const { label, pattern } of FORBIDDEN_TERMS) {
      for (const match of line.matchAll(pattern)) matches.push({ term: label, value: match[0], line: index + 1 });
    }
  }
  return matches;
}
