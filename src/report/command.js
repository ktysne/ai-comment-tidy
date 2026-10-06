import fs from 'node:fs';
import path from 'node:path';
import { selectBatch } from '../batches.js';
import { loadConfig } from '../config.js';
import { batchPaths, ensureManagedPath, validateName } from '../paths.js';
import { createGitSnapshot, repositoryRoot } from '../snapshot/git.js';
import { readState, statusLabel, transitionState, writeState } from '../state.js';
import { writeManagedFile } from '../run/artifacts.js';
import { parseReport } from './run.js';

function parseArgs(argv) {
  const options = { positional: [] };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (['--pass', '--repo', '--config'].includes(argument)) {
      if (seen.has(argument)) throw new Error(`${argument} は1つだけ指定できます`);
      seen.add(argument);
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} の後に値を指定してください`);
      options[{ '--pass': 'pass', '--repo': 'repoRoot', '--config': 'configPath' }[argument]] = value;
    } else if (argument.startsWith('-')) throw new Error(`認識できない引数です: ${argument}`);
    else options.positional.push(argument);
  }
  if (options.positional.length !== 2) throw new Error('束と報告のファイルを1つずつ指定してください');
  options.batch = validateName(options.positional[0], '束');
  options.file = options.positional[1];
  if (options.pass !== undefined) validateName(options.pass, '回');
  if (options.configPath !== undefined && !path.isAbsolute(options.configPath) && !path.win32.isAbsolute(options.configPath)) {
    throw new Error('--config には絶対パスを指定してください');
  }
  return options;
}

export function runReportCommand(argv, io) {
  const options = parseArgs(argv);
  const repoRoot = repositoryRoot(path.resolve(options.repoRoot ?? process.cwd()));
  const config = loadConfig(repoRoot, options.configPath);
  const { definition, batch } = selectBatch(repoRoot, options.batch, options.pass);
  const pass = definition.pass;
  if (!config.passes || !Object.hasOwn(config.passes, pass)) throw new Error(`設定に回がありません: ${pass}`);
  const paths = batchPaths(repoRoot, pass, batch.id);
  ensureManagedPath(repoRoot, paths.state);
  ensureManagedPath(repoRoot, paths.report);
  const state = readState(repoRoot, pass, batch.id);
  if (state?.status !== 'delegated') throw new Error(`報告を取り込めるのは委譲中の束だけです: ${batch.id} (${statusLabel(state)})`);
  const content = fs.readFileSync(path.resolve(options.file));
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); }
  catch (error) { throw new Error('報告を UTF-8 として読めません', { cause: error }); }
  const result = parseReport(text, { batch, baseline: createGitSnapshot(repoRoot, definition.base), runId: state.runId });
  const next = transitionState(state, 'reported', { changes: { report: result.report, notes: [...new Set([...state.notes, ...result.notes])] } });
  writeManagedFile(repoRoot, paths.report, content);
  writeState(repoRoot, pass, batch.id, next);
  io.stdout(`${batch.id}: 報告あり\n報告: ${paths.report}${next.notes.length ? `\n記録: ${next.notes.join('、')}` : ''}`);
  return 0;
}
