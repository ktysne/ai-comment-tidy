import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_COMMENT_LINES = 3;
export const DEFAULT_LICENSE_PATTERNS = Object.freeze([
  'Copyright',
  'SPDX-License-Identifier',
  'この表示を残すこと',
]);
export const DEFAULT_SCOPE_EXCLUDES = Object.freeze([
  'third_party',
  'node_modules',
  'vendor',
  'build',
  'dist',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneDefaults() {
  return {
    maxCommentLines: DEFAULT_MAX_COMMENT_LINES,
    licensePatterns: [...DEFAULT_LICENSE_PATTERNS],
    scope: { exclude: [...DEFAULT_SCOPE_EXCLUDES] },
    lint: { enabled: true, allow: [] },
  };
}

function validatePattern(pattern, field) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error(`${field} は空でない正規表現の文字列で指定してください`);
  }
  try {
    new RegExp(pattern);
  } catch {
    throw new Error(`${field} は正規表現として解釈できません`);
  }
}

function readConfig(configPath) {
  let source;
  try {
    source = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`設定ファイルを読めません: ${configPath} (${error.message})`, { cause: error });
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`設定ファイルを JSON として読めません: ${configPath} (${error.message})`, { cause: error });
  }
}

export function loadLintConfig(repoRoot) {
  const configPath = path.join(repoRoot, '.comment-tidy', 'config.json');
  const source = readConfig(configPath);
  if (source === null) return cloneDefaults();
  if (!isRecord(source)) throw new Error('設定のルートはオブジェクトで指定してください');

  const config = cloneDefaults();
  if (Object.hasOwn(source, 'maxCommentLines')) {
    if (!Number.isInteger(source.maxCommentLines) || source.maxCommentLines < 1) {
      throw new Error('maxCommentLines は 1 以上の整数で指定してください');
    }
    config.maxCommentLines = source.maxCommentLines;
  }

  if (Object.hasOwn(source, 'licensePatterns')) {
    if (!Array.isArray(source.licensePatterns)) {
      throw new Error('licensePatterns は正規表現の文字列の配列で指定してください');
    }
    source.licensePatterns.forEach((pattern, index) => validatePattern(pattern, `licensePatterns[${index}]`));
    config.licensePatterns = [...source.licensePatterns];
  }

  if (Object.hasOwn(source, 'scope')) {
    if (!isRecord(source.scope)) throw new Error('scope はオブジェクトで指定してください');
    if (Object.hasOwn(source.scope, 'exclude')) {
      if (!Array.isArray(source.scope.exclude) || source.scope.exclude.some((item) => typeof item !== 'string' || !item)) {
        throw new Error('scope.exclude は空でないパス文字列の配列で指定してください');
      }
      config.scope.exclude = [...source.scope.exclude];
    }
  }

  if (Object.hasOwn(source, 'lint')) {
    if (!isRecord(source.lint)) throw new Error('lint はオブジェクトで指定してください');
    if (Object.hasOwn(source.lint, 'enabled')) {
      if (typeof source.lint.enabled !== 'boolean') throw new Error('lint.enabled は真偽値で指定してください');
      config.lint.enabled = source.lint.enabled;
    }
    if (Object.hasOwn(source.lint, 'allow')) {
      if (!Array.isArray(source.lint.allow)) throw new Error('lint.allow は配列で指定してください');
      config.lint.allow = source.lint.allow.map((entry, index) => {
        if (!isRecord(entry)) throw new Error(`lint.allow[${index}] はオブジェクトで指定してください`);
        validatePattern(entry.pattern, `lint.allow[${index}].pattern`);
        if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
          throw new Error(`lint.allow[${index}].reason は空でない文字列で指定してください`);
        }
        return { pattern: entry.pattern, reason: entry.reason };
      });
    }
  }

  return config;
}
