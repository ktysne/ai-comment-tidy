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

function fullFileRange(source) {
  return [{ startLine: 1, endLine: Math.max(1, normalizeNewlines(source).split('\n').length) }];
}

function rangesFromStructuredPatch(structuredPatch) {
  return structuredPatch
    .filter((hunk) => isRecord(hunk)
      && Number.isInteger(hunk.newStart) && Number.isInteger(hunk.newLines))
    .map(({ newStart, newLines }) => ({
      startLine: newStart,
      endLine: newLines === 0 ? newStart : newStart + newLines - 1,
    }));
}

function rangesForEdit(source, toolName, toolInput, toolResponse) {
  if (Array.isArray(toolResponse?.structuredPatch)
      && (toolName === 'Edit' || (toolName === 'Write' && toolResponse.type === 'update'))) {
    return rangesFromStructuredPatch(toolResponse.structuredPatch);
  }
  if (toolName === 'Write') return fullFileRange(source);

  const replacement = normalizeNewlines(toolInput.new_string);
  if (replacement.length === 0) return [];

  const normalizedSource = normalizeNewlines(source);
  const ranges = [];
  let index = normalizedSource.indexOf(replacement);
  while (index >= 0) {
    ranges.push(lineRangeAt(normalizedSource, index, replacement.length));
    if (toolInput.replace_all !== true) break;
    index = normalizedSource.indexOf(replacement, index + replacement.length);
  }

  return ranges;
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
  return {
    toolInput: value.tool_input,
    toolName: value.tool_name,
    toolResponse: isRecord(value.tool_response) ? value.tool_response : undefined,
    cwd: value.cwd ?? process.cwd(),
  };
}

function heredocDelimiters(line) {
  const delimiters = [];
  let quote = null;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      else if (character === '\\') index++;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(line[index - 1]))) break;
    if (character !== '<' || line[index + 1] !== '<' || line[index + 2] === '<') continue;

    let cursor = index + 2;
    const stripTabs = line[cursor] === '-';
    if (stripTabs) cursor++;
    while (line[cursor] === ' ' || line[cursor] === '\t') cursor++;
    const delimiterQuote = line[cursor] === '"' || line[cursor] === "'" ? line[cursor++] : null;
    const start = cursor;
    if (delimiterQuote !== null) {
      while (cursor < line.length && line[cursor] !== delimiterQuote) cursor++;
    } else {
      while (cursor < line.length && !/[\s;&|<>]/.test(line[cursor])) cursor++;
    }
    if (cursor > start) delimiters.push({ value: line.slice(start, cursor), stripTabs });
    if (delimiterQuote !== null && line[cursor] === delimiterQuote) cursor++;
    index = cursor - 1;
  }
  return delimiters;
}

function withoutHeredocBodies(command) {
  const lines = command.match(/[^\n]*(?:\n|$)/g) ?? [];
  const output = [];
  let pending = [];
  for (const line of lines) {
    if (line === '') continue;
    const content = (line.endsWith('\n') ? line.slice(0, -1) : line).replace(/\r$/, '');
    if (pending.length > 0) {
      const delimiter = pending[0];
      if ((delimiter.stripTabs ? content.replace(/^\t+/, '') : content) === delimiter.value) pending.shift();
      continue;
    }
    output.push(line);
    pending = heredocDelimiters(content);
  }
  return output.join('');
}

function tokenizeCommands(command) {
  command = withoutHeredocBodies(command);
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
    } else if (character === ';' || character === '&' || character === '|'
        || character === '\n' || character === '(' || character === ')') {
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
  '-C', '-c', '-F', '-m', '--author', '--cleanup', '--date', '--file', '--fixup', '--message', '--pathspec-from-file',
  '--reedit-message', '--reuse-message', '--squash', '--template', '--trailer',
]);

const COMMIT_OPTIONS_WITHOUT_VALUE = new Set([
  '--all', '--allow-empty', '--allow-empty-message', '--amend', '--branch', '--dry-run', '--edit', '--no-edit',
  '--include', '--interactive', '--no-verify', '--only', '--patch', '--porcelain', '--quiet', '--reset-author',
  '--short', '--signoff', '--status', '--no-status', '--verbose', '--no-post-rewrite', '--no-gpg-sign', '--gpg-sign',
]);
const COMMIT_SHORT_OPTIONS = new Set(['a', 'e', 'i', 'n', 'o', 'p', 'q', 's', 'v', 'C', 'c', 'F', 'm', 'S']);

function isEnvironmentAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function commandTokens(tokens) {
  let index = 0;
  while (isEnvironmentAssignment(tokens[index] ?? '')) index++;
  return tokens.slice(index);
}

function displayDirectory(baseDirectory, absoluteDirectory, originalPath) {
  if (path.isAbsolute(originalPath)) return absoluteDirectory;
  return path.relative(baseDirectory, absoluteDirectory) || '.';
}

function parseLocationCommand(rawTokens, baseDirectory, currentDirectory) {
  const tokens = commandTokens(rawTokens);
  const command = tokens[0]?.toLowerCase();
  if (!['cd', 'set-location', 'sl', 'pushd'].includes(command)) return null;

  let target = null;
  for (let index = 1; index < tokens.length; index++) {
    const argument = tokens[index];
    if (argument === '--') {
      target = tokens[index + 1] ?? null;
      break;
    }
    if (['-path', '-literalpath'].includes(argument.toLowerCase())) {
      target = tokens[index + 1] ?? null;
      break;
    }
    if (!argument.startsWith('-')) {
      target = argument;
      break;
    }
  }
  if (target === null || target === '-') return { matched: false };
  const absoluteDirectory = path.resolve(currentDirectory, target);
  return {
    matched: true,
    absoluteDirectory,
    directory: displayDirectory(baseDirectory, absoluteDirectory, target),
  };
}

function parseGitCommand(rawTokens, baseDirectory, currentDirectory) {
  const tokens = commandTokens(rawTokens);
  const executable = tokens[0]?.split(/[\\/]/).at(-1)?.toLowerCase();
  if (executable !== 'git' && executable !== 'git.exe' && executable !== 'git.cmd') return null;

  let absoluteDirectory = currentDirectory;
  let directory = currentDirectory === baseDirectory
    ? null
    : path.relative(baseDirectory, currentDirectory) || '.';
  let index = 1;
  while (index < tokens.length) {
    const option = tokens[index];
    if (option === '--') return null;
    if (GLOBAL_OPTIONS_WITH_VALUE.has(option)) {
      const value = tokens[index + 1];
      if (value === undefined) return null;
      if (option === '-C') {
        absoluteDirectory = path.resolve(absoluteDirectory, value);
        directory = displayDirectory(baseDirectory, absoluteDirectory, value);
      }
      index += 2;
      continue;
    }
    if ((option.startsWith('-C') || option.startsWith('-c')) && option.length > 2) {
      if (option.startsWith('-C')) {
        const value = option.slice(2);
        absoluteDirectory = path.resolve(absoluteDirectory, value);
        directory = displayDirectory(baseDirectory, absoluteDirectory, value);
      }
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
        '--paginate', '--version', '-P', '-p'].includes(option)) return null;
      index++;
      continue;
    }
    return {
      subcommand: option,
      args: tokens.slice(index + 1),
      directory,
      absoluteDirectory,
    };
  }
  return null;
}

function parseCommitArguments(args) {
  const paths = [];
  let all = false;
  let include = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') {
      paths.push(...args.slice(index + 1));
      break;
    }
    const longOption = argument.split('=', 1)[0];
    if (longOption === '--all' && argument === '--all') {
      all = true;
      continue;
    }
    if (argument === '--include') {
      include = true;
      continue;
    }
    if (COMMIT_OPTIONS_WITH_VALUE.has(argument)) {
      if (args[index + 1] === undefined) return null;
      index++;
      continue;
    }
    if (argument.startsWith('--')) {
      if (argument.includes('=') && COMMIT_OPTIONS_WITH_VALUE.has(longOption)) continue;
      if (COMMIT_OPTIONS_WITHOUT_VALUE.has(argument)) continue;
      return null;
    }
    if (argument.startsWith('-')) {
      for (const option of argument.slice(1)) {
        if (!COMMIT_SHORT_OPTIONS.has(option)) return null;
        if (option === 'a') all = true;
        if (option === 'i') include = true;
        if (option === 'S') break;
        if ('CcFm'.includes(option)) {
          if (argument.at(-1) === option) {
            if (args[index + 1] === undefined) return null;
            index++;
          }
          break;
        }
      }
      continue;
    }
    paths.push(argument);
  }
  return { all, include, paths };
}

// フックはシェルが展開する前の文字列を受けるので、ワイルドカードや pathspec の印を含むパスは範囲を推定しない。
function isPatternPath(argument) {
  return argument.startsWith(':') || ['*', '?', '['].some((character) => argument.includes(character));
}

function parseAddArguments(args) {
  const paths = [];
  let all = false;
  let update = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') {
      paths.push(...args.slice(index + 1));
      break;
    }
    if (argument === '-A' || argument === '--all') {
      all = true;
      continue;
    }
    if (argument === '-u' || argument === '--update') {
      update = true;
      continue;
    }
    if (['--dry-run', '--force', '--ignore-errors', '--ignore-missing', '--intent-to-add', '--refresh', '--verbose'].includes(argument)) {
      if (argument === '--intent-to-add') return null;
      continue;
    }
    if (argument.startsWith('-')) return null;
    paths.push(argument);
  }
  if (all && update) return null;
  if (update) return { kind: 'update' };
  if (all || paths.some(isPatternPath)) return { kind: 'all' };
  return paths.length > 0 ? { kind: 'paths', paths } : null;
}

export function detectCommit(command, baseDirectory = process.cwd()) {
  if (typeof command !== 'string' || command.trim() === '') return null;
  const absoluteBaseDirectory = path.resolve(baseDirectory);
  const commands = tokenizeCommands(command);
  let currentDirectory = absoluteBaseDirectory;
  let leading = true;
  const parsed = commands.map((tokens) => {
    if (leading) {
      const location = parseLocationCommand(tokens, absoluteBaseDirectory, currentDirectory);
      if (location?.matched) {
        currentDirectory = location.absoluteDirectory;
        return null;
      }
      if (commandTokens(tokens).length > 0) leading = false;
    }
    return parseGitCommand(tokens, absoluteBaseDirectory, currentDirectory);
  });
  const commitIndex = parsed.findIndex((item) => item?.subcommand === 'commit');
  if (commitIndex < 0) return null;

  const commit = parsed[commitIndex];
  const commitArguments = parseCommitArguments(commit.args);
  const pathsFrom = (paths, directory) => paths.map((file) => path.resolve(directory, file));
  if (commitArguments?.paths.some(isPatternPath)) {
    return { directory: commit.directory, mode: 'changed', includeUntracked: false };
  }
  if (commitArguments?.paths.length > 0) {
    return {
      directory: commit.directory,
      mode: commitArguments.include ? 'staged-with-worktree' : 'changed',
      paths: pathsFrom(commitArguments.paths, commit.absoluteDirectory),
      includeUntracked: false,
    };
  }
  if (commitArguments?.all) return { directory: commit.directory, mode: 'changed', includeUntracked: false };

  const additions = parsed.slice(0, commitIndex).filter((item) => item?.subcommand === 'add');
  if (additions.length === 0) return { directory: commit.directory, mode: 'staged' };
  const parsedAdditions = additions.map((addition) => ({
    addition,
    selection: parseAddArguments(addition.args),
  }));
  if (parsedAdditions.some(({ selection }) => selection === null)) {
    return { directory: commit.directory, mode: 'staged' };
  }
  if (parsedAdditions.some(({ selection }) => selection.kind === 'all')) {
    return { directory: commit.directory, mode: 'changed' };
  }
  if (parsedAdditions.some(({ selection }) => selection.kind === 'update')) {
    return { directory: commit.directory, mode: 'changed', includeUntracked: false };
  }
  const files = parsedAdditions.flatMap(({ addition, selection }) => (
    pathsFrom(selection.paths, addition.absoluteDirectory)
  ));
  return {
    directory: commit.directory,
    mode: 'staged-with-worktree',
    paths: [...new Set(files)],
  };
}

function realPathOrSelf(absolutePath) {
  try {
    return fs.realpathSync.native(absolutePath);
  } catch {
    return absolutePath;
  }
}

function physicalPath(absolutePath) {
  let existingPath = path.resolve(absolutePath);
  const remainingParts = [];
  while (!fs.existsSync(existingPath)) {
    const parent = path.dirname(existingPath);
    if (parent === existingPath) break;
    remainingParts.unshift(path.basename(existingPath));
    existingPath = parent;
  }
  return path.join(realPathOrSelf(existingPath), ...remainingParts);
}

function pathspecsFromPaths(paths, repoRoot) {
  const realRoot = realPathOrSelf(path.resolve(repoRoot));
  const pathspecs = [];
  for (const absolutePath of paths) {
    const physical = physicalPath(absolutePath);
    const relative = path.relative(realRoot, physical);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    pathspecs.push(relative === '' ? '.' : relative.split(path.sep).join('/'));
  }
  return [...new Set(pathspecs)];
}

function runPostEdit({ toolInput, toolName, toolResponse, cwd }, deps) {
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
  const report = formatReport(filterResult(result, rangesForEdit(source, toolName, toolInput, toolResponse)));
  if (!report) return 0;
  deps.stderr(`${POST_EDIT_PREFIX}\n${report}`);
  return 2;
}

function runPreCommit({ toolInput, cwd }, deps) {
  if (typeof toolInput.command !== 'string') return 0;
  const commit = detectCommit(toolInput.command, cwd);
  if (!commit) return 0;
  const directory = commit.directory === null ? cwd : path.resolve(cwd, commit.directory);
  const repoRoot = repositoryRootOrNull(directory, deps.repositoryRootOf);
  if (repoRoot === null) return 0;

  let mode = commit.mode;
  let pathspecs;
  if (commit.paths) {
    pathspecs = pathspecsFromPaths(commit.paths, repoRoot);
    if (pathspecs === null) {
      mode = 'staged';
    } else if (mode === 'staged-with-worktree' && pathspecs.includes('.')) {
      mode = 'changed';
    }
  }
  const result = deps.lintRepository({
    repoRoot,
    mode,
    ...(pathspecs && mode !== 'staged' ? { pathspecs } : {}),
    ...(commit.includeUntracked === false ? { includeUntracked: false } : {}),
  });
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
