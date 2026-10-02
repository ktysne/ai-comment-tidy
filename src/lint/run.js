import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { languageOf } from '../lex/index.js';
import { loadLintConfig } from './config.js';
import { newViolations } from './new-violations.js';
import { findViolations } from './rules.js';

const MAX_GIT_BUFFER = 1 << 30;

function git(repoRoot, args) {
  // 標準エラーを親へ流さない。失敗を 1 行で返す呼び出し側の出力に、別の行が混ざるためである。
  return execFileSync('git', ['-C', repoRoot, '--literal-pathspecs', ...args], {
    maxBuffer: MAX_GIT_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 指定のフォルダーを含むリポジトリのルートを返す。リポジトリの外なら例外を投げる。 */
export function repositoryRootOf(directory) {
  return path.resolve(gitText(directory, ['rev-parse', '--show-toplevel']));
}

function gitText(repoRoot, args) {
  return git(repoRoot, args).toString('utf8').trim();
}

function gitPaths(repoRoot, args) {
  return git(repoRoot, args).toString('utf8').split('\0').filter(Boolean);
}

function gitAllowingStatus(repoRoot, args, allowedStatus) {
  try {
    return git(repoRoot, args);
  } catch (error) {
    if (allowedStatus.includes(error.status)) return null;
    throw error;
  }
}

function validateRepositoryRoot(repoRoot) {
  const topLevel = path.resolve(gitText(repoRoot, ['rev-parse', '--show-toplevel']));
  const normalizedRoot = path.resolve(repoRoot);
  const sameRoot = process.platform === 'win32'
    ? topLevel.toLowerCase() === normalizedRoot.toLowerCase()
    : topLevel === normalizedRoot;
  if (!sameRoot) throw new Error(`--repo は Git リポジトリのルートを指定してください: ${repoRoot}`);
}

function hasHead(repoRoot) {
  return gitAllowingStatus(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], [1]) !== null;
}

function realPathOrSelf(directory) {
  try {
    return fs.realpathSync.native(directory);
  } catch {
    return directory;
  }
}

function normalizeFilePath(repoRoot, input, baseDirectory) {
  const resolvedPath = path.resolve(path.isAbsolute(input) ? input : path.join(baseDirectory, input));
  // ルートは実体のパスで得られる。ジャンクションを経由したパスのままだと、リポジトリの外と誤る。
  const absolutePath = path.join(realPathOrSelf(path.dirname(resolvedPath)), path.basename(resolvedPath));
  const relativePath = path.relative(realPathOrSelf(repoRoot), absolutePath);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`ファイルはリポジトリの中を指定してください: ${input}`);
  }
  return relativePath.split(path.sep).join('/');
}

function globSource(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === '*' && next === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index++;
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else if (character === '{') {
      const close = pattern.indexOf('}', index + 1);
      if (close >= 0 && pattern.slice(index + 1, close).includes(',')) {
        const alternatives = pattern.slice(index + 1, close).split(',');
        source += `(?:${alternatives.map(globSource).join('|')})`;
        index = close;
      } else {
        source += '\\{';
      }
    } else if (character === '}') {
      source += '\\}';
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return source;
}

function matchesGlob(relativePath, pattern) {
  const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '').replace(/\/$/, '');
  const hasSlash = normalizedPattern.includes('/');
  const source = globSource(normalizedPattern);
  // パターンがフォルダーに当たるときは、その下のファイルにも当てる(.gitignore と同じ感覚で書けるように)。
  const expression = hasSlash
    ? new RegExp(`^${source}(?:/.*)?$`)
    : new RegExp(`(?:^|/)${source}(?:/|$)`);
  return expression.test(relativePath);
}

function isExcluded(relativePath, patterns) {
  return patterns.some((pattern) => matchesGlob(relativePath, pattern));
}

function isIgnored(repoRoot, relativePath) {
  try {
    // check-ignore は --literal-pathspecs を受け付けず失敗する。引数はもともとパス名として扱われる。
    execFileSync('git', ['-C', repoRoot, 'check-ignore', '--quiet', '--', relativePath], { stdio: 'ignore' });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${label} を UTF-8 として読めません`);
  }
}

function worktreeSource(repoRoot, relativePath) {
  return decodeUtf8(fs.readFileSync(path.join(repoRoot, ...relativePath.split('/'))), relativePath);
}

function headPaths(repoRoot, headExists) {
  if (!headExists) return new Set();
  return new Set(gitPaths(repoRoot, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']));
}

function headSource(repoRoot, relativePath, baselinePaths) {
  if (!baselinePaths.has(relativePath)) return '';
  return decodeUtf8(git(repoRoot, ['show', `HEAD:${relativePath}`]), `HEAD:${relativePath}`);
}

function indexSource(repoRoot, relativePath) {
  const entries = gitPaths(repoRoot, ['ls-files', '--stage', '-z', '--', relativePath]);
  if (entries.length === 0) throw new Error(`インデックスにファイルがありません: ${relativePath}`);
  if (entries.length !== 1) throw new Error(`競合中のファイルは検査できません: ${relativePath}`);
  const separator = entries[0].indexOf('\t');
  const [mode, objectId] = entries[0].slice(0, separator).split(' ');
  if (!mode || !objectId) throw new Error(`インデックスの内容を読めません: ${relativePath}`);
  return decodeUtf8(git(repoRoot, ['cat-file', 'blob', objectId]), `インデックス:${relativePath}`);
}

const DIFF_FILTER = '--diff-filter=ACMRTUXB';

/**
 * `diff --name-status -z` の出力を、今のパスと比べる元のパスの組にする。
 * 名前の変更と写しでは、比べる元を変更前のパスにする(新しい名前のまま比べると、既存の違反が全部新しく見える)。
 */
function parseNameStatus(fields) {
  const entries = [];
  for (let index = 0; index < fields.length; index++) {
    const status = fields[index];
    if (status.startsWith('R') || status.startsWith('C')) {
      entries.push({ path: fields[index + 2], basePath: fields[index + 1] });
      index += 2;
    } else {
      entries.push({ path: fields[index + 1], basePath: fields[index + 1] });
      index += 1;
    }
  }
  return entries;
}

function samePathEntries(paths) {
  return paths.map((filePath) => ({ path: filePath, basePath: filePath }));
}

function changedEntries(repoRoot, headExists, includeUntracked, pathspecs = []) {
  const pathArguments = ['--', ...pathspecs];
  const untracked = includeUntracked
    ? samePathEntries(gitPaths(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', ...pathArguments]))
    : [];
  if (headExists) {
    return [
      ...parseNameStatus(gitPaths(repoRoot, ['diff', '--name-status', '-z', '-M', DIFF_FILTER, 'HEAD', ...pathArguments])),
      ...untracked,
    ];
  }
  return [
    ...samePathEntries(gitPaths(repoRoot, ['diff', '--cached', '--name-only', '-z', DIFF_FILTER, ...pathArguments])),
    ...samePathEntries(gitPaths(repoRoot, ['diff', '--name-only', '-z', DIFF_FILTER, ...pathArguments])),
    ...untracked,
  ];
}

function stagedEntries(repoRoot, headExists, pathspecs = []) {
  const pathArguments = ['--', ...pathspecs];
  if (!headExists) {
    return samePathEntries(gitPaths(repoRoot, ['diff', '--cached', '--name-only', '-z', DIFF_FILTER, ...pathArguments]));
  }
  return parseNameStatus(gitPaths(repoRoot, ['diff', '--cached', '--name-status', '-z', '-M', DIFF_FILTER, 'HEAD', ...pathArguments]));
}

function pathMatchesPathspec(relativePath, pathspec) {
  const normalized = pathspec.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized === '' || normalized === '.' || relativePath === normalized
    || relativePath.startsWith(`${normalized}/`);
}

function stagedWithWorktreeEntries(repoRoot, headExists, includeUntracked, pathspecs) {
  const worktreeEntries = changedEntries(repoRoot, headExists, includeUntracked, pathspecs)
    .map((entry) => ({ ...entry, source: 'worktree' }));
  const worktreePaths = new Set(worktreeEntries.map(({ path: filePath }) => filePath));
  const indexEntries = stagedEntries(repoRoot, headExists)
    .filter(({ path: filePath }) => !pathspecs.some((pathspec) => pathMatchesPathspec(filePath, pathspec)))
    .filter(({ path: filePath }) => !worktreePaths.has(filePath))
    .map((entry) => ({ ...entry, source: 'index' }));
  return [...worktreeEntries, ...indexEntries];
}

function fileEntries(repoRoot, mode, files, headExists, baseDirectory, includeUntracked, pathspecs) {
  if (mode === 'files') {
    if (!Array.isArray(files) || files.length === 0) throw new Error('lint するファイルを指定してください');
    const entries = [];
    for (const file of files) {
      const relativePath = normalizeFilePath(repoRoot, file, baseDirectory);
      entries.push({ path: relativePath, basePath: relativePath });
    }
    const unique = new Map();
    for (const entry of entries) if (!unique.has(entry.path)) unique.set(entry.path, entry);
    return [...unique.values()];
  }
  if (mode === 'changed') return changedEntries(repoRoot, headExists, includeUntracked, pathspecs);
  if (mode === 'staged') return stagedEntries(repoRoot, headExists, pathspecs);
  if (mode === 'staged-with-worktree') {
    return stagedWithWorktreeEntries(repoRoot, headExists, includeUntracked, pathspecs);
  }
  throw new Error(`lint の実行モードが不正です: ${mode}`);
}

/**
 * 作業ツリーから消えたファイルの違反を集める。
 * ステージしていない名前の変更は「削除と未追跡の追加」に見えるので、新しいファイルの比べる元にこれを使う。
 */
function deletedFileViolations(repoRoot, baselinePaths, options, pathspecs) {
  const deleted = gitPaths(repoRoot, ['diff', '--name-only', '-z', '--diff-filter=D', 'HEAD', '--', ...pathspecs]);
  return deleted
    .filter((deletedPath) => languageOf(deletedPath))
    .flatMap((deletedPath) => findViolations(deletedPath, headSource(repoRoot, deletedPath, baselinePaths), options));
}

function emptyResult() {
  return { files: [], confirmed: 0, review: 0 };
}

/**
 * @param {string} [options.repoRoot] 省くと、カレントディレクトリを含むリポジトリのルートを使う
 * @param {string} [options.baseDirectory] 相対パスのファイル名を解決する基準。既定は、repoRoot を渡したときはそのルート、省いたときはカレントディレクトリ
 * @param {boolean} [options.includeUntracked=true] `changed` と `staged-with-worktree` の作業ツリー範囲で未追跡ファイルを含めるか
 * @param {string[]} [options.pathspecs=[]] 変更一覧を絞るリポジトリルートからのリテラルパス
 */
export function lintRepository({ repoRoot, mode, files = [], baseDirectory, includeUntracked = true, pathspecs = [] }) {
  const root = repoRoot === undefined ? repositoryRootOf(baseDirectory ?? process.cwd()) : path.resolve(repoRoot);
  const fileBase = baseDirectory ?? (repoRoot === undefined ? process.cwd() : root);
  const config = loadLintConfig(root);
  if (!config.lint.enabled) return emptyResult();

  validateRepositoryRoot(root);
  const headExists = hasHead(root);
  const baselinePaths = headPaths(root, headExists);
  const basePathOf = new Map();
  for (const entry of fileEntries(root, mode, files, headExists, fileBase, includeUntracked, pathspecs)) {
    if (!basePathOf.has(entry.path)) basePathOf.set(entry.path, entry);
  }
  const paths = [...basePathOf.keys()].sort();
  const results = [];
  let confirmed = 0;
  let review = 0;
  const options = {
    maxCommentLines: config.maxCommentLines,
    licensePatterns: config.licensePatterns,
    allow: config.lint.allow,
  };
  let movedBaseline = null;

  for (const relativePath of paths) {
    if (!languageOf(relativePath) || isExcluded(relativePath, config.scope.exclude)) continue;
    if (mode === 'files' && isIgnored(root, relativePath)) continue;
    const absolutePath = path.join(root, ...relativePath.split('/'));
    const entry = basePathOf.get(relativePath);
    if (mode !== 'staged' && entry.source !== 'index') {
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
    }

    const currentSource = mode === 'staged' || entry.source === 'index'
      ? indexSource(root, relativePath)
      : worktreeSource(root, relativePath);
    const basePath = entry.basePath;
    const currentViolations = findViolations(relativePath, currentSource, options);
    let baselineViolations;
    if ((mode === 'changed' || entry.source === 'worktree') && headExists && !baselinePaths.has(basePath)) {
      movedBaseline ??= deletedFileViolations(root, baselinePaths, options, pathspecs);
      baselineViolations = movedBaseline;
    } else {
      baselineViolations = findViolations(relativePath, headSource(root, basePath, baselinePaths), options);
    }
    const violations = newViolations(currentViolations, baselineViolations);
    if (violations.length === 0) continue;
    for (const violation of violations) {
      if (violation.severity === 'confirmed') confirmed++;
      else review++;
    }
    results.push({ path: relativePath, violations });
  }

  return { files: results, confirmed, review };
}
