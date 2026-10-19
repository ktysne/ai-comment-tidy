import { describe, expect, test } from 'vitest';

import { docReferenceExists } from '../src/docs-refs.js';

const DOC = [
  '# 計画',
  '## 3. 設計方針',
  '### 3.1 原則',
  '### 3.12. 例外',
  '## 4 フェーズ分割',
  '## 参照実装とのクロスチェック(段階 5)',
  '',
].join('\n');

function exists(heading) {
  return docReferenceExists({
    doc: 'plan.md',
    heading,
    docsRoot: 'docs',
    files: ['docs/plan.md'],
    read: () => DOC,
  });
}

describe('資料の参照の照合', () => {
  test.each([
    ['§3', true],
    ['§3.1', true],
    ['§3.12', true],
    ['§4', true],
    ['3.1', true],
    ['§3.2', false],
    ['§30', false],
    ['§5', false],
  ])('節番号 %s は番号の区切りまで一致する見出しにだけ当たる (%s)', (heading, expected) => {
    expect(exists(heading)).toBe(expected);
  });

  test('§3 は 3.1 の節に当たらない', () => {
    const read = () => '### 3.1 原則\n';
    expect(docReferenceExists({ doc: 'plan.md', heading: '§3', docsRoot: 'docs', files: ['docs/plan.md'], read }))
      .toBe(false);
  });

  test('節番号の照合でも、両側の括弧書きを除いてから比べる', () => {
    const read = () => '## 3（補足）\n## 30. 付録\n';
    const check = (heading) => docReferenceExists({ doc: 'plan.md', heading, docsRoot: 'docs', files: ['docs/plan.md'], read });
    expect(check('3')).toBe(true);
    expect(check('§3（補足）')).toBe(true);
    expect(docReferenceExists({ doc: 'plan.md', heading: '3（補足）', docsRoot: 'docs', files: ['docs/plan.md'], read: () => '## 30. 付録\n' }))
      .toBe(false);
  });

  test('節番号でない見出しは、括弧書きを除いた前方一致で照合する', () => {
    expect(exists('参照実装とのクロスチェック')).toBe(true);
    expect(exists('設計')).toBe(false);
    expect(exists('3. 設計')).toBe(true);
  });
});
