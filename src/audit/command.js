import path from 'node:path';
import { selectBatch } from '../batches.js';
import { loadConfig } from '../config.js';
import { assertSafeAssignedPath, batchPaths, ensureManagedPath, validateName } from '../paths.js';
import { createGitSnapshot, repositoryRoot } from '../snapshot/git.js';
import { validateBatchWorktree } from '../snapshot/worktree.js';
import { readState, statusLabel } from '../state.js';
import { statusForBatches } from '../status/run.js';
import { AUDIT_CHECKS, inspectHunks } from './checks.js';
import { extractHunks } from './hunks.js';
import { writeAudit } from './output.js';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const key = { '--pass': 'pass', '--repo': 'repoRoot', '--config': 'configPath' }[argument];
    if (key) {
      if (options[key] !== undefined) throw new Error(`${argument} は 1 つだけ指定できます`);
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} の値を指定してください`);
      options[key] = value;
    } else if (!argument.startsWith('-') && options.batch === undefined) options.batch = validateName(argument, '束');
    else throw new Error(`認識できない引数です: ${argument}`);
  }
  if (!options.batch) throw new Error('監査する束を指定してください');
  if (options.pass !== undefined) validateName(options.pass, '回');
  if (options.configPath !== undefined && !path.isAbsolute(options.configPath)) throw new Error('--config には絶対パスを指定してください');
  return options;
}

export function runAuditCommand(argv, io) {
  const options = parseArgs(argv);
  const repoRoot = repositoryRoot(path.resolve(options.repoRoot ?? process.cwd()));
  const config = loadConfig(repoRoot, options.configPath);
  const { definition, batch } = selectBatch(repoRoot, options.batch, options.pass);
  const pass = definition.pass;
  if (!config.passes || !Object.hasOwn(config.passes, pass)) throw new Error(`設定に回がありません: ${pass}`);
  const paths = batchPaths(repoRoot, pass, batch.id);
  const outputs = { markdown: path.join(path.dirname(paths.check), `audit-${batch.id}.md`),
    json: path.join(path.dirname(paths.check), `audit-${batch.id}.json`) };
  for (const file of [paths.worktree, paths.state, ...Object.values(outputs)]) ensureManagedPath(repoRoot, file);
  const state = readState(repoRoot, pass, batch.id);
  if (!['reported', 'checked'].includes(state?.status)) throw new Error(`監査できるのは報告ありか検査済みの束だけです: ${batch.id} (${statusLabel(state)})`);
  for (const file of batch.files) assertSafeAssignedPath(paths.worktree, file);
  validateBatchWorktree(repoRoot, paths.worktree, definition.base);
  const baseline = createGitSnapshot(paths.worktree, definition.base);
  const target = createGitSnapshot(paths.worktree);
  const measured = statusForBatches({ definition: { ...definition, batches: [batch] }, baseline,
    currentByBatch: new Map([[batch.id, { snapshot: target, source: '束の作業ツリー' }]]),
    states: new Map([[batch.id, state]]), config });
  const row = measured.rows[0];
  if (row.missing.length) throw new Error(`作業ツリーに担当ファイルがありません: ${row.missing.join('、')}`);
  const before = baseline.readManyRaw(batch.files);
  const after = target.readMany(batch.files);
  const findings = batch.files.flatMap((file) => inspectHunks({ ...extractHunks({ worktree: paths.worktree,
    base: definition.base, file, before: before.get(file), after: after.get(file), config }), config, target }));
  const result = { schemaVersion: 1, pass, batch: batch.id, base: definition.base, auditedAt: new Date().toISOString(), findings,
    summary: Object.fromEntries(AUDIT_CHECKS.map(({ name }) => [name, findings.filter((finding) => finding.check === name).length])),
    reduction: { baseChars: row.baseChars, currentChars: row.currentChars, ratio: row.ratio,
      reductionRate: row.ratio === null ? null : 100 - row.ratio }, reports: measured.reports };
  writeAudit(repoRoot, outputs, result);
  io.stdout(`${batch.id}: 監査の材料を書き出しました\n${outputs.markdown}\n${outputs.json}`);
  return 0;
}
