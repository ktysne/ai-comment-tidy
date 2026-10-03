import {
  DEFAULT_DOCS_CONFIG,
  DEFAULT_LICENSE_PATTERNS,
  DEFAULT_MAX_COMMENT_LINES,
  DEFAULT_MAX_LINE_WIDTH,
  DEFAULT_SCOPE_EXCLUDES,
  loadConfig,
} from '../config.js';

export {
  DEFAULT_DOCS_CONFIG,
  DEFAULT_LICENSE_PATTERNS,
  DEFAULT_MAX_COMMENT_LINES,
  DEFAULT_MAX_LINE_WIDTH,
  DEFAULT_SCOPE_EXCLUDES,
};

export function loadLintConfig(repoRoot, configFilePath = undefined) {
  const config = loadConfig(repoRoot, configFilePath);
  return {
    maxCommentLines: config.maxCommentLines,
    maxLineWidth: config.maxLineWidth,
    docs: config.docs,
    licensePatterns: config.licensePatterns,
    scope: { exclude: config.scope.exclude },
    lint: config.lint,
  };
}
