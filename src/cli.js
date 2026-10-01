import { runLintCommand } from './lint/command.js';

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
    return await command(rest, { stdout, stderr });
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
    stderr(`コマンドの実行に失敗しました: ${detail || '原因不明のエラー'}`);
    return EXIT_USAGE;
  }
}

commands.set('lint', runLintCommand);
