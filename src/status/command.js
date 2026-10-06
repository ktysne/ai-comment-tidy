import fs from 'node:fs';
import path from 'node:path';
import { selectBatchDefinition } from '../batches.js';
import { loadConfig } from '../config.js';
import { batchPaths, ensureManagedPath, validateName } from '../paths.js';
import { createGitSnapshot, repositoryRoot } from '../snapshot/git.js';
import { readState } from '../state.js';
import { formatStatus, statusForBatches } from './run.js';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const key = { '--pass': 'pass', '--repo': 'repoRoot', '--config': 'configPath' }[argument];
    if (!key) throw new Error(`認識できない引数です: ${argument}`);
    if (Object.hasOwn(options, key)) throw new Error(`${argument} は1つだけ指定できます`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} の後に値を指定してください`);
    options[key] = value;
  }
  if (options.pass !== undefined) validateName(options.pass, '回');
  if (options.configPath !== undefined && !path.isAbsolute(options.configPath) && !path.win32.isAbsolute(options.configPath)) {
    throw new Error('--config には絶対パスを指定してください');
  }
  return options;
}

function directoryExists(directory) {
  try {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error(`作業ツリーの置き場が通常のディレクトリではありません: ${directory}`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function runStatusCommand(argv, io) {
  const options = parseArgs(argv);
  const repoRoot = repositoryRoot(path.resolve(options.repoRoot ?? process.cwd()));
  const config = loadConfig(repoRoot, options.configPath);
  const definition = selectBatchDefinition(repoRoot, options.pass);
  if (!config.passes || !Object.hasOwn(config.passes, definition.pass)) throw new Error(`設定に回がありません: ${definition.pass}`);
  const baseline = createGitSnapshot(repoRoot, definition.base);
  const states = new Map();
  const currentByBatch = new Map();
  let integration;
  for (const batch of definition.batches) {
    const paths = batchPaths(repoRoot, definition.pass, batch.id);
    ensureManagedPath(repoRoot, paths.state);
    ensureManagedPath(repoRoot, paths.worktree);
    const state = readState(repoRoot, definition.pass, batch.id);
    states.set(batch.id, state);
    if (state?.status === 'applied') {
      integration ??= createGitSnapshot(repoRoot);
      currentByBatch.set(batch.id, { snapshot: integration, source: '統合先' });
    } else if (directoryExists(paths.worktree)) {
      if (path.relative(paths.worktree, repositoryRoot(paths.worktree)) !== '') throw new Error('作業ツリーの置き場が独立したリポジトリではありません');
      currentByBatch.set(batch.id, { snapshot: createGitSnapshot(paths.worktree), source: '束の作業ツリー' });
    }
  }
  io.stdout(formatStatus(statusForBatches({ definition, baseline, states, currentByBatch, config })));
  return 0;
}
