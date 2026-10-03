import path from 'node:path';
import { lintRepository } from './run.js';
import { formatReport } from './report.js';
import { runLintHook } from './hooks.js';

function parseArgs(argv) {
  const files = [];
  let mode = null;
  let hook = null;
  let repoRoot;
  let configPath;
  const seen = new Set();

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--repo' || argument === '--config') {
      if (seen.has(argument)) throw new Error(argument + ' は 1 つだけ指定できます');
      seen.add(argument);
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
        throw new Error(argument + ' の後に' + (argument === '--repo' ? 'ディレクトリ' : '絶対パス') + 'を指定してください');
      }
      if (argument === '--repo') repoRoot = argv[++index];
      else configPath = argv[++index];
    } else if (argument === '--changed' || argument === '--staged') {
      if (mode !== null) throw new Error('--changed と --staged は同時に指定できません');
      mode = argument.slice(2);
    } else if (argument === '--hook') {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
        throw new Error('--hook の後に post-edit または pre-commit を指定してください');
      }
      if (hook !== null) throw new Error('--hook は 1 つだけ指定できます');
      hook = argv[++index];
      if (hook !== 'post-edit' && hook !== 'pre-commit') {
        throw new Error(`認識できないフックです: ${hook}`);
      }
    } else if (argument.startsWith('--hook=')) {
      if (hook !== null) throw new Error('--hook は 1 つだけ指定できます');
      hook = argument.slice('--hook='.length);
      if (hook !== 'post-edit' && hook !== 'pre-commit') {
        throw new Error(`認識できないフックです: ${hook}`);
      }
    } else if (argument.startsWith('-')) {
      throw new Error(`認識できない引数です: ${argument}`);
    } else {
      files.push(argument);
    }
  }

  if (configPath !== undefined && !path.isAbsolute(configPath) && !path.win32.isAbsolute(configPath)) {
    throw new Error('--config には絶対パスを指定してください');
  }

  if (hook !== null) {
    if (files.length > 0 || mode !== null || repoRoot !== undefined || configPath !== undefined) {
      throw new Error('--hook と手動実行の引数は同時に指定できません');
    }
    return { hook };
  }

  if (mode === null) {
    if (files.length === 0) throw new Error('ファイル、--changed、または --staged を指定してください');
    mode = 'files';
  } else if (files.length > 0) {
    throw new Error(`${mode === 'changed' ? '--changed' : '--staged'} とファイル名は同時に指定できません`);
  }

  return { mode, files, repoRoot, configPath };
}

export function runLintCommand(argv, io) {
  const parsed = parseArgs(argv);
  if (parsed.hook) return runLintHook(parsed.hook, io);
  const result = lintRepository(parsed);
  const report = formatReport(result);
  if (report) io.stdout(report);
  return result.confirmed > 0 ? 1 : 0;
}
