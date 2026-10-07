import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function validateName(value, label = '名前') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(value)) {
    throw new Error(`${label}には英数字、ハイフン、アンダースコアの安全な名前を指定してください`);
  }
  return value;
}

export function relativeFilePath(value) {
  if (typeof value !== 'string' || !value || value.includes(':')
    || [...value].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)) {
    throw new Error(`相対パスが不正です: ${value}`);
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`リポジトリ内の相対パスを指定してください: ${value}`);
  }
  return normalized;
}

export function batchDefinitionPath(repoRoot, pass) {
  return path.join(path.resolve(repoRoot), '.comment-tidy', `batches-${validateName(pass, '回')}.json`);
}

export function batchPaths(repoRoot, pass, batch) {
  validateName(pass, '回');
  validateName(batch, '束');
  const root = path.resolve(repoRoot);
  const work = path.join(root, '.comment-tidy', 'work', pass);
  return {
    root,
    definition: batchDefinitionPath(root, pass),
    worktree: path.join(root, '.comment-tidy', 'worktrees', pass, batch),
    baseline: path.join(work, 'base', batch),
    hashes: path.join(work, 'base', `${batch}.hashes.json`),
    prompt: path.join(work, 'prompts', `${batch}.md`),
    report: path.join(work, 'reports', `${batch}.md`),
    check: path.join(work, `check-${batch}.json`),
    state: path.join(work, 'state', `${batch}.json`),
  };
}

export function resolveExternalPath(value, root) {
  if (value === '~') return os.homedir();
  if (/^~[/\\]/u.test(value)) return path.resolve(os.homedir(), value.slice(2));
  return path.resolve(root, value);
}

export function formatPromptPath(value) {
  return value.replace(/\\/g, '/');
}

export function ensureManagedPath(repoRoot, target) {
  const root = path.resolve(repoRoot);
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep);
  const managedDir = process.platform === 'win32' ? parts[0].toLowerCase() : parts[0];
  if (managedDir !== '.comment-tidy' || parts.some((part) => part === '..') || path.isAbsolute(relative)) {
    throw new Error(`管理対象の置き場ではありません: ${target}`);
  }
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let status;
    try {
      status = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (status.isSymbolicLink() || (index < parts.length - 1 && !status.isDirectory())) {
      throw new Error(`管理対象の置き場にリンクかディレクトリ以外の要素があります: ${current}`);
    }
  }
}
