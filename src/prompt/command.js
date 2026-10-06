import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectBatch } from '../batches.js';
import { loadConfig } from '../config.js';
import { batchPaths, ensureManagedPath, resolveExternalPath, validateName } from '../paths.js';
import { changedAssignedFiles, createGitSnapshot, repositoryRoot } from '../snapshot/git.js';
import { generatePrompt } from './run.js';

const TOOL_PATH = fileURLToPath(new URL('../../bin/comment-tidy.js', import.meta.url));

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
  const pass = definition.pass;
  if (!config.passes || !Object.hasOwn(config.passes, pass)) throw new Error(`設定に回がありません: ${pass}`);
  if (!config.rulesPaths?.length) throw new Error('依頼文には rulesPaths でコメント記述ルールの正本を指定してください');
  const paths = batchPaths(repoRoot, pass, batch.id);
  ensureManagedPath(repoRoot, paths.worktree);
  const criteriaPath = resolveExternalPath(config.passes[pass].criteria, path.join(repoRoot, '.comment-tidy'));
  const criteria = fs.readFileSync(criteriaPath, 'utf8');
  const rulesPaths = (config.rulesPaths ?? []).map((file) => resolveExternalPath(file, repoRoot));
  const docsPaths = batch.docs.map((file) => path.resolve(repoRoot, file));
  let snapshot;
  let changed = null;
  if (worktreeExists(paths.worktree)) {
    if (path.relative(paths.worktree, repositoryRoot(paths.worktree)) !== '') throw new Error('作業ツリーの置き場が独立したリポジトリではありません');
    snapshot = createGitSnapshot(paths.worktree);
    changed = changedAssignedFiles(paths.worktree, batch.files);
  } else {
    snapshot = createGitSnapshot(repoRoot, definition.base);
  }
  const prompt = generatePrompt({
    batch, paths, criteria, criteriaPath, rulesPaths, docsPaths, snapshot, changed, config, configPath, toolPath: TOOL_PATH,
  });
  io.stdout(prompt);
  return 0;
}
