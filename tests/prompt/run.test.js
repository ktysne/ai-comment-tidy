import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { generatePrompt } from '../../src/prompt/run.js';
import { findForbiddenTerms } from '../../src/init/criteria.js';

const template = fs.readFileSync(new URL('../../templates/criteria.md', import.meta.url), 'utf8');
function options() {
  const files = new Map([['src/a.cpp', Buffer.from('// a\n// b\n// c\n// d\n')]]);
  return {
    batch: { files: ['src/a.cpp'] },
    paths: { worktree: '/repo/work/V01', baseline: '/repo/base/V01', hashes: '/repo/base/V01.hashes.json' },
    criteria: template, criteriaPath: '/repo/criteria.md', rulesPaths: ['/repo/rules.md'], docsPaths: ['/repo/docs/design.md'],
    snapshot: { has: (file) => files.has(file), readMany: (paths) => new Map(paths.map((file) => [file, files.get(file)])) },
    configPath: '/repo/config.json', toolPath: '/tool/bin/comment-tidy.js', nodePath: '/node', platform: 'linux',
  };
}

describe('依頼文の生成', () => {
  test('決まった見出しと既定の保護事項、長いコメントの行範囲を含める', () => {
    const prompt = generatePrompt(options());
    expect([...prompt.matchAll(/^## (.+)$/gm)].map((match) => match[1])).toEqual([
      '位置づけ', '目的', '落とさないもの', '作業ディレクトリ', '必ず読むもの', '担当ファイルの状態', '禁止事項', '検証', '報告',
    ]);
    expect(prompt).toContain('1-4');
    expect(prompt).toContain('ライセンス表示と移植の約束');
    expect(prompt).toContain('契約の語の主語、順序、条件');
    expect(prompt).toContain('check');
    expect(prompt).toContain('--offline');
    expect(prompt).toContain('--config');
    expect(prompt).toContain('codeImprovements');
    expect(findForbiddenTerms(prompt)).toEqual([]);
  });

  test.each(['GitHub', 'コミット', 'push', '実行者を選択する'])('埋め込む節に禁止語があれば場所を示して止まる: %s', (term) => {
    expect(() => generatePrompt({ ...options(), criteria: template.replace('## 目的', `## 目的\n${term}`) }))
      .toThrow(/目的 1行目/);
  });

  test('埋め込まない節とパスにだけある禁止語では止まらない', () => {
    expect(generatePrompt({ ...options(), criteria: `${template}\n## 補足\ngit\n`, rulesPaths: ['/repo/git-rules.md'] }))
      .toContain('/repo/git-rules.md');
  });

  test('Windowsのパスと引用符をPowerShellの実行可能な形で表示する', () => {
    const opts = options();
    opts.paths.worktree = "D:\\my folder\\o'ne";
    opts.platform = 'win32';
    const prompt = generatePrompt(opts);
    expect(prompt).toContain("D:/my folder/o'ne");
    expect(prompt).toContain("& '/node'");
    expect(prompt).toContain("'D:/my folder/o''ne'");
    expect(prompt).toContain('```powershell');
  });

  test('POSIXの引用符を含むパスを一つの引数として表示する', () => {
    const opts = options();
    opts.paths.worktree = "/repo/o'ne";
    expect(generatePrompt(opts)).toContain("'/repo/o'\"'\"'ne'");
  });

  test('再開で削除された担当ファイルを欠落と示す', () => {
    const opts = options();
    opts.changed = new Set(['src/a.cpp']);
    opts.snapshot = { has: () => false, readMany: () => new Map() };
    expect(generatePrompt(opts)).toContain('src/a.cpp: 欠落');
    expect(() => generatePrompt({ ...opts, changed: null })).toThrow('基準コミット');
  });
});
