import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createGitSnapshot } from '../snapshot/git.js';
import { validateBatchWorktree } from '../snapshot/worktree.js';
import { ensureManagedPath } from '../paths.js';
import { fileStatus, inspectTree } from './tree.js';
import { sha256 } from '../snapshot/hash-list.js';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { maxBuffer: 1 << 30 }).toString('utf8');
}

function baseEntries(repoRoot, base) {
  return git(repoRoot, ['ls-tree', '-r', '-z', base]).split('\0').filter(Boolean).map((record) => {
    const separator = record.indexOf('\t');
    const [mode, , objectId] = record.slice(0, separator).split(' ');
    return { file: record.slice(separator + 1), mode, objectId };
  });
}

function verifyChanges(repoRoot, directory, definition, batch, tree, progress) {
  const assigned = new Set(batch.files);
  const entries = baseEntries(repoRoot, definition.base);
  if (entries.some((entry) => entry.mode === '160000')) throw new Error('サブモジュールがある作業ツリーは削除できません');
  const byPath = new Map(entries.map((entry) => [entry.file, entry]));
  const files = new Set(tree.files.filter((file) => file !== '.git'));
  const links = new Set(tree.links);
  for (const file of [...files, ...links]) {
    if (!byPath.has(file) && !assigned.has(file)) throw new Error(`担当外の未追跡ファイルがあります: ${file}`);
  }
  for (const record of git(directory, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
    const header = record.slice(0, record.indexOf('\t')).split(' ');
    if (header[0] === '160000' || header[2] !== '0') throw new Error('サブモジュールや未解決のインデックスは削除できません');
  }
  const staged = git(directory, ['diff', '--cached', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', definition.base]);
  for (const file of staged.split('\0').filter(Boolean)) {
    if (!assigned.has(file)) throw new Error(`担当外のステージ済み変更があります: ${file}`);
  }
  const outside = entries.filter((entry) => !assigned.has(entry.file));
  const saved = progress ? new Map(progress.outside.map(entry => [entry.file, entry])) : null;
  if (saved && (saved.size !== outside.length || outside.some(entry => saved.get(entry.file)?.mode !== entry.mode))) {
    throw new Error('片付けの記録に担当外の基準がありません');
  }
  const regular = outside.filter(entry => entry.mode !== '120000');
  const contents = saved ? null : createGitSnapshot(directory, definition.base).readMany(regular.map(entry => entry.file));
  tree.outside = [];
  for (const { file, mode, objectId } of outside) {
    const target = path.join(directory, file);
    const type = links.has(file) ? 'link' : files.has(file) ? 'file' : null;
    const previous = saved?.get(file);
    if (!type && !tree.directories.includes(file) && previous && (progress.removed.includes(file) || progress.pending === file)) {
      tree.outside.push(previous);
      continue;
    }
    if (!type || (mode !== '120000' && type !== 'file') || (previous && previous.type !== type)) {
      throw new Error(`担当外のファイルに削除や種類の変更があります: ${file}`);
    }
    const actual = type === 'link' ? Buffer.from(fs.readlinkSync(target)) : fs.readFileSync(target);
    const expectedHash = previous?.hash ?? sha256(mode === '120000'
      ? execFileSync('git', ['-C', repoRoot, 'cat-file', 'blob', objectId]) : contents.get(file));
    if (sha256(actual) !== expectedHash) throw new Error(`担当外のファイルに変更があります: ${file}`);
    if (mode !== '120000' && process.platform !== 'win32' && Boolean(fs.lstatSync(target).mode & 0o111) !== (mode === '100755')) {
      throw new Error(`担当外のモードに変更があります: ${file}`);
    }
    tree.outside.push({ file, mode, type, hash: expectedHash });
  }
}

export function inspectCandidate(repoRoot, definition, batch, directory, registration, progress) {
  ensureManagedPath(repoRoot, directory);
  const status = fileStatus(directory);
  if (status && (!status.isDirectory() || status.isSymbolicLink())) throw new Error(`作業ツリーが通常のディレクトリではありません: ${directory}`);
  if (status && path.relative(fs.realpathSync(repoRoot), fs.realpathSync(directory)) !== path.relative(repoRoot, directory)) {
    throw new Error(`作業ツリーの実体が管理用ディレクトリの外です: ${directory}`);
  }
  if (registration && (registration.locked || !registration.detached || registration.head !== definition.base)) {
    throw new Error(`作業ツリーの登録がロック中、別ブランチ、または基準外です: ${directory}`);
  }
  const tree = inspectTree(directory);
  const dataFiles = tree.files.filter((file) => file !== '.git');
  const empty = dataFiles.length === 0 && tree.links.length === 0;
  if (!registration && !empty) throw new Error(`作業ツリーが対象リポジトリに登録されていません: ${directory}`);
  if (tree.files.includes('.git')) {
    if (!registration) throw new Error(`登録のない .git を持つディレクトリは削除できません: ${directory}`);
    validateBatchWorktree(repoRoot, directory, definition.base);
    const admin = git(directory, ['rev-parse', '--absolute-git-dir']).trim();
    const backPointer = fs.readFileSync(path.join(admin, 'gitdir'), 'utf8').trim();
    if (path.relative(path.resolve(backPointer), path.join(directory, '.git')) !== '') {
      throw new Error(`作業ツリーと Git の登録先が一致しません: ${directory}`);
    }
    if (!empty) verifyChanges(repoRoot, directory, definition, batch, tree, progress);
  } else if (!empty) throw new Error(`作業ツリーの .git が欠けています: ${directory}`);
  return tree;
}
