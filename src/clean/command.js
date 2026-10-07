import path from 'node:path';
import { selectBatchDefinition } from '../batches.js';
import { loadConfig } from '../config.js';
import { batchPaths, ensureManagedPath, validateName } from '../paths.js';
import { repositoryRoot } from '../snapshot/git.js';
import { listWorktreeRegistrations, removeBatchWorktree } from '../snapshot/worktree.js';
import { readState, statusLabel } from '../state.js';
import { inspectCandidate } from './inspect.js';
import { createProgress, readProgress, recordRemoval } from './progress.js';
import { fileStatus, inspectTree, removeEmptyDirectories, removeEmptyRoot, unlinkTreeEntry } from './tree.js';

function parseArgs(argv) {
  const options = { batches: [], force: false, dryRun: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (['--pass', '--repo', '--config', '--force', '--dry-run'].includes(argument)) {
      if (seen.has(argument)) throw new Error(`${argument} は1つだけ指定できます`);
      seen.add(argument);
      if (argument === '--force') options.force = true;
      else if (argument === '--dry-run') options.dryRun = true;
      else {
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${argument} の後に値を指定してください`);
        options[{ '--pass': 'pass', '--repo': 'repoRoot', '--config': 'configPath' }[argument]] = value;
      }
    } else if (argument.startsWith('-')) throw new Error(`認識できない引数です: ${argument}`);
    else options.batches.push(validateName(argument, '束'));
  }
  if (new Set(options.batches).size !== options.batches.length) throw new Error('束を重複して指定できません');
  if (options.pass !== undefined) validateName(options.pass, '回');
  if (options.configPath !== undefined && !path.isAbsolute(options.configPath) && !path.win32.isAbsolute(options.configPath)) {
    throw new Error('--config には絶対パスを指定してください');
  }
  return options;
}

function registrationFor(repoRoot, directory) {
  return listWorktreeRegistrations(repoRoot).find((item) => path.relative(item.directory, directory) === '');
}

function inspectJob(repoRoot, definition, batch, options) {
  const paths = batchPaths(repoRoot, definition.pass, batch.id);
  ensureManagedPath(repoRoot, paths.state);
  const state = readState(repoRoot, definition.pass, batch.id);
  if (!state || state.status === 'delegated') throw new Error(`未着手または委譲中の束は削除できません: ${batch.id}`);
  if (state.status !== 'applied' && !(options.force && options.batches.includes(batch.id))) {
    throw new Error(`未取り込みの束には明示した束と --force が必要です: ${batch.id}`);
  }
  const registration = registrationFor(repoRoot, paths.worktree);
  const progress = readProgress(repoRoot, paths, definition, batch, state);
  const tree = inspectCandidate(repoRoot, definition, batch, paths.worktree, registration, progress);
  const job = { batch, paths, state, tree, registration, progress };
  job.progress ??= createProgress(job, definition);
  return job;
}

function removeJob(repoRoot, job) {
  const directory = job.paths.worktree;
  for (const link of job.tree.links) recordRemoval(repoRoot, job, link, () => unlinkTreeEntry(repoRoot, directory, link, true));
  if (inspectTree(directory).links.length) throw new Error('解除していないリンクが残っています');
  for (const file of job.tree.files.filter((file) => file !== '.git')) recordRemoval(repoRoot, job, file, () => unlinkTreeEntry(repoRoot, directory, file, false));
  removeEmptyDirectories(repoRoot, directory, inspectTree(directory));
  const remaining = inspectTree(directory);
  if (remaining.links.length || remaining.files.some((file) => file !== '.git')) throw new Error(`通常ファイルやリンクが残っています: ${directory}`);
  if (job.registration) {
    try { removeBatchWorktree(repoRoot, directory); }
    catch (error) {
      if (registrationFor(repoRoot, directory)?.locked) throw error;
      const tree = inspectTree(directory);
      if (tree.links.length || tree.files.some((file) => file !== '.git')) throw error;
      if (tree.files.includes('.git')) unlinkTreeEntry(repoRoot, directory, '.git', false);
      removeEmptyDirectories(repoRoot, directory, inspectTree(directory));
      removeEmptyRoot(repoRoot, directory);
      if (!fileStatus(directory)) removeBatchWorktree(repoRoot, directory);
    }
  } else removeEmptyRoot(repoRoot, directory);
  const finalTree = inspectTree(directory);
  if (finalTree.files.length || finalTree.links.length) throw new Error(`削除後にファイルやリンクが残っています: ${directory}`);
  return { remaining: fileStatus(directory) ? [directory, ...finalTree.directories.map((file) => path.join(directory, file))] : [],
    registered: Boolean(registrationFor(repoRoot, directory)) };
}

export function runCleanCommand(argv, io) {
  const options = parseArgs(argv);
  const repoRoot = repositoryRoot(path.resolve(options.repoRoot ?? process.cwd()));
  const config = loadConfig(repoRoot, options.configPath);
  const definition = selectBatchDefinition(repoRoot, options.pass);
  if (!config.passes || !Object.hasOwn(config.passes, definition.pass)) throw new Error(`設定に回がありません: ${definition.pass}`);
  const batches = options.batches.length ? options.batches.map((id) => {
    const batch = definition.batches.find((item) => item.id === id);
    if (!batch) throw new Error(`束がありません: ${definition.pass}/${id}`);
    return batch;
  }) : definition.batches.filter((batch) => {
    ensureManagedPath(repoRoot, batchPaths(repoRoot, definition.pass, batch.id).state);
    return readState(repoRoot, definition.pass, batch.id)?.status === 'applied';
  });
  const jobs = [];
  const rejected = [];
  for (const batch of batches) {
    try {
      const job = inspectJob(repoRoot, definition, batch, options);
      jobs.push(job);
      if (options.dryRun) {
        io.stdout(`${batch.id}: ${statusLabel(job.state)}\n対象: ${job.paths.worktree}`);
        for (const link of job.tree.links) io.stdout(`解除するリンク: ${path.join(job.paths.worktree, link)}`);
      }
    } catch (error) {
      rejected.push(batch.id);
      io.stderr(`${batch.id}: 拒否: ${error.message}\n対象: ${batchPaths(repoRoot, definition.pass, batch.id).worktree}`);
    }
  }
  if (rejected.length) return 2;
  if (options.dryRun) { io.stdout(`clean: 確認のみ (${jobs.length} 束)`); return 0; }
  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index];
    try {
      const fresh = inspectJob(repoRoot, definition, job.batch, options);
      const result = removeJob(repoRoot, fresh);
      io.stdout(`${job.batch.id}: ${result.remaining.length ? '空のディレクトリが残っています' : '削除済み'}\n対象: ${job.paths.worktree}\nGit の登録: ${result.registered ? 'あり' : 'なし'}`);
      for (const directory of result.remaining) io.stdout(`残留: ${directory}`);
    } catch (error) {
      io.stderr(`${job.batch.id}: 失敗: ${error.message}\n残ったパスを確認: ${job.paths.worktree}`);
      io.stderr(`削除済み: ${jobs.slice(0, index).map((item) => item.batch.id).join(', ') || 'なし'}\n未処理: ${jobs.slice(index + 1).map((item) => item.batch.id).join(', ') || 'なし'}`);
      return 2;
    }
  }
  if (!jobs.length) io.stdout('clean: 対象なし');
  return 0;
}
