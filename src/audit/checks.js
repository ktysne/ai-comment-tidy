import { docReferenceExists, findDocReferences, resolveDocPaths } from '../docs-refs.js';

export const DEFAULT_KEYWORD_GROUPS = Object.freeze({
  'スレッドと寿命と順序': ['スレッド', 'ワーカー', 'atomic', 'ロック', '排他', '再入', '寿命', '破棄', '解放', '所有', '中断', '先に', 'してから', '必ず', 'してはならない', 'ブロック', '待たない', '同時'],
  '数値と単位': ['epsilon', '丸め', 'Hz', 'ms', '秒', 'バイト', 'px', '上限', '下限', '空なら', '0 なら', 'null'],
  '互換': ['旧形式', '旧キー', '旧版', 'schemaVersion', '互換'],
  '撤去条件': ['削除可能', '削除できる', 'TODO', 'FIXME', '追跡'],
});

function containsKeyword(text, keyword) {
  if (!/^[A-Za-z0-9_]+$/u.test(keyword)) return text.includes(keyword);
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // 前に数字を許すのは `100ms` の単位を拾うためである。`\b` は数字と英字の間を境界とみなさない。
  return new RegExp(`(?<![A-Za-z_])${escaped}(?![A-Za-z0-9_])`, 'u').test(text);
}

function keywordGroups(config) {
  const groups = new Map(Object.entries(DEFAULT_KEYWORD_GROUPS).map(([name, words]) => [name, [...words]]));
  for (const [name, words] of Object.entries(config.audit?.keywordGroups ?? {})) {
    groups.set(name, [...new Set([...(groups.get(name) ?? []), ...words])]);
  }
  return groups;
}

function keywordLoss({ hunk, remaining, docsText, groups }) {
  const removed = hunk.removed.map((row) => row.body).join('\n');
  const preserved = `${remaining}\n${docsText}`;
  const losses = [];
  for (const [name, words] of groups) {
    const lost = words.filter((word) => containsKeyword(removed, word) && !containsKeyword(preserved, word));
    if (lost.length) losses.push(`${name}: ${lost.join('、')}`);
  }
  return losses.length ? [{ detail: losses.join(' / ') }] : [];
}

function fullDelete({ hunk }) {
  return hunk.removed.length >= 4 && hunk.added.length === 0
    ? [{ detail: `${hunk.removed.length} 行のコメントを削除し、コメントの追加がありません` }] : [];
}

function hedge({ hunk }) {
  const words = ['など', '適宜', '必要に応じて', '適切に'];
  return hunk.added.flatMap((row) => {
    const matched = words.filter((word) => row.body.includes(word));
    return matched.length ? [{ line: row.line, detail: `逃げ言葉: ${matched.join('、')}` }] : [];
  });
}

function missingRef({ hunk, config, docs }) {
  return hunk.added.flatMap((row) => findDocReferences(row.body, config.docs.refPattern)
    .filter((reference) => !docReferenceExists({ ...reference, ...docs }))
    .map((reference) => ({ line: row.line, detail: `実在しない参照: ${reference.doc}「${reference.heading}」` })));
}

export const AUDIT_CHECKS = Object.freeze([
  { name: 'keyword-loss', label: '重要語の消失', inspect: keywordLoss },
  { name: 'full-delete', label: '4 行以上の丸ごと削除', inspect: fullDelete },
  { name: 'hedge', label: '逃げ言葉', inspect: hedge },
  { name: 'missing-ref', label: '実在しない参照', inspect: missingRef },
]);

export function inspectHunks({ hunks, currentLines, config, target }) {
  if (!hunks.length) return [];
  const remaining = [...currentLines.values()].map((row) => row.body).join('\n');
  const docs = { docsRoot: config.docs.root, files: target.listFiles(),
    read: (file) => new TextDecoder('utf-8', { fatal: true }).decode(target.read(file)) };
  const referenced = new Set();
  const references = [...currentLines.values()].flatMap((row) => findDocReferences(row.body, config.docs.refPattern));
  for (const reference of references) {
    const candidates = resolveDocPaths(reference.doc, config.docs.root, docs.files);
    for (const file of candidates) {
      if (docReferenceExists({ ...reference, ...docs, files: [file] })) referenced.add(file);
    }
  }
  const docsText = [...referenced].map(docs.read).join('\n');
  const groups = keywordGroups(config);
  return hunks.flatMap((hunk) => AUDIT_CHECKS.flatMap((check) => check.inspect({ hunk, remaining, docsText, groups, config, docs })
    .map((finding) => ({ check: check.name, file: hunk.file, line: finding.line ?? hunk.line,
      removed: hunk.removed.map((row) => row.text), added: hunk.added.map((row) => row.text), detail: finding.detail }))));
}
