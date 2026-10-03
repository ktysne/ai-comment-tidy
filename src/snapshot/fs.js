import fs from 'node:fs';
import path from 'node:path';

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function resolveFilePath(root, filePath) {
  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    throw new Error(`写しの中の相対パスを指定してください: ${filePath}`);
  }
  const absolutePath = path.resolve(root, filePath);
  const relativePath = path.relative(root, absolutePath);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`写しの中の相対パスを指定してください: ${filePath}`);
  }
  return absolutePath;
}

export function createFsSnapshot(root, filePaths) {
  const normalizedRoot = path.resolve(root);
  const files = new Set(filePaths.map((filePath) => {
    const normalizedPath = normalizePath(filePath);
    resolveFilePath(normalizedRoot, normalizedPath);
    return normalizedPath;
  }));
  const snapshot = {
    listFiles() {
      return [...files];
    },
    read(filePath) {
      const normalizedPath = normalizePath(filePath);
      if (!files.has(normalizedPath)) throw new Error(`写しにファイルがありません: ${normalizedPath}`);
      return fs.readFileSync(resolveFilePath(normalizedRoot, normalizedPath));
    },
    has(filePath) {
      return files.has(normalizePath(filePath));
    },
    readMany(filePaths) {
      return new Map(filePaths.map((filePath) => [normalizePath(filePath), snapshot.read(filePath)]));
    },
  };
  return snapshot;
}
