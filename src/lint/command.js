import { lintRepository } from './run.js';
import { formatReport } from './report.js';
import { runLintHook } from './hooks.js';

function parseArgs(argv) {
  const files = [];
  let mode = null;
  let hook = null;
  let repoRoot;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--repo') {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
        throw new Error('--repo の後にディレクトリを指定してください');
      }
      repoRoot = argv[++index];
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

  if (hook !== null) {
    if (files.length > 0 || mode !== null || repoRoot !== undefined) {
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

  return { mode, files, repoRoot };
}

export function runLintCommand(argv, io) {
  const parsed = parseArgs(argv);
  if (parsed.hook) return runLintHook(parsed.hook, io);
  const result = lintRepository(parsed);
  const report = formatReport(result);
  if (report) io.stdout(report);
  return result.confirmed > 0 ? 1 : 0;
}
