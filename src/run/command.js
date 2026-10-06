import fs from 'node:fs';
import path from 'node:path';
import { selectBatchDefinition } from '../batches.js';
import { isTargetFile, loadConfig } from '../config.js';
import { ensureManagedPath, validateName } from '../paths.js';
import { promptContext } from '../prompt/context.js';
import { generatePrompt } from '../prompt/run.js';
import { changedAssignedFiles, createGitSnapshot, repositoryRoot } from '../snapshot/git.js';
import { createHashList } from '../snapshot/hash-list.js';
import { createBatchWorktree, removeBatchWorktree, validateBatchWorktree } from '../snapshot/worktree.js';
import { readState, statusLabel, transitionState, writeState } from '../state.js';
import { removeArtifacts, verifyBaseline, writeBaseline, writeManagedFile } from './artifacts.js';

function parseArgs(argv) {
  const options = { batches: [], fresh: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (['--pass', '--repo', '--config', '--fresh'].includes(argument)) {
      if (seen.has(argument)) throw new Error(`${argument} は1つだけ指定できます`);
      seen.add(argument);
      if (argument === '--fresh') options.fresh = true;
      else {
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${argument} の後に値を指定してください`);
        options[{ '--pass': 'pass', '--repo': 'repoRoot', '--config': 'configPath' }[argument]] = value;
      }
    } else if (argument.startsWith('-')) throw new Error(`認識できない引数です: ${argument}`);
    else options.batches.push(validateName(argument, '束'));
  }
  if (!options.batches.length || new Set(options.batches).size !== options.batches.length) throw new Error('重複しない束を1つ以上指定してください');
  if (options.pass !== undefined) validateName(options.pass, '回');
  if (options.configPath !== undefined && !path.isAbsolute(options.configPath) && !path.win32.isAbsolute(options.configPath)) {
    throw new Error('--config には絶対パスを指定してください');
  }
  return options;
}

function exists(target) {
  try { fs.lstatSync(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function runRunCommand(argv, io) {
  const options = parseArgs(argv);
  const repoRoot = repositoryRoot(path.resolve(options.repoRoot ?? process.cwd()));
  const configPath = path.resolve(options.configPath ?? path.join(repoRoot, '.comment-tidy', 'config.json'));
  const config = loadConfig(repoRoot, configPath);
  const definition = selectBatchDefinition(repoRoot, options.pass);
  const baseline = createGitSnapshot(repoRoot, definition.base);
  const jobs = options.batches.map((id) => {
    const batch = definition.batches.find((item) => item.id === id);
    if (!batch) throw new Error(`束がありません: ${definition.pass}/${id}`);
    for (const file of batch.files) if (!isTargetFile(file, config)) throw new Error(`担当ファイルが設定の対象外です: ${file}`);
    const context = promptContext(repoRoot, definition, batch, config, configPath);
    const { paths } = context;
    for (const target of [paths.worktree, paths.baseline, paths.hashes, paths.prompt, paths.report, paths.check, paths.state]) ensureManagedPath(repoRoot, target);
    const state = readState(repoRoot, definition.pass, id);
    if (state?.status === 'delegated' || state?.status === 'applied') throw new Error(`${statusLabel(state)}の束は run できません: ${id}`);
    const present = exists(paths.worktree);
    if (present) validateBatchWorktree(repoRoot, paths.worktree, definition.base);
    if (!options.fresh) {
      if (present && state === null) throw new Error(`作業ツリーに準備完了の記録がありません。確認して --fresh で作り直してください: ${id}`);
      if (!present && state !== null) throw new Error(`記録に対応する作業ツリーがありません。--fresh で作り直してください: ${id}`);
      if (!present && [paths.baseline, paths.hashes, paths.prompt, paths.report, paths.check].some(exists)) {
        throw new Error(`準備途中のファイルがあります。確認して --fresh で作り直してください: ${id}`);
      }
    }
    if (present && !options.fresh) verifyBaseline(repoRoot, paths, batch.files);
    const snapshot = present && !options.fresh ? createGitSnapshot(paths.worktree) : baseline;
    const changed = present && !options.fresh ? changedAssignedFiles(paths.worktree, batch.files) : null;
    const prompt = generatePrompt({ ...context, snapshot, changed });
    return { context, state, present, prompt };
  });
  for (const job of jobs) {
    const { context, state, present } = job;
    const { paths, batch } = context;
    if (options.fresh) {
      if (present) removeBatchWorktree(repoRoot, paths.worktree);
      removeArtifacts(repoRoot, paths);
    }
    if (!present || options.fresh) {
      createBatchWorktree(repoRoot, paths.worktree, definition.base);
      const snapshot = createGitSnapshot(paths.worktree);
      const files = snapshot.listFiles().filter((file) => isTargetFile(file, config));
      const hashList = createHashList(snapshot, [...new Set([...files, ...batch.files])]);
      const contents = snapshot.readMany(batch.files);
      const prompt = generatePrompt({ ...context, snapshot });
      writeBaseline(repoRoot, paths, contents, hashList);
      writeManagedFile(repoRoot, paths.prompt, prompt);
      writeState(repoRoot, definition.pass, batch.id, transitionState(state, 'prepared', { pass: definition.pass, batch: batch.id }));
    } else writeManagedFile(repoRoot, paths.prompt, job.prompt);
    io.stdout(`${batch.id}: ${present && !options.fresh ? '再開' : '用意済み'}\n作業ツリー: ${paths.worktree}\n依頼文: ${paths.prompt}`);
  }
  return 0;
}
