import fs from 'node:fs';
import path from 'node:path';
import { createFsSnapshot } from '../snapshot/fs.js';

function isRegularFile(root, filePath) {
  try {
    return fs.lstatSync(path.resolve(root, ...filePath.split('/'))).isFile();
  } catch {
    return false;
  }
}

export function offlineSnapshots(options, repoRoot, hashList) {
  const baseDir = path.resolve(options.baseDir);
  const baseline = Object.assign(createFsSnapshot(baseDir, options.files), { baseDir });
  const possibleFiles = [...new Set([...options.files, ...Object.keys(hashList.files)])]
    .filter((filePath) => isRegularFile(repoRoot, filePath));
  const target = createFsSnapshot(repoRoot, possibleFiles);
  return { baseline, target };
}
