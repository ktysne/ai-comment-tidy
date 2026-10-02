import fs from 'node:fs';
import path from 'node:path';

import { languageOf } from '../lex/index.js';
import { filterToRanges } from './new-violations.js';
import { formatReport } from './report.js';
import { lintRepository, repositoryRootOf } from './run.js';

const POST_EDIT_PREFIX = 'comment-tidy: いま書いたコメントが、コメント記述ルールから外れています。';
const PRE_COMMIT_PREFIX = 'comment-tidy: コミットに含まれるコメントに、確定の違反があります。直してからコミットしてください。';
const PRE_COMMIT_REVIEW_PREFIX = 'comment-tidy: コミットに含まれるコメントに、見直し候補があります。';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n');
}

function lineRangeAt(source, start, length) {
  const startLine = source.slice(0, start).split('\n').length;
  const end = start + length;
  let endLine = source.slice(0, end).split('\n').length;
  if (source[end - 1] === '\n') endLine--;
  return { startLine, endLine: Math.max(startLine, endLine) };
}

function rangesForEdit(source, toolName, toolInput) {
  if (toolName === 'Write') {
    return [{ startLine: 1, endLine: Math.max(1, normalizeNewlines(source).split('\n').length) }];
  }

  const replacement = normalizeNewlines(toolInput.new_string);
  if (replacement.length === 0) {
    return [{ startLine: 1, endLine: Math.max(1, normalizeNewlines(source).split('\n').length) }];
  }

  const normalizedSource = normalizeNewlines(source);
  const ranges = [];
  let index = normalizedSource.indexOf(replacement);
  while (index >= 0) {
    ranges.push(lineRangeAt(normalizedSource, index, replacement.length));
    if (toolInput.replace_all !== true) break;
    index = normalizedSource.indexOf(replacement, index + replacement.length);
  }

  return ranges.length > 0
    ? ranges
    : [{ startLine: 1, endLine: Math.max(1, normalizedSource.split('\n').length) }];
}

function filterResult(result, ranges) {
  const files = result.files
    .map(({ path: filePath, violations }) => ({ path: filePath, violations: filterToRanges(violations, ranges) }))
    .filter(({ violations }) => violations.length > 0);
  const violations = files.flatMap(({ violations: fileViolations }) => fileViolations);
  return {
    files,
    confirmed: violations.filter(({ severity }) => severity === 'confirmed').length,
    review: violations.filter(({ severity }) => severity === 'review').length,
  };
}

function readHookInput(raw) {
  if (raw.trim() === '') return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('標準入力の JSON を読めません');
  }
  return isRecord(value) ? value : null;
}

function isOutsideRepository(error) {
  const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : String(error?.stderr ?? '');
  return error?.status === 128 && /not a git repository/i.test(stderr);
}

function repositoryRootOrNull(directory, findRoot) {
  try {
    return findRoot(directory);
  } catch (error) {
    if (isOutsideRepository(error)) return null;
    throw error;
  }
}

function oneLine(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim() || '原因不明のエラー';
}

function errorResult(stderr, error) {
  stderr(`comment-tidy: フック検査に失敗しました: ${oneLine(error)}`);
  return 0;
}

function validHookInput(value, eventName, toolNames) {
  if (!value || value.hook_event_name !== eventName || !toolNames.includes(value.tool_name)) return null;
  if (!isRecord(value.tool_input)) return null;
  if (value.cwd !== undefined && typeof value.cwd !== 'string') return null;
  return { toolInput: value.tool_input, toolName: value.tool_name, cwd: value.cwd ?? process.cwd() };
}

function tokenizeCommands(command) {
  const commands = [];
  let tokens = [];
  let token = '';
  let tokenStarted = false;
  let quote = null;

  const pushToken = () => {
    if (tokenStarted) tokens.push(token);
    token = '';
    tokenStarted = false;
  };
  const pushCommand = () => {
    pushToken();
    if (tokens.length > 0) commands.push(tokens);
    tokens = [];
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    const next = command[index + 1];
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else if (character === '\\' && next !== undefined
          && (quote === '"' ? ['"', '\\', '$', '`', '\n'].includes(next) : false)) {
        token += next;
        tokenStarted = true;
        index++;
      } else {
        token += character;
        tokenStarted = true;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
    } else if (character === '\\' && next !== undefined && /[\s\\"';&|]/.test(next)) {
      token += next;
      tokenStarted = true;
      index++;
    } else if (character === ';' || character === '&' || character === '|' || character === '\n') {
      pushCommand();
      if ((character === '&' || character === '|') && next === character) index++;
    } else if (/\s/.test(character)) {
      pushToken();
    } else {
      token += character;
      tokenStarted = true;
    }
  }
  pushCommand();
  return commands;
}

const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C', '-c', '--config-env', '--exec-path', '--git-dir', '--namespace', '--super-prefix', '--work-tree',
]);
const COMMIT_OPTIONS_WITH_VALUE = new Set([
  '-C', '-c', '-F', '-m', '--file', '--fixup', '--message', '--reedit-message', '--reuse-message', '--squash',
]);

function parseGitCommand(tokens) {
  const executable = tokens[0]?.split(/[\\/]/).at(-1)?.toLowerCase();
  if (executable !== 'git' && executable !== 'git.exe' && executable !== 'git.cmd') return null;

  let directory = null;
  let index = 1;
  while (index < tokens.length) {
    const option = tokens[index];
    if (option === '--') return null;
    if (GLOBAL_OPTIONS_WITH_VALUE.has(option)) {
      const value = tokens[index + 1];
      if (value === undefined) return null;
      if (option === '-C') directory = value;
      index += 2;
      continue;
    }
    if ((option.startsWith('-C') || option.startsWith('-c')) && option.length > 2) {
      if (option.startsWith('-C')) directory = option.slice(2);
      index++;
      continue;
    }
    if (option.startsWith('--config-env=') || option.startsWith('--exec-path=')
        || option.startsWith('--git-dir=') || option.startsWith('--namespace=')
        || option.startsWith('--super-prefix=') || option.startsWith('--work-tree=')) {
      index++;
      continue;
    }
    if (option.startsWith('-')) {
      if (!['--bare', '--glob-pathspecs', '--help', '--icase-pathspecs', '--literal-pathspecs', '--no-advice',
        '--no-lazy-fetch', '--no-optional-locks', '--no-pager', '--no-replace-objects', '--noglob-pathspecs',
        '--paginate', '--version', '-p'].includes(option)) return null;
      index++;
      continue;
    }
    return { subcommand: option, args: tokens.slice(index + 1), directory };
  }
  return null;
}

function commitUsesAll(args) {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') break;
    if (argument === '--all') return true;
    if (COMMIT_OPTIONS_WITH_VALUE.has(argument)) {
      index++;
      continue;
    }
    if (argument.startsWith('--')) continue;
    if (argument.startsWith('-')) {
      for (const option of argument.slice(1)) {
        if (option === 'a') return true;
        if ('CcFfm'.includes(option)) break;
      }
    }
  }
  return false;
}

export function detectCommit(command) {
  if (typeof command !== 'string' || command.trim() === '') return null;
  const commands = tokenizeCommands(command);
  const parsed = commands.map(parseGitCommand);
  const commitIndex = parsed.findIndex((item) => item?.subcommand === 'commit');
  if (commitIndex < 0) return null;

  let directory = null;
  for (const tokens of commands) {
    if (tokens[0] === 'cd' && typeof tokens[1] === 'string') {
      directory = tokens[1];
    } else {
      break;
    }
  }
  const commit = parsed[commitIndex];
  const stagesChanges = parsed.slice(0, commitIndex).some((item) => item?.subcommand === 'add');
  return {
    directory: commit.directory ?? directory,
    mode: stagesChanges || commitUsesAll(commit.args) ? 'changed' : 'staged',
  };
}

function runPostEdit({ toolInput, toolName, cwd }, deps) {
  const filePath = toolInput.file_path;
  if (typeof filePath !== 'string') return 0;
  if (toolName === 'Edit'
      && (typeof toolInput.new_string !== 'string'
        || (toolInput.replace_all !== undefined && typeof toolInput.replace_all !== 'boolean'))) return 0;
  if (toolName === 'Write' && typeof toolInput.content !== 'string') return 0;

  const absolutePath = path.resolve(cwd, filePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile() || !languageOf(absolutePath)) return 0;
  const repoRoot = repositoryRootOrNull(path.dirname(absolutePath), deps.repositoryRootOf);
  if (repoRoot === null) return 0;

  const source = fs.readFileSync(absolutePath, 'utf8');
  const result = deps.lintRepository({
    repoRoot,
    mode: 'files',
    files: [absolutePath],
    baseDirectory: cwd,
  });
  const report = formatReport(filterResult(result, rangesForEdit(source, toolName, toolInput)));
  if (!report) return 0;
  deps.stderr(`${POST_EDIT_PREFIX}\n${report}`);
  return 2;
}

function runPreCommit({ toolInput, cwd }, deps) {
  if (typeof toolInput.command !== 'string') return 0;
  const commit = detectCommit(toolInput.command);
  if (!commit) return 0;
  const directory = commit.directory === null ? cwd : path.resolve(cwd, commit.directory);
  const repoRoot = repositoryRootOrNull(directory, deps.repositoryRootOf);
  if (repoRoot === null) return 0;

  const result = deps.lintRepository({ repoRoot, mode: commit.mode });
  const report = formatReport(result);
  if (!report) return 0;
  if (result.confirmed > 0) {
    deps.stderr(`${PRE_COMMIT_PREFIX}\n${report}`);
    return 2;
  }
  if (result.review > 0) {
    deps.stdout(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `${PRE_COMMIT_REVIEW_PREFIX}\n${report}`,
      },
    }));
  }
  return 0;
}

export async function runLintHook(hook, io) {
  const deps = {
    ...io,
    lintRepository: io.lintRepository ?? lintRepository,
    repositoryRootOf: io.repositoryRootOf ?? repositoryRootOf,
  };
  try {
    const value = readHookInput(await deps.readStdin());
    if (!value) return 0;
    if (hook === 'post-edit') {
      const input = validHookInput(value, 'PostToolUse', ['Edit', 'Write']);
      return input ? runPostEdit(input, deps) : 0;
    }
    if (hook === 'pre-commit') {
      const input = validHookInput(value, 'PreToolUse', ['Bash', 'PowerShell']);
      return input ? runPreCommit(input, deps) : 0;
    }
    return 0;
  } catch (error) {
    return errorResult(deps.stderr, error);
  }
}
