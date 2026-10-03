import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, run } from '../src/cli.js';

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}

describe('comment-tidy の入口', () => {
  test('引数なしでは使い方を標準出力へ出して 0 で終わる', async () => {
    const { out, err, io } = capture();
    expect(await run([], io)).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('使い方');
    expect(err).toEqual([]);
  });

  test('help は使い方を出して 0 で終わる', async () => {
    const { out, io } = capture();
    expect(await run(['help'], io)).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('使い方');
  });

  test('無いコマンドは標準エラーへ知らせて 2 で終わる', async () => {
    const { out, err, io } = capture();
    expect(await run(['no-such-command'], io)).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain('no-such-command');
    expect(out).toEqual([]);
  });

  test('lint は違反なしなら 0、確定違反があれば 1 で終わる', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-cli-'));
    try {
      execFileSync('git', ['-C', root, 'init', '--quiet']);
      const filePath = path.join(root, 'source.cpp');
      fs.writeFileSync(filePath, '// safe\n', 'utf8');
      const clean = capture();
      expect(await run(['lint', filePath, '--repo', root], clean.io)).toBe(EXIT_OK);
      expect(clean.out).toEqual([]);

      fs.writeFileSync(filePath, '// #123\n', 'utf8');
      const failed = capture();
      expect(await run(['lint', filePath, '--repo', root], failed.io)).toBe(EXIT_FAILED);
      expect(failed.out.join('\n')).toContain('[確定] issue-ref');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('lint は絶対パスの --config を読み、scope.include を対象判定に使わない', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-cli-config-'));
    try {
      execFileSync('git', ['-C', root, 'init', '--quiet']);
      const configPath = path.join(root, 'custom-config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        scope: { include: ['another/**'], exclude: [] },
        languages: { js: ['*.custom'] },
      }), 'utf8');
      const filePath = path.join(root, 'source.custom');
      fs.writeFileSync(filePath, '// #123\n', 'utf8');
      const result = capture();

      expect(await run(['lint', filePath, '--repo', root, '--config', configPath], result.io)).toBe(EXIT_FAILED);
      expect(result.out.join('\n')).toContain('[確定] issue-ref');
      expect(await run(['lint', filePath, '--repo', root, '--config', 'relative.json'], capture().io)).toBe(EXIT_USAGE);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('lint は未対応のフック名を引数の誤りとして 2 で終える', async () => {
    const { err } = capture();
    expect(await run(['lint', '--hook', 'unknown'], {
      stderr: (text) => err.push(text),
      stdout: () => {},
      readStdin: async () => '',
    }))
      .toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain('unknown');
  });

  test('run はコマンドの例外を一行で知らせて 2 で終える', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-cli-error-'));
    try {
      const { err, io } = capture();
      expect(await run(['lint', '--changed', '--repo', root], io)).toBe(EXIT_USAGE);
      expect(err).toHaveLength(1);
      expect(err[0]).toContain('コマンドの実行に失敗しました');
      expect(err[0]).not.toMatch(/[\r\n]/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
