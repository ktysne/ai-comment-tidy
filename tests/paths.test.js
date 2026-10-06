import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { batchPaths, batchDefinitionPath, formatPromptPath, relativeFilePath, resolveExternalPath } from '../src/paths.js';

describe('作業の置き場', () => {
  test('回と束からすべての置き場を同じルートに決める', () => {
    const root = path.resolve('example');
    expect(batchPaths(root, 'volume', 'V01')).toEqual({
      root, definition: path.join(root, '.comment-tidy/batches-volume.json'),
      worktree: path.join(root, '.comment-tidy/worktrees/volume/V01'),
      baseline: path.join(root, '.comment-tidy/work/volume/base/V01'),
      hashes: path.join(root, '.comment-tidy/work/volume/base/V01.hashes.json'),
      prompt: path.join(root, '.comment-tidy/work/volume/prompts/V01.md'),
      report: path.join(root, '.comment-tidy/work/volume/reports/V01.md'),
      check: path.join(root, '.comment-tidy/work/volume/check-V01.json'),
      state: path.join(root, '.comment-tidy/work/volume/state/V01.json'),
    });
    expect(batchDefinitionPath(root, 'history')).not.toBe(batchDefinitionPath(root, 'volume'));
  });

  test.each(['..', '../volume', 'a/b', 'C:volume', '', 'nul', 'COM1'])('置き場に使えない名前を拒否する: %s', (name) => {
    expect(() => batchPaths('.', name, 'V01')).toThrow();
    expect(() => batchPaths('.', 'volume', name)).toThrow();
  });

  test.each(['../file.cpp', '/file.cpp', 'C:file.cpp', 'a//b.cpp', 'a/./b.cpp', 'a\nb.cpp'])('担当外へ出るか表示できないパスを拒否する: %s', (file) => {
    expect(() => relativeFilePath(file)).toThrow();
  });

  test('資料のホーム展開と依頼文のパスを統一する', () => {
    expect(resolveExternalPath('~/.claude/CLAUDE.md', '.')).toBe(path.join(os.homedir(), '.claude/CLAUDE.md'));
    expect(resolveExternalPath('rules.md', path.resolve('example'))).toBe(path.resolve('example/rules.md'));
    expect(formatPromptPath('D:\\example\\my file.md')).toBe('D:/example/my file.md');
  });
});
