import { runInstallHooksCommand } from './install-hooks.js';

/** 終了コードの意味は docs/design.md「コマンド」が正本。 */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

const commands = new Map();

function usage() {
  const names = [...commands.keys()];
  return [
    '使い方: comment-tidy <コマンド> [引数...]',
    '',
    names.length ? `コマンド: ${names.join('、')}` : 'コマンドは、まだありません。',
  ].join('\n');
}

/**
 * @param {string[]} argv コマンド名から始まる引数
 * @param {{ stdout?: (text: string) => void, stderr?: (text: string) => void }} io 出力の差し替え口
 * @returns {Promise<number>} 終了コード
 */
export async function run(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const stderr = io.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  const readStdin = io.readStdin ?? readProcessStdin;
  const [name, ...rest] = argv;

  if (name === undefined || name === 'help' || name === '--help') {
    stdout(usage());
    return EXIT_OK;
  }

  const command = commands.get(name);
  if (!command) {
    stderr(`コマンドが見つかりません: ${name}\n\n${usage()}`);
    return EXIT_USAGE;
  }
  try {
    return await command(rest, { stdout, stderr, readStdin });
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
    stderr(`コマンドの実行に失敗しました: ${detail || '原因不明のエラー'}`);
    return EXIT_USAGE;
  }
}

async function readProcessStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

commands.set('lint', async (...args) => (await import('./lint/command.js')).runLintCommand(...args));
commands.set('stats', async (...args) => (await import('./stats/command.js')).runStatsCommand(...args));
commands.set('check', async (...args) => (await import('./check/command.js')).runCheckCommand(...args));
commands.set('init', async (...args) => (await import('./init/command.js')).runInitCommand(...args));
commands.set('plan', async (...args) => (await import('./plan/command.js')).runPlanCommand(...args));
commands.set('prompt', async (...args) => (await import('./prompt/command.js')).runPromptCommand(...args));
commands.set('status', async (...args) => (await import('./status/command.js')).runStatusCommand(...args));
commands.set('run', async (...args) => (await import('./run/command.js')).runRunCommand(...args));
commands.set('delegate', async (...args) => (await import('./delegate/command.js')).runDelegateCommand(...args));
commands.set('report', async (...args) => (await import('./report/command.js')).runReportCommand(...args));
commands.set('install-hooks', runInstallHooksCommand);
