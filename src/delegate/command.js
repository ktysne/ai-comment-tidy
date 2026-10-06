import path from 'node:path';
import { selectBatch } from '../batches.js';
import { loadConfig } from '../config.js';
import { batchPaths, ensureManagedPath, validateName } from '../paths.js';
import { repositoryRoot } from '../snapshot/git.js';
import { readState, statusLabel, transitionState, updateState, writeState } from '../state.js';

function parseArgs(argv) {
  const options = { cancel: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (['--pass', '--repo', '--config', '--run-id', '--cancel'].includes(argument)) {
      if (seen.has(argument)) throw new Error(`${argument} は1つだけ指定できます`);
      seen.add(argument);
      if (argument === '--cancel') options.cancel = true;
      else {
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${argument} の後に値を指定してください`);
        options[{ '--pass': 'pass', '--repo': 'repoRoot', '--config': 'configPath', '--run-id': 'runId' }[argument]] = value;
      }
    } else if (argument.startsWith('-')) throw new Error(`認識できない引数です: ${argument}`);
    else if (options.batch === undefined) options.batch = argument;
    else throw new Error('束は1つだけ指定してください');
  }
  validateName(options.batch, '束');
  if (options.pass !== undefined) validateName(options.pass, '回');
  if (options.configPath !== undefined && !path.isAbsolute(options.configPath) && !path.win32.isAbsolute(options.configPath)) {
    throw new Error('--config には絶対パスを指定してください');
  }
  if (options.cancel && options.runId !== undefined) throw new Error('--cancel と --run-id は同時に指定できません');
  if (options.runId !== undefined && (/\s/u.test(options.runId)
    || [...options.runId].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127))) {
    throw new Error('実行 ID に空白や制御文字は使えません');
  }
  return options;
}

export function runDelegateCommand(argv, io) {
  const options = parseArgs(argv);
  const repoRoot = repositoryRoot(path.resolve(options.repoRoot ?? process.cwd()));
  const config = loadConfig(repoRoot, options.configPath);
  const { definition, batch } = selectBatch(repoRoot, options.batch, options.pass);
  const pass = definition.pass;
  if (!config.passes || !Object.hasOwn(config.passes, pass)) throw new Error(`設定に回がありません: ${pass}`);
  ensureManagedPath(repoRoot, batchPaths(repoRoot, pass, batch.id).state);
  const state = readState(repoRoot, pass, batch.id);
  let next;
  if (options.cancel) {
    if (state?.status !== 'delegated') throw new Error(`取消できるのは委譲中の束だけです: ${batch.id} (${statusLabel(state)})`);
    next = transitionState(state, 'prepared');
  } else if (state?.status === 'prepared') {
    next = transitionState(state, 'delegated', { changes: { runId: options.runId ?? null } });
  } else if (state?.status === 'delegated' && options.runId !== undefined) {
    if (state.runId !== null && state.runId !== options.runId) throw new Error('委譲中の実行 ID を別の ID に置き換えることはできません');
    next = updateState(state, { runId: options.runId });
  } else throw new Error(`委譲できるのは用意済みの束だけです。委譲中は --run-id で ID を記録してください: ${batch.id} (${statusLabel(state)})`);
  writeState(repoRoot, pass, batch.id, next);
  io.stdout(`${batch.id}: ${statusLabel(next)}${next.status === 'delegated' ? `\n実行 ID: ${next.runId ?? '未記録'}` : ''}`);
  return 0;
}
