import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { loadLintConfig } from '../../src/lint/config.js';

const roots = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-config-'));
  roots.push(root);
  return root;
}

function writeConfig(root, source) {
  const directory = path.join(root, '.comment-tidy');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'config.json'), source, 'utf8');
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('lint 設定', () => {
  test('設定が無いときは既定値を返す', () => {
    expect(loadLintConfig(makeRoot())).toEqual({
      maxCommentLines: 3,
      licensePatterns: ['Copyright', 'SPDX-License-Identifier', 'この表示を残すこと'],
      scope: { exclude: ['third_party', 'node_modules', 'vendor', 'build', 'dist'] },
      lint: { enabled: true, allow: [] },
    });
  });

  test('lint.enabled と lint.allow を読み取る', () => {
    const root = makeRoot();
    writeConfig(root, JSON.stringify({ lint: { enabled: false, allow: [{ pattern: '前回の保存', reason: '実行時の状態' }] } }));
    expect(loadLintConfig(root).lint).toEqual({
      enabled: false,
      allow: [{ pattern: '前回の保存', reason: '実行時の状態' }],
    });
  });

  test('壊れた JSON を項目名とともに例外にする', () => {
    const root = makeRoot();
    writeConfig(root, '{');
    expect(() => loadLintConfig(root)).toThrow('設定ファイルを JSON として読めません');
  });

  test('型の誤りがある項目名を例外に含める', () => {
    const root = makeRoot();
    writeConfig(root, JSON.stringify({ lint: { enabled: 'yes' } }));
    expect(() => loadLintConfig(root)).toThrow('lint.enabled');
  });
});
