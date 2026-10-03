import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { loadConfig } from '../src/config.js';

const roots = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-config-'));
  roots.push(root);
  return root;
}

function writeConfig(root, source) {
  const configPath = path.join(root, '.comment-tidy', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, typeof source === 'string' ? source : JSON.stringify(source), 'utf8');
  return configPath;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('設定', () => {
  test('設定ファイルが無い場合は既定値を返し、scope.include は全体を表す', () => {
    const config = loadConfig(makeRoot());

    expect(config).toMatchObject({
      maxCommentLines: 3,
      maxLineWidth: 108,
      docs: {
        root: 'docs',
        refPattern: 'docs/(?<doc>[\\w.-]+)「(?<heading>[^」]+)」',
      },
      licensePatterns: ['Copyright', 'SPDX-License-Identifier', 'この表示を残すこと'],
      scope: { exclude: ['third_party', 'node_modules', 'vendor', 'build', 'dist'] },
      implementer: { agent: 'impl-standard', parallel: 2 },
      plan: { base: 'origin/main', maxWeight: 700 },
      lint: { enabled: true, allow: [] },
    });
    expect(config.scope).not.toHaveProperty('include');
    expect(config).not.toHaveProperty('languages');
  });

  test('設定例の項目を読み取る', () => {
    const root = makeRoot();
    const source = {
      rulesPaths: ['CLAUDE.md'],
      scope: { include: ['src/**'], exclude: ['vendor/**'] },
      languages: { cpp: ['**/*.{h,cpp}'], ts: ['**/*.ts'] },
      areas: { engine: ['src/engine/**'], tests: ['tests/**'] },
      docs: { root: 'manual', refPattern: 'manual/(?<doc>[^「]+)「(?<heading>[^」]+)」' },
      maxCommentLines: 4,
      maxLineWidth: 90,
      licensePatterns: ['Copyright'],
      implementer: { agent: 'impl-hard', parallel: 3 },
      plan: { base: 'main', maxWeight: 500 },
      audit: { keywordGroups: { '外部 API': ['JUCE'] } },
      privatize: { cpp: { implementationFiles: ['src/**/*.cpp'], testFiles: ['tests/**'] } },
      passes: { volume: { criteria: 'criteria-volume.md', finish: ['privatize'] } },
      lint: { enabled: false, allow: [{ pattern: 'safe', reason: '許可理由' }] },
    };
    writeConfig(root, source);

    expect(loadConfig(root)).toMatchObject(source);
  });

  test.each([
    [{ rulesPaths: [1] }, 'rulesPaths'],
    [{ scope: { include: 'src/**' } }, 'scope.include'],
    [{ languages: { cpp: '**/*.cpp' } }, 'languages.cpp'],
    [{ languages: { rust: ['**/*.rs'] } }, '未知の言語'],
    [{ areas: { src: [''] } }, 'areas.src'],
    [{ implementer: { parallel: 0 } }, 'implementer.parallel'],
    [{ plan: { maxWeight: 0 } }, 'plan.maxWeight'],
    [{ audit: { keywordGroups: { api: 'JUCE' } } }, 'audit.keywordGroups.api'],
    [{ privatize: { cpp: { implementationFiles: 'src/**' } } }, 'privatize.cpp.implementationFiles'],
    [{ passes: { volume: { criteria: '' } } }, 'passes.volume.criteria'],
    [{ passes: { volume: { criteria: 'criteria.md', finish: [2] } } }, 'passes.volume.finish'],
    [{ lint: { allow: [{ pattern: '[', reason: '理由' }] } }, 'lint.allow[0].pattern'],
  ])('不正な項目 %s を拒否する', (source, field) => {
    const root = makeRoot();
    writeConfig(root, source);

    expect(() => loadConfig(root)).toThrow(field);
  });

  test('壊れた JSON と設定ルートの型の誤りを拒否する', () => {
    const root = makeRoot();
    writeConfig(root, '{');
    expect(() => loadConfig(root)).toThrow('設定ファイルを JSON として読めません');

    writeConfig(root, []);
    expect(() => loadConfig(root)).toThrow('設定のルートはオブジェクトで指定してください');

    writeConfig(root, 'null');
    expect(() => loadConfig(root)).toThrow('設定のルートはオブジェクトで指定してください');
  });

  test('既存の docs.root と docs.refPattern の検証文言を保つ', () => {
    const root = makeRoot();
    writeConfig(root, { docs: { root: '../docs' } });
    expect(() => loadConfig(root)).toThrow('docs.root は空でないパス文字列で指定してください');

    writeConfig(root, { docs: { refPattern: 'docs/([^「]+)「([^」]+)」' } });
    expect(() => loadConfig(root)).toThrow('docs.refPattern は doc と heading の名前付き捕捉を持つ必要があります');
  });
});
