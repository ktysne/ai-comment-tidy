import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { selectBatch } from '../batches.js';
import { loadConfig } from '../config.js';
import { batchPaths, ensureManagedPath, validateName } from '../paths.js';
import { changedAssignedFiles, createGitSnapshot, repositoryRoot } from '../snapshot/git.js';
import { validateBatchWorktree } from '../snapshot/worktree.js';
import { readState, transitionState, writeState } from '../state.js';
import { runCheck } from '../check/run.js';
import { recordBatchCheck } from '../check/results.js';
import { formatSummary } from '../check/summary.js';

function parseArgs(argv) {
  const options = {};
  const keys = { '--repo': 'repoRoot', '--pass': 'pass', '--config': 'configPath' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (Object.hasOwn(keys, argument)) {
      const key = keys[argument];
      if (options[key] !== undefined) throw new Error(`${argument} は1つだけ指定できます`);
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} の後に値を指定してください`);
      options[key] = value;
    } else if (!argument.startsWith('-') && options.batch === undefined) options.batch = argument;
    else throw new Error(`認識できない引数です: ${argument}`);
  }
  validateName(options.batch, '束');
  if (options.pass !== undefined) validateName(options.pass, '回');
  if (options.configPath !== undefined && !path.isAbsolute(options.configPath) && !path.win32.isAbsolute(options.configPath)) {
    throw new Error('--config には絶対パスを指定してください');
  }
  return options;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function regularTarget(root, file) {
  let target = root;
  const parts = file.split('/');
  for (const [index, part] of parts.entries()) {
    target = path.join(target, part);
    const status = fs.lstatSync(target);
    if (status.isSymbolicLink() || (index === parts.length - 1 ? !status.isFile() || status.nlink > 1 : !status.isDirectory())) {
      throw new Error(`担当ファイルの置き場にリンクか不正な要素があります: ${file}`);
    }
  }
  return target;
}

export function runApplyCommand(argv, io) {
  const options = parseArgs(argv);
  const repoRoot = repositoryRoot(path.resolve(options.repoRoot ?? process.cwd()));
  const config = loadConfig(repoRoot, options.configPath);
  const { definition, batch } = selectBatch(repoRoot, options.batch, options.pass);
  const pass = definition.pass;
  if (!config.passes || !Object.hasOwn(config.passes, pass)) throw new Error(`設定に回がありません: ${pass}`);
  const paths = batchPaths(repoRoot, pass, batch.id);
  for (const target of [paths.worktree, paths.state, paths.check]) ensureManagedPath(repoRoot, target);
  const state = readState(repoRoot, pass, batch.id);
  if (state?.status !== 'checked' || state.check?.ok !== true || state.check.offline !== false
    || state.check.base !== definition.base || state.check.pass !== pass || state.check.batch !== batch.id) {
    throw new Error('取り込みには束の最新の通常検査の合格が必要です');
  }
  const branch = git(repoRoot, ['branch', '--show-current']);
  if (!branch || branch === 'main') throw new Error('統合先は main 以外のブランチが必要です');
  git(repoRoot, ['merge-base', '--is-ancestor', definition.base, 'HEAD']);
  validateBatchWorktree(repoRoot, paths.worktree, definition.base);
  for (const file of batch.files) regularTarget(paths.worktree, file);
  const base = createGitSnapshot(repoRoot, definition.base);
  const head = createGitSnapshot(repoRoot, 'HEAD');
  const original = new Map();
  const baseRaw = base.readManyRaw(batch.files);
  const headRaw = head.readManyRaw(batch.files);
  const baseContents = base.readMany(batch.files);
  git(repoRoot, ['diff', '--quiet', definition.base, 'HEAD', '--', ...batch.files.map((file) => `:(literal)${file}`)]);
  for (const file of batch.files) {
    if (!baseRaw.get(file).equals(headRaw.get(file))) throw new Error(`統合先の HEAD が基準から変わっています: ${file}`);
    const destination = regularTarget(repoRoot, file);
    original.set(file, fs.readFileSync(destination));
    if (!original.get(file).equals(baseContents.get(file)) && !original.get(file).equals(baseRaw.get(file))) {
      throw new Error(`統合先の担当ファイルが基準から変わっています: ${file}`);
    }
  }
  if (changedAssignedFiles(repoRoot, batch.files).size) throw new Error('統合先の担当ファイルに未コミットの変更があります');
  const baseline = Object.assign(createGitSnapshot(paths.worktree, definition.base), { base: definition.base });
  const source = createGitSnapshot(paths.worktree);
  const contents = new Map();
  const target = { ...source, readMany(files) {
    const values = source.readMany(files);
    for (const [file, value] of values) contents.set(file, value);
    return values;
  } };
  const result = { ...runCheck({ files: batch.files, baseline, target, config }), pass, batch: batch.id };
  const checked = recordBatchCheck(repoRoot, paths, state, result);
  if (!result.ok) {
    io.stdout(formatSummary(result));
    return 1;
  }
  const written = [];
  try {
    for (const file of batch.files) {
      const destination = regularTarget(repoRoot, file);
      if (!fs.readFileSync(destination).equals(original.get(file))) throw new Error(`取り込み中に統合先が変わりました: ${file}`);
      written.push(file);
      fs.writeFileSync(destination, contents.get(file));
    }
    writeState(repoRoot, pass, batch.id, transitionState(checked, 'applied'));
  } catch (error) {
    const failures = [];
    for (const file of written.reverse()) {
      try { fs.writeFileSync(regularTarget(repoRoot, file), original.get(file)); }
      catch (rollbackError) { failures.push(`${file}: ${rollbackError.message}`); }
    }
    if (failures.length) throw new Error(`${error.message}; 復元できない担当ファイルがあります: ${failures.join(', ')}`, { cause: error });
    throw error;
  }
  io.stdout(`${batch.id}: 取り込み済み\n統合先: ${branch}\n担当ファイルを確認してコミットしてください`);
  return 0;
}
