import { lintRepository } from './run.js';
import { formatReport } from './report.js';

function parseArgs(argv) {
  const files = [];
  let mode = null;
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
    } else if (argument === '--hook' || argument.startsWith('--hook=')) {
      throw new Error('--hook はまだ使えません');
    } else if (argument.startsWith('-')) {
      throw new Error(`認識できない引数です: ${argument}`);
    } else {
      files.push(argument);
    }
  }

  if (mode === null) {
    if (files.length === 0) throw new Error('ファイル、--changed、または --staged を指定してください');
    mode = 'files';
  } else if (files.length > 0) {
    throw new Error(`${mode === 'changed' ? '--changed' : '--staged'} とファイル名は同時に指定できません`);
  }

  return { mode, files, repoRoot };
}

export function runLintCommand(argv, { stdout }) {
  const result = lintRepository(parseArgs(argv));
  const report = formatReport(result);
  if (report) stdout(report);
  return result.confirmed > 0 ? 1 : 0;
}
