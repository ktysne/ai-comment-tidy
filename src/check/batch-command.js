import path from 'node:path';
import { selectBatch } from '../batches.js';
import { loadConfig } from '../config.js';
import { assertSafeAssignedPath, batchPaths, ensureManagedPath } from '../paths.js';
import { readHashList } from '../snapshot/hash-list.js';
import { readState, statusLabel } from '../state.js';
import { verifyBaseline } from '../run/artifacts.js';
import { recordBatchCheck } from './results.js';
import { runCheck } from './run.js';
import { offlineSnapshots } from './snapshots.js';
import { formatSummary } from './summary.js';

export async function runBatchCheckCommand(options, io) {
  let repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  let git;
  if (!options.offline) {
    git = await import('../snapshot/git.js');
    repoRoot = git.repositoryRoot(repoRoot);
  }
  const config = loadConfig(repoRoot, options.configPath);
  const { definition, batch } = selectBatch(repoRoot, options.batch, options.pass);
  const pass = definition.pass;
  if (!config.passes || !Object.hasOwn(config.passes, pass)) throw new Error(`設定に回がありません: ${pass}`);
  const paths = batchPaths(repoRoot, pass, batch.id);
  ensureManagedPath(repoRoot, paths.worktree);
  let state;
  let baseline;
  let target;
  let hashList = null;
  if (options.offline) {
    ensureManagedPath(repoRoot, paths.hashes);
    hashList = readHashList(paths.hashes);
    verifyBaseline(repoRoot, paths, batch.files, Object.keys(hashList.files));
    ({ baseline, target } = offlineSnapshots({ baseDir: paths.baseline, files: batch.files }, paths.worktree, hashList));
    baseline.base = definition.base;
  } else {
    ensureManagedPath(repoRoot, paths.check);
    ensureManagedPath(repoRoot, paths.state);
    state = readState(repoRoot, pass, batch.id);
    if (!['reported', 'checked'].includes(state?.status)) throw new Error(`検査を記録できるのは報告ありか検査済みの束だけです: ${batch.id} (${statusLabel(state)})`);
    for (const file of batch.files) assertSafeAssignedPath(paths.worktree, file);
    const { validateBatchWorktree } = await import('../snapshot/worktree.js');
    validateBatchWorktree(repoRoot, paths.worktree, definition.base);
    baseline = Object.assign(git.createGitSnapshot(paths.worktree, definition.base), { base: definition.base });
    target = git.createGitSnapshot(paths.worktree);
  }
  const result = { ...runCheck({ files: batch.files, baseline, target, hashList, config, offline: options.offline }), pass, batch: batch.id };
  if (!options.offline) {
    recordBatchCheck(repoRoot, paths, state, result);
  }
  io.stdout(formatSummary(result));
  return result.ok ? 0 : 1;
}
