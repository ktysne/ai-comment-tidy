import { describe, expect, test } from 'vitest';

import { EXIT_OK, EXIT_USAGE, run } from '../src/cli.js';

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
});
