import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { repositoryRoot, resolveCommit } from './git.js';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

export function validateBatchWorktree(repoRoot, directory, base) {
  if (path.relative(directory, repositoryRoot(directory)) !== '') throw new Error('作業ツリーの置き場が独立したリポジトリではありません');
  const common = (root) => path.resolve(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (path.relative(common(repoRoot), common(directory)) !== '') throw new Error('束の作業ツリーが対象リポジトリに属していません');
  if (git(directory, ['branch', '--show-current']) || resolveCommit(directory, 'HEAD') !== base) {
    throw new Error('束の作業ツリーは基準コミットの detached HEAD が必要です');
  }
}

export function createBatchWorktree(repoRoot, directory, base) {
  git(repoRoot, ['worktree', 'add', '--detach', directory, base]);
}

export function removeBatchWorktree(repoRoot, directory) {
  git(repoRoot, ['worktree', 'remove', '--force', directory]);
}
