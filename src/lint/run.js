import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { languageOf } from '../lex/index.js';
import { loadLintConfig } from './config.js';
import { newViolations } from './new-violations.js';
import { findViolations } from './rules.js';

const MAX_GIT_BUFFER = 1 << 30;

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, '--literal-pathspecs', ...args], {
    maxBuffer: MAX_GIT_BUFFER,
  });
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

function normalizeFilePath(repoRoot, input) {
  const absolutePath = path.resolve(path.isAbsolute(input) ? input : path.join(repoRoot, input));
  const relativePath = path.relative(repoRoot, absolutePath);
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
  const hasWildcard = /[*?{]/.test(normalizedPattern);
  const source = globSource(normalizedPattern);
  const expression = hasSlash
    ? new RegExp(`^${source}${hasWildcard ? '' : '(?:/.*)?'}$`)
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

function changedPaths(repoRoot, headExists) {
  const diffFilter = '--diff-filter=ACMRTUXB';
  if (headExists) {
    return [
      ...gitPaths(repoRoot, ['diff', '--name-only', '-z', diffFilter, 'HEAD', '--']),
      ...gitPaths(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
    ];
  }
  return [
    ...gitPaths(repoRoot, ['diff', '--cached', '--name-only', '-z', diffFilter, '--']),
    ...gitPaths(repoRoot, ['diff', '--name-only', '-z', diffFilter, '--']),
    ...gitPaths(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  ];
}

function stagedPaths(repoRoot, headExists) {
  const diffFilter = '--diff-filter=ACMRTUXB';
  const args = ['diff', '--cached', '--name-only', '-z', diffFilter];
  if (headExists) args.push('HEAD');
  args.push('--');
  return gitPaths(repoRoot, args);
}

function filePaths(repoRoot, mode, files, headExists) {
  if (mode === 'files') {
    if (!Array.isArray(files) || files.length === 0) throw new Error('lint するファイルを指定してください');
    return files.map((file) => normalizeFilePath(repoRoot, file));
  }
  if (mode === 'changed') return changedPaths(repoRoot, headExists);
  if (mode === 'staged') return stagedPaths(repoRoot, headExists);
  throw new Error(`lint の実行モードが不正です: ${mode}`);
}

function emptyResult() {
  return { files: [], confirmed: 0, review: 0 };
}

export function lintRepository({ repoRoot = process.cwd(), mode, files = [] }) {
  const root = path.resolve(repoRoot);
  const config = loadLintConfig(root);
  if (!config.lint.enabled) return emptyResult();

  validateRepositoryRoot(root);
  const headExists = hasHead(root);
  const baselinePaths = headPaths(root, headExists);
  const paths = [...new Set(filePaths(root, mode, files, headExists))].sort();
  const results = [];
  let confirmed = 0;
  let review = 0;

  for (const relativePath of paths) {
    if (!languageOf(relativePath) || isExcluded(relativePath, config.scope.exclude)) continue;
    if (mode === 'files' && isIgnored(root, relativePath)) continue;
    const absolutePath = path.join(root, ...relativePath.split('/'));
    if (mode !== 'staged') {
      if (mode === 'changed' && !fs.existsSync(absolutePath)) continue;
      if (!fs.statSync(absolutePath).isFile()) continue;
    }

    const currentSource = mode === 'staged'
      ? indexSource(root, relativePath)
      : worktreeSource(root, relativePath);
    const baselineSource = headSource(root, relativePath, baselinePaths);
    const options = {
      maxCommentLines: config.maxCommentLines,
      licensePatterns: config.licensePatterns,
      allow: config.lint.allow,
    };
    const currentViolations = findViolations(relativePath, currentSource, options);
    const baselineViolations = findViolations(relativePath, baselineSource, options);
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
