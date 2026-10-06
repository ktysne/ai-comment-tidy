import fs from 'node:fs';
import path from 'node:path';
import { selectBatch } from '../batches.js';
import { loadConfig } from '../config.js';
import { ensureManagedPath, validateName } from '../paths.js';
import { changedAssignedFiles, createGitSnapshot, repositoryRoot } from '../snapshot/git.js';
import { generatePrompt } from './run.js';
import { promptContext } from './context.js';

function parseArgs(argv) {
  const options = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (['--pass', '--repo', '--config'].includes(argument)) {
      if (seen.has(argument)) throw new Error(`${argument} は1つだけ指定できます`);
      seen.add(argument);
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} の後に値を指定してください`);
      options[{ '--pass': 'pass', '--repo': 'repoRoot', '--config': 'configPath' }[argument]] = value;
    } else if (argument.startsWith('-')) {
      throw new Error(`認識できない引数です: ${argument}`);
    } else if (options.batch === undefined) options.batch = argument;
    else throw new Error('束は1つだけ指定してください');
  }
  validateName(options.batch, '束');
  if (options.pass !== undefined) validateName(options.pass, '回');
  if (options.configPath !== undefined && !path.isAbsolute(options.configPath) && !path.win32.isAbsolute(options.configPath)) {
    throw new Error('--config には絶対パスを指定してください');
  }
  return options;
}

function worktreeExists(directory) {
  try {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error(`作業ツリーの置き場が通常のディレクトリではありません: ${directory}`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function runPromptCommand(argv, io) {
  const options = parseArgs(argv);
  const repoRoot = repositoryRoot(path.resolve(options.repoRoot ?? process.cwd()));
  const configPath = path.resolve(options.configPath ?? path.join(repoRoot, '.comment-tidy', 'config.json'));
  const config = loadConfig(repoRoot, configPath);
  const { definition, batch } = selectBatch(repoRoot, options.batch, options.pass);
  const context = promptContext(repoRoot, definition, batch, config, configPath);
  const { paths } = context;
  ensureManagedPath(repoRoot, paths.worktree);
  let snapshot;
  let changed = null;
  if (worktreeExists(paths.worktree)) {
    if (path.relative(paths.worktree, repositoryRoot(paths.worktree)) !== '') throw new Error('作業ツリーの置き場が独立したリポジトリではありません');
    snapshot = createGitSnapshot(paths.worktree);
    changed = changedAssignedFiles(paths.worktree, batch.files);
  } else {
    snapshot = createGitSnapshot(repoRoot, definition.base);
  }
  const prompt = generatePrompt({ ...context, snapshot, changed });
  io.stdout(prompt);
  return 0;
}
