import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensureManagedPath } from '../paths.js';
import { readHashList, sha256, validateHashList } from '../snapshot/hash-list.js';

export function writeManagedFile(repoRoot, filePath, content) {
  ensureManagedPath(repoRoot, filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx' });
    ensureManagedPath(repoRoot, filePath);
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function verifyBaseline(repoRoot, paths, files, scopeFiles) {
  ensureManagedPath(repoRoot, paths.hashes);
  const hashes = readHashList(paths.hashes);
  const missing = scopeFiles.filter((file) => !Object.hasOwn(hashes.files, file));
  if (missing.length) throw new Error(`現在の対象範囲のハッシュがありません。確認して --fresh で作り直してください: ${missing.join('、')}`);
  for (const file of files) {
    const target = path.join(paths.baseline, ...file.split('/'));
    ensureManagedPath(repoRoot, target);
    if (!fs.lstatSync(target).isFile() || !Object.hasOwn(hashes.files, file)
      || sha256(fs.readFileSync(target)) !== hashes.files[file]) throw new Error(`基準の写しとハッシュが一致しません: ${file}`);
  }
}

export function writeBaseline(repoRoot, paths, contents, hashList) {
  for (const [file, content] of contents) writeManagedFile(repoRoot, path.join(paths.baseline, ...file.split('/')), content);
  writeManagedFile(repoRoot, paths.hashes, `${JSON.stringify(validateHashList(hashList), null, 2)}\n`);
}

export function removeArtifacts(repoRoot, paths) {
  for (const target of [paths.state, paths.baseline, paths.hashes, paths.prompt, paths.report, paths.check]) {
    ensureManagedPath(repoRoot, target);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(`${path.resolve(repoRoot, '.comment-tidy', 'work')}${path.sep}`)) throw new Error('作業用の置き場以外は削除できません');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
