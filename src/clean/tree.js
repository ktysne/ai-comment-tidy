import fs from 'node:fs';
import path from 'node:path';
import { ensureManagedPath } from '../paths.js';

export function fileStatus(target) {
  try { return fs.lstatSync(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function inspectTree(directory) {
  const tree = { files: [], links: [], directories: [] };
  if (!fileStatus(directory)) return tree;
  const visit = (current) => {
    for (const name of fs.readdirSync(current)) {
      const absolute = path.join(current, name);
      const relative = path.relative(directory, absolute).split(path.sep).join('/');
      const status = fs.lstatSync(absolute);
      if (current !== directory && name === '.git') throw new Error(`入れ子のリポジトリは削除できません: ${absolute}`);
      if (status.isSymbolicLink()) tree.links.push(relative);
      else if (status.isDirectory()) {
        if (name === '.git') throw new Error(`作業ツリーの .git が通常のファイルではありません: ${absolute}`);
        visit(absolute);
        tree.directories.push(relative);
      } else if (status.isFile()) tree.files.push(relative);
      else throw new Error(`通常のファイルやリンクではないため削除できません: ${absolute}`);
    }
  };
  visit(directory);
  return tree;
}

function checkedPath(repoRoot, directory, relative) {
  ensureManagedPath(repoRoot, directory);
  const target = path.resolve(directory, relative);
  const inside = path.relative(directory, target);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error(`削除対象が作業ツリーの外です: ${target}`);
  let current = directory;
  for (const part of inside.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    const status = fs.lstatSync(current);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`削除対象の親が通常のディレクトリではありません: ${current}`);
  }
  return target;
}

export function unlinkTreeEntry(repoRoot, directory, relative, link) {
  const target = checkedPath(repoRoot, directory, relative);
  const status = fs.lstatSync(target);
  if (link ? !status.isSymbolicLink() : !status.isFile()) throw new Error(`削除対象の種類が変わりました: ${target}`);
  fs.unlinkSync(target);
}

export function removeEmptyDirectories(repoRoot, directory, tree) {
  for (const relative of tree.directories) {
    const target = checkedPath(repoRoot, directory, relative);
    const status = fileStatus(target);
    if (!status) continue;
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`削除対象の種類が変わりました: ${target}`);
    try { fs.rmdirSync(target); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
    }
  }
}

export function removeEmptyRoot(repoRoot, directory) {
  ensureManagedPath(repoRoot, directory);
  if (!fileStatus(directory)) return;
  try { fs.rmdirSync(directory); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
  }
}
