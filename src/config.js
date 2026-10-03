import fs from 'node:fs';
import path from 'node:path';
import { matchesGlob } from './glob.js';
import { languageFor, languages } from './lex/index.js';

export const DEFAULT_MAX_COMMENT_LINES = 3;
export const DEFAULT_MAX_LINE_WIDTH = 108;
export const DEFAULT_DOCS_CONFIG = Object.freeze({
  root: 'docs',
  refPattern: 'docs/(?<doc>[\\w.-]+)「(?<heading>[^」]+)」',
});
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
export const DEFAULT_IMPLEMENTER_CONFIG = Object.freeze({
  agent: 'impl-standard',
  parallel: 2,
});
export const DEFAULT_PLAN_CONFIG = Object.freeze({
  base: 'origin/main',
  maxWeight: 700,
});

const LANGUAGE_IDS = new Set(languages.map(({ id }) => id));

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function cloneDefaults() {
  return {
    maxCommentLines: DEFAULT_MAX_COMMENT_LINES,
    maxLineWidth: DEFAULT_MAX_LINE_WIDTH,
    docs: { ...DEFAULT_DOCS_CONFIG },
    licensePatterns: [...DEFAULT_LICENSE_PATTERNS],
    scope: { exclude: [...DEFAULT_SCOPE_EXCLUDES] },
    implementer: { ...DEFAULT_IMPLEMENTER_CONFIG },
    plan: { ...DEFAULT_PLAN_CONFIG },
    lint: { enabled: true, allow: [] },
  };
}

function validatePattern(pattern, field) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error(field + ' は空でない正規表現の文字列で指定してください');
  }
  try {
    new RegExp(pattern);
  } catch {
    throw new Error(field + ' は正規表現として解釈できません');
  }
}

function validateStringArray(value, field, description) {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
    throw new Error(field + ' は' + description + 'の配列で指定してください');
  }
}

function validatePatternArray(value, field) {
  validateStringArray(value, field, '空でないパターン文字列');
}

function validateLanguageKey(id, field) {
  if (!LANGUAGE_IDS.has(id)) throw new Error(field + ' に未知の言語を指定できません: ' + id);
}

function readConfig(configPath) {
  let source;
  try {
    source = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error('設定ファイルを読めません: ' + configPath + ' (' + error.message + ')', { cause: error });
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error('設定ファイルを JSON として読めません: ' + configPath + ' (' + error.message + ')', { cause: error });
  }
}

function validateLanguagePatterns(source, field) {
  if (!isRecord(source)) throw new Error(field + ' はオブジェクトで指定してください');
  const result = {};
  for (const [id, patterns] of Object.entries(source)) {
    validateLanguageKey(id, field + '.' + id);
    validatePatternArray(patterns, field + '.' + id);
    result[id] = [...patterns];
  }
  return result;
}

function validateNamedPatterns(source, field) {
  if (!isRecord(source)) throw new Error(field + ' はオブジェクトで指定してください');
  const result = {};
  for (const [name, patterns] of Object.entries(source)) {
    if (!isNonEmptyString(name)) throw new Error(field + ' の名前は空でない文字列で指定してください');
    validatePatternArray(patterns, field + '.' + name);
    result[name] = [...patterns];
  }
  return result;
}

function validateConfig(source) {
  if (!isRecord(source)) throw new Error('設定のルートはオブジェクトで指定してください');

  const config = cloneDefaults();
  if (Object.hasOwn(source, 'maxCommentLines')) {
    if (!Number.isInteger(source.maxCommentLines) || source.maxCommentLines < 1) {
      throw new Error('maxCommentLines は 1 以上の整数で指定してください');
    }
    config.maxCommentLines = source.maxCommentLines;
  }

  if (Object.hasOwn(source, 'maxLineWidth')) {
    if (!Number.isInteger(source.maxLineWidth) || source.maxLineWidth < 1) {
      throw new Error('maxLineWidth は 1 以上の整数で指定してください');
    }
    config.maxLineWidth = source.maxLineWidth;
  }

  if (Object.hasOwn(source, 'docs')) {
    if (!isRecord(source.docs)) throw new Error('docs はオブジェクトで指定してください');
    if (Object.hasOwn(source.docs, 'root')) {
      const root = source.docs.root;
      const segments = typeof root === 'string' ? root.replace(/\\/g, '/').split('/') : [];
      if (typeof root !== 'string' || root.length === 0 || path.isAbsolute(root) || path.win32.isAbsolute(root)
        || segments.some((segment) => segment === '..' || segment === '')) {
        throw new Error('docs.root は空でないパス文字列で指定してください');
      }
      config.docs.root = root;
    }
    if (Object.hasOwn(source.docs, 'refPattern')) {
      const pattern = source.docs.refPattern;
      validatePattern(pattern, 'docs.refPattern');
      if (!pattern.includes('(?<doc>') || !pattern.includes('(?<heading>')) {
        throw new Error('docs.refPattern は doc と heading の名前付き捕捉を持つ必要があります');
      }
      config.docs.refPattern = pattern;
    }
  }

  if (Object.hasOwn(source, 'licensePatterns')) {
    if (!Array.isArray(source.licensePatterns)) {
      throw new Error('licensePatterns は正規表現の文字列の配列で指定してください');
    }
    source.licensePatterns.forEach((pattern, index) => validatePattern(pattern, 'licensePatterns[' + index + ']'));
    config.licensePatterns = [...source.licensePatterns];
  }

  if (Object.hasOwn(source, 'scope')) {
    if (!isRecord(source.scope)) throw new Error('scope はオブジェクトで指定してください');
    if (Object.hasOwn(source.scope, 'include')) {
      validatePatternArray(source.scope.include, 'scope.include');
      config.scope.include = [...source.scope.include];
    }
    if (Object.hasOwn(source.scope, 'exclude')) {
      if (!Array.isArray(source.scope.exclude) || source.scope.exclude.some((item) => typeof item !== 'string' || !item)) {
        throw new Error('scope.exclude は空でないパス文字列の配列で指定してください');
      }
      config.scope.exclude = [...source.scope.exclude];
    }
  }

  if (Object.hasOwn(source, 'rulesPaths')) {
    validateStringArray(source.rulesPaths, 'rulesPaths', '空でないパス文字列');
    config.rulesPaths = [...source.rulesPaths];
  }

  if (Object.hasOwn(source, 'languages')) config.languages = validateLanguagePatterns(source.languages, 'languages');
  if (Object.hasOwn(source, 'areas')) config.areas = validateNamedPatterns(source.areas, 'areas');

  if (Object.hasOwn(source, 'implementer')) {
    if (!isRecord(source.implementer)) throw new Error('implementer はオブジェクトで指定してください');
    if (Object.hasOwn(source.implementer, 'agent')) {
      if (!isNonEmptyString(source.implementer.agent)) {
        throw new Error('implementer.agent は空でない文字列で指定してください');
      }
      config.implementer.agent = source.implementer.agent;
    }
    if (Object.hasOwn(source.implementer, 'parallel')) {
      if (!Number.isInteger(source.implementer.parallel) || source.implementer.parallel < 1) {
        throw new Error('implementer.parallel は 1 以上の整数で指定してください');
      }
      config.implementer.parallel = source.implementer.parallel;
    }
  }

  if (Object.hasOwn(source, 'plan')) {
    if (!isRecord(source.plan)) throw new Error('plan はオブジェクトで指定してください');
    if (Object.hasOwn(source.plan, 'base')) {
      if (!isNonEmptyString(source.plan.base)) throw new Error('plan.base は空でない文字列で指定してください');
      config.plan.base = source.plan.base;
    }
    if (Object.hasOwn(source.plan, 'maxWeight')) {
      if (!Number.isInteger(source.plan.maxWeight) || source.plan.maxWeight < 1) {
        throw new Error('plan.maxWeight は 1 以上の整数で指定してください');
      }
      config.plan.maxWeight = source.plan.maxWeight;
    }
  }

  if (Object.hasOwn(source, 'audit')) {
    if (!isRecord(source.audit)) throw new Error('audit はオブジェクトで指定してください');
    if (Object.hasOwn(source.audit, 'keywordGroups')) {
      const groups = source.audit.keywordGroups;
      if (!isRecord(groups)) throw new Error('audit.keywordGroups はオブジェクトで指定してください');
      config.audit = { ...source.audit, keywordGroups: {} };
      for (const [name, keywords] of Object.entries(groups)) {
        if (!isNonEmptyString(name)) throw new Error('audit.keywordGroups の名前は空でない文字列で指定してください');
        validateStringArray(keywords, 'audit.keywordGroups.' + name, '空でないキーワード');
        config.audit.keywordGroups[name] = [...keywords];
      }
    } else {
      config.audit = { ...source.audit };
    }
  }

  if (Object.hasOwn(source, 'privatize')) {
    if (!isRecord(source.privatize)) throw new Error('privatize はオブジェクトで指定してください');
    config.privatize = {};
    for (const [id, rules] of Object.entries(source.privatize)) {
      validateLanguageKey(id, 'privatize.' + id);
      if (!isRecord(rules)) throw new Error('privatize.' + id + ' はオブジェクトで指定してください');
      const validated = {};
      for (const key of ['implementationFiles', 'testFiles']) {
        if (!Object.hasOwn(rules, key)) continue;
        validatePatternArray(rules[key], 'privatize.' + id + '.' + key);
        validated[key] = [...rules[key]];
      }
      config.privatize[id] = validated;
    }
  }

  if (Object.hasOwn(source, 'passes')) {
    if (!isRecord(source.passes)) throw new Error('passes はオブジェクトで指定してください');
    config.passes = {};
    for (const [name, pass] of Object.entries(source.passes)) {
      if (!isRecord(pass)) throw new Error('passes.' + name + ' はオブジェクトで指定してください');
      if (!isNonEmptyString(pass.criteria)) {
        throw new Error('passes.' + name + '.criteria は空でないパス文字列で指定してください');
      }
      const validated = { criteria: pass.criteria };
      if (Object.hasOwn(pass, 'finish')) {
        validateStringArray(pass.finish, 'passes.' + name + '.finish', '空でない文字列');
        validated.finish = [...pass.finish];
      }
      config.passes[name] = validated;
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
        if (!isRecord(entry)) throw new Error('lint.allow[' + index + '] はオブジェクトで指定してください');
        validatePattern(entry.pattern, 'lint.allow[' + index + '].pattern');
        if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
          throw new Error('lint.allow[' + index + '].reason は空でない文字列で指定してください');
        }
        return { pattern: entry.pattern, reason: entry.reason };
      });
    }
  }

  return config;
}

export function loadConfig(repoRoot, configFilePath = path.join(repoRoot, '.comment-tidy', 'config.json')) {
  const configPath = path.resolve(configFilePath);
  const source = readConfig(configPath);
  return source === undefined ? cloneDefaults() : validateConfig(source);
}

export function isTargetFile(filePath, config, { include = true } = {}) {
  if (!languageFor(filePath, config)) return false;
  const scope = config?.scope ?? {};
  const excludes = scope.exclude ?? DEFAULT_SCOPE_EXCLUDES;
  if (excludes.some((pattern) => matchesGlob(filePath, pattern))) return false;
  if (include && scope.include !== undefined && !scope.include.some((pattern) => matchesGlob(filePath, pattern))) return false;
  return true;
}
