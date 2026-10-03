import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_GIT_BUFFER = 1 << 30;

function git(repoRoot, args, input) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    input,
    maxBuffer: MAX_GIT_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function repositoryRoot(repoRoot) {
  return path.resolve(git(repoRoot, ['rev-parse', '--show-toplevel']).toString('utf8').trim());
}

function nulFields(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function worktreeFiles(repoRoot) {
  return nulFields(git(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
    .filter((filePath) => fs.existsSync(path.join(repoRoot, ...filePath.split('/'))));
}

function committedFiles(repoRoot, ref) {
  const entries = git(repoRoot, ['ls-tree', '-r', '-z', ref]);
  const files = new Map();
  for (const entry of nulFields(entries)) {
    const separator = entry.indexOf('\t');
    const [mode, type, objectId] = entry.slice(0, separator).split(' ');
    if (type === 'blob' && mode) files.set(normalizePath(entry.slice(separator + 1)), objectId);
  }
  return files;
}

// --filters 付きの --batch はヘッダに変換前の大きさを出すため(git 2.54 で確認)、
// 各ファイルの後ろに存在しない名前の行を足し、その missing の行で内容の終わりを見つける。
function readFilteredBlobs(repoRoot, entries) {
  const contents = new Map();
  if (entries.length === 0) return contents;
  const endMarker = `comment-tidy-end-${randomBytes(16).toString('hex')}`;
  const input = entries.map(([filePath, objectId]) => `${objectId} ${filePath}\n${endMarker} ${filePath}\n`).join('');
  const output = git(repoRoot, ['cat-file', '--batch', '--filters'], Buffer.from(input, 'utf8'));
  const markerLine = Buffer.from(`\n${endMarker} missing\n`, 'utf8');
  let position = 0;
  for (const [filePath, objectId] of entries) {
    const headerEnd = output.indexOf(0x0a, position);
    const contentStart = headerEnd + 1;
    const contentEnd = headerEnd < 0 ? -1 : output.indexOf(markerLine, headerEnd);
    const [returnedObjectId, type] = output.subarray(position, Math.max(headerEnd, position)).toString('ascii').split(' ');
    if (headerEnd < 0 || returnedObjectId !== objectId || type !== 'blob' || contentEnd < contentStart) {
      throw new Error(`コミットの内容を読めません: ${filePath}`);
    }
    contents.set(filePath, output.subarray(contentStart, contentEnd));
    position = contentEnd + markerLine.length;
  }
  return contents;
}

export function resolveCommit(repoRoot, ref) {
  return git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).toString('utf8').trim();
}

export function createGitSnapshot(repoRoot, ref = null) {
  const root = repositoryRoot(repoRoot);
  const files = ref === null ? null : committedFiles(root, ref);
  const worktreePaths = ref === null ? new Set(worktreeFiles(root)) : null;

  const readMany = (filePaths) => {
    const normalizedPaths = filePaths.map(normalizePath);
    if (ref === null) return new Map(normalizedPaths.map((filePath) => [filePath, snapshot.read(filePath)]));
    return readFilteredBlobs(root, normalizedPaths.map((filePath) => {
      const objectId = files.get(filePath);
      if (!objectId) throw new Error(`コミットにファイルがありません: ${filePath}`);
      return [filePath, objectId];
    }));
  };

  const snapshot = {
    listFiles() {
      return ref === null ? [...worktreePaths] : [...files.keys()];
    },
    read(filePath) {
      const normalizedPath = normalizePath(filePath);
      if (ref !== null) return readMany([normalizedPath]).get(normalizedPath);
      if (!worktreePaths.has(normalizedPath)) throw new Error(`作業ツリーにファイルがありません: ${normalizedPath}`);
      return fs.readFileSync(path.join(root, ...normalizedPath.split('/')));
    },
    has(filePath) {
      const normalizedPath = normalizePath(filePath);
      return ref === null ? worktreePaths.has(normalizedPath) : files.has(normalizedPath);
    },
    readMany,
  };
  return snapshot;
}
