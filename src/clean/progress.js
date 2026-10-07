import fs from 'node:fs';
import path from 'node:path';
import { ensureManagedPath, relativeFilePath } from '../paths.js';
import { writeManagedFile } from '../run/artifacts.js';
import { fileStatus } from './tree.js';

export function progressPath(paths) {
  return path.join(path.dirname(paths.state), '..', `clean-${path.basename(paths.state)}`);
}

export function readProgress(repoRoot, paths, definition, batch, state) {
  const target = progressPath(paths);
  ensureManagedPath(repoRoot, target);
  let progress;
  try { progress = JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (progress.schemaVersion !== 1) throw new Error('片付けの記録は schemaVersion 1 が必要です');
  if (progress.prepared !== state.timestamps.prepared) return null;
  if (progress.base !== definition.base || progress.pass !== definition.pass || progress.batch !== batch.id
    || progress.directory !== paths.worktree || JSON.stringify(progress.assigned) !== JSON.stringify(batch.files)
    || !Array.isArray(progress.outside) || !Array.isArray(progress.removed)) throw new Error('片付けの記録が束と一致しません');
  const allowed = new Set([...batch.files, ...progress.outside.map(entry => entry.file)]);
  const safeFile = file => typeof file === 'string' && relativeFilePath(file) === file && !file.split('/').includes('.git');
  if (progress.outside.some(entry => !safeFile(entry.file) || !['file', 'link'].includes(entry.type)
    || !['100644', '100755', '120000'].includes(entry.mode) || !/^[a-f0-9]{64}$/u.test(entry.hash))
    || new Set(progress.outside.map(entry => entry.file)).size !== progress.outside.length
    || progress.removed.some(file => !safeFile(file) || !allowed.has(file))
    || (progress.pending !== null && (!safeFile(progress.pending) || !allowed.has(progress.pending)))) throw new Error('片付けの記録の形が不正です');
  return progress;
}

export function createProgress(job, definition) {
  return { schemaVersion: 1, pass: definition.pass, batch: job.batch.id, base: definition.base,
    directory: job.paths.worktree, prepared: job.state.timestamps.prepared, assigned: job.batch.files,
    outside: job.tree.outside ?? [], removed: [], pending: null };
}

export function recordRemoval(repoRoot, job, file, remove) {
  const progress = job.progress;
  if (progress.pending && !fileStatus(path.join(job.paths.worktree, progress.pending))
    && !progress.removed.includes(progress.pending)) progress.removed.push(progress.pending);
  progress.pending = file;
  writeManagedFile(repoRoot, progressPath(job.paths), `${JSON.stringify(progress, null, 2)}\n`);
  remove();
  if (!progress.removed.includes(file)) progress.removed.push(file);
  progress.pending = null;
  writeManagedFile(repoRoot, progressPath(job.paths), `${JSON.stringify(progress, null, 2)}\n`);
}
