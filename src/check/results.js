import { transitionState, updateState, writeState } from '../state.js';
import { writeManagedFile } from '../run/artifacts.js';

export function recordBatchCheck(repoRoot, paths, state, result) {
  const next = result.ok
    ? transitionState(state, 'checked', { now: result.checkedAt, changes: { check: result } })
    : updateState(state, { check: result });
  if (state.check !== null) writeState(repoRoot, result.pass, result.batch, updateState(state, { check: null }));
  writeManagedFile(repoRoot, paths.check, `${JSON.stringify(result, null, 2)}\n`);
  writeState(repoRoot, result.pass, result.batch, next);
  return next;
}
