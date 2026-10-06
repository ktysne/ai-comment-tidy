import fs from 'node:fs';
import path from 'node:path';
import { batchDefinitionPath, relativeFilePath, validateName } from './paths.js';

const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function validatePaths(values, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(values) || (nonEmpty && values.length === 0)) throw new Error(`${label} はパスの配列で指定してください`);
  const normalized = values.map(relativeFilePath);
  if (normalized.some((value, index) => value !== values[index]) || new Set(values).size !== values.length) {
    throw new Error(`${label} は重複しない / 区切りの相対パスで指定してください`);
  }
}

export function validateBatchDefinition(value, expectedPass) {
  if (!value || value.schemaVersion !== 1) throw new Error('束の定義は schemaVersion 1 が必要です');
  validateName(value.pass, '回');
  if (expectedPass !== undefined && value.pass !== expectedPass) throw new Error('束の定義の回とファイル名が一致しません');
  if (typeof value.base !== 'string' || !COMMIT_PATTERN.test(value.base)
    || (value.toolCommit !== null && (typeof value.toolCommit !== 'string' || !COMMIT_PATTERN.test(value.toolCommit)))) {
    throw new Error('束の定義のコミットは完全な SHA、道具のコミットは SHA か null で指定してください');
  }
  if (!Array.isArray(value.batches)) throw new Error('束の定義には batches の配列が必要です');
  const ids = new Set();
  const files = new Set();
  for (const batch of value.batches) {
    if (!batch || typeof batch !== 'object') throw new Error('束はオブジェクトで指定してください');
    validateName(batch.id, '束');
    if (ids.has(batch.id)) throw new Error(`束の名前が重複しています: ${batch.id}`);
    ids.add(batch.id);
    if (typeof batch.area !== 'string' || !batch.area || !Number.isFinite(batch.weight) || batch.weight < 0
      || !Number.isSafeInteger(batch.commentChars) || batch.commentChars < 0) throw new Error(`束の集計値が不正です: ${batch.id}`);
    validatePaths(batch.files, '担当ファイル', { nonEmpty: true });
    validatePaths(batch.docs, '資料');
    for (const file of batch.files) {
      if (files.has(file)) throw new Error(`担当ファイルが別の束と重複しています: ${file}`);
      files.add(file);
    }
  }
  return value;
}

export function readBatchDefinition(repoRoot, pass) {
  const filePath = batchDefinitionPath(repoRoot, pass);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`束の定義を読めません: ${filePath} (${error.message})`, { cause: error });
  }
  return validateBatchDefinition(value, pass);
}

export function selectBatch(repoRoot, id, pass) {
  validateName(id, '束');
  if (pass === undefined) {
    const directory = path.join(repoRoot, '.comment-tidy');
    const candidates = fs.readdirSync(directory).filter((name) => /^batches-.+\.json$/u.test(name));
    if (candidates.length !== 1) throw new Error('束の定義が一つだけでないため --pass で回を指定してください');
    pass = candidates[0].slice('batches-'.length, -'.json'.length);
  }
  const definition = readBatchDefinition(repoRoot, pass);
  const batch = definition.batches.find((candidate) => candidate.id === id);
  if (!batch) throw new Error(`束がありません: ${pass}/${id}`);
  return { definition, batch };
}
