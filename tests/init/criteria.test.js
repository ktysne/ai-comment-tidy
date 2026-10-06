import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

import { findForbiddenTerms, parseCriteriaSections } from '../../src/init/criteria.js';

const template = fs.readFileSync(new URL('../../templates/criteria.md', import.meta.url), 'utf8');

describe('判定基準の共通処理', () => {
  test('雛形から依頼文へ埋め込む三つの節を取り出す', () => {
    const sections = parseCriteriaSections(template);

    expect(sections.purpose).toContain('コメント記述ルール');
    expect(sections.preserve).toContain('不変条件');
    expect(sections.excluded).toContain('コードのトークン');
  });

  test('雛形に依頼文で禁止する語がない', () => {
    expect(findForbiddenTerms(Object.values(parseCriteriaSections(template)).join('\n'))).toEqual([]);
  });

  test('禁止語検査は依頼文へ埋め込む節だけを対象にできる', () => {
    const markdown = [
      'git は雛形の説明にだけ出てくる。',
      '## 目的', 'コメントを整える。',
      '## 落とさないもの', '不変条件を残す。',
      '## 対象外', 'コードは変えない。',
    ].join('\n');

    expect(findForbiddenTerms(Object.values(parseCriteriaSections(markdown)).join('\n'))).toEqual([]);
  });

  test('必要な見出しが欠けるか重複した判定基準を拒否する', () => {
    expect(() => parseCriteriaSections('## 目的\n本文\n## 対象外\n本文')).toThrow('落とさないもの');
    expect(() => parseCriteriaSections('## 目的\n本文\n## 目的\n別の本文\n## 落とさないもの\n本文\n## 対象外\n本文'))
      .toThrow('目的');
  });

  test('細則に禁止語があれば種類と行を返す', () => {
    expect(findForbiddenTerms('安全な説明\nGitHub へ push する')).toEqual([
      { term: 'git', value: 'Git', line: 2 },
      { term: 'push', value: 'push', line: 2 },
    ]);
  });
});
