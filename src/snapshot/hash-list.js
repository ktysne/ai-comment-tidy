import { createHash } from 'node:crypto';
import fs from 'node:fs';

const HASH_PATTERN = /^[a-f0-9]{64}$/;

function normalizedPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('ハッシュ一覧に空でない相対パスを指定してください');
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
    || normalized.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new Error(`ハッシュ一覧に相対パスを指定してください: ${filePath}`);
  }
  return normalized;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function createHashList(snapshot, filePaths = snapshot.listFiles()) {
  const paths = [...new Set(filePaths.map(normalizedPath))].sort();
  const contents = snapshot.readMany(paths);
  return {
    algorithm: 'sha256',
    files: Object.fromEntries(paths.map((filePath) => [filePath, sha256(contents.get(filePath))])),
  };
}

export function validateHashList(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value.algorithm !== 'sha256' || value.files === null || typeof value.files !== 'object' || Array.isArray(value.files)) {
    throw new Error('ハッシュ一覧は algorithm と files を持つ sha256 形式で指定してください');
  }
  const files = Object.create(null);
  for (const [filePath, hash] of Object.entries(value.files)) {
    const normalized = normalizedPath(filePath);
    if (normalized !== filePath || typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
      throw new Error(`ハッシュ一覧の値が不正です: ${filePath}`);
    }
    files[normalized] = hash;
  }
  return { algorithm: 'sha256', files };
}

export function readHashList(filePath) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`ハッシュ一覧を読めません: ${filePath} (${error.message})`, { cause: error });
  }
  return validateHashList(value);
}

export function writeHashList(filePath, hashList) {
  const validated = validateHashList(hashList);
  fs.writeFileSync(filePath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
}
