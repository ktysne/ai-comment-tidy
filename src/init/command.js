import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageOf, languageFor, languages } from '../lex/index.js';
import { matchesGlob } from '../glob.js';
import { createGitSnapshot, repositoryRoot } from '../snapshot/git.js';
import { findForbiddenTerms, parseCriteriaSections } from './criteria.js';

const TEMPLATE_PATH = fileURLToPath(new URL('../../templates/criteria.md', import.meta.url));
const IGNORE_ENTRIES = ['.comment-tidy/work/', '.comment-tidy/worktrees/'];

function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} の後に値を指定してください`);
  return value;
}

function parseArgs(argv) {
  const options = { pass: 'volume' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (['--pass', '--repo', '--config'].includes(argument)) {
      if (seen.has(argument)) throw new Error(`${argument} は 1 つだけ指定できます`);
      seen.add(argument);
      const value = requiredValue(argv, index, argument);
      options[{ '--pass': 'pass', '--repo': 'repoRoot', '--config': 'configPath' }[argument]] = value;
      index++;
    } else {
      throw new Error(`認識できない引数です: ${argument}`);
    }
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(options.pass)) {
    throw new Error('--pass は英数字、ハイフン、アンダースコアで指定してください');
  }
  if (options.configPath !== undefined && !path.isAbsolute(options.configPath) && !path.win32.isAbsolute(options.configPath)) {
    throw new Error('--config には絶対パスを指定してください');
  }
  return options;
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function firstLevelDirectory(filePath) {
  const separator = filePath.indexOf('/');
  return separator < 0 ? null : filePath.slice(0, separator);
}

function isCMakeLists(filePath) {
  return path.posix.basename(filePath).toLowerCase() === 'cmakelists.txt';
}

function addLanguageFile(groups, filePath, language) {
  let group = groups.get(language.id);
  if (!group) {
    group = { extensions: new Set(), cmakeNames: new Set() };
    groups.set(language.id, group);
  }
  if (language.id === 'cmake' && isCMakeLists(filePath)) {
    group.cmakeNames.add(path.posix.basename(filePath));
    return;
  }
  const fileName = path.posix.basename(filePath);
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1);
  if (extension) group.extensions.add(extension);
}

function languagePatterns(groups) {
  const result = {};
  for (const language of languages) {
    const group = groups.get(language.id);
    if (!group) continue;
    const patterns = [];
    for (const name of [...group.cmakeNames].sort(comparePaths)) patterns.push(`**/${name}`);
    for (const extension of [...group.extensions].sort(comparePaths)) patterns.push(`**/*.${extension}`);
    result[language.id] = patterns;
  }
  return result;
}

function assertGlobLiteral(value, label) {
  if (/[?*]/u.test(value) || /\{[^{}]*,[^{}]*\}/u.test(value)) {
    throw new Error(`${label} に glob の特殊文字が含まれるため、安全な設定を生成できません: ${value}`);
  }
}

function createInitialConfig(filePaths, pass) {
  const groups = new Map();
  const directories = new Set();
  const rootFiles = [];
  const targetFiles = [];

  for (const filePath of filePaths) {
    const language = languageOf(filePath);
    if (!language) continue;
    addLanguageFile(groups, filePath, language);
    targetFiles.push({ filePath, languageId: language.id });
    const directory = firstLevelDirectory(filePath);
    if (directory === null) rootFiles.push(filePath);
    else directories.add(directory);
  }

  const sortedDirectories = [...directories].sort(comparePaths);
  for (const directory of sortedDirectories) assertGlobLiteral(directory, 'ディレクトリ名');
  for (const filePath of rootFiles) assertGlobLiteral(filePath, 'ルート直下のファイル名');
  if (sortedDirectories.includes('root') && rootFiles.length > 0) {
    throw new Error('領域名 root がディレクトリとルート直下のファイルで重複するため、設定を生成できません');
  }

  const include = [
    ...sortedDirectories.map((directory) => `${directory}/**`),
    ...rootFiles.sort(comparePaths),
  ];
  const areas = Object.fromEntries([
    ...sortedDirectories.map((directory) => [directory, [`${directory}/**`]]),
    ...(rootFiles.length > 0 ? [['root', [...rootFiles].sort(comparePaths)]] : []),
  ]);
  const config = {
    rulesPaths: ['~/.claude/CLAUDE.md', '~/.claude/skills/comment-writing/SKILL.md'],
    scope: { include },
    languages: languagePatterns(groups),
    areas,
    passes: { [pass]: { criteria: `criteria-${pass}.md` } },
  };

  validateGeneratedPatterns(config, targetFiles);
  return config;
}

function validateGeneratedPatterns(config, targetFiles) {
  for (const { filePath, languageId } of targetFiles) {
    const resolvedLanguage = languageFor(filePath, config);
    if (resolvedLanguage?.id !== languageId) {
      throw new Error(`追跡ファイルを生成した言語設定で判定できません: ${filePath}`);
    }
    if (!config.scope.include.some((pattern) => matchesGlob(filePath, pattern))) {
      throw new Error(`追跡ファイルを生成した対象設定に含められません: ${filePath}`);
    }

    const expectedArea = firstLevelDirectory(filePath) ?? 'root';
    const matchingAreas = Object.entries(config.areas)
      .filter(([, patterns]) => patterns.some((pattern) => matchesGlob(filePath, pattern)))
      .map(([name]) => name);
    if (matchingAreas[0] !== expectedArea || matchingAreas.length !== 1) {
      throw new Error(`追跡ファイルを一つの領域へ割り当てられません: ${filePath}`);
    }
  }
}

function criteriaTemplate() {
  const content = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const sections = parseCriteriaSections(content);
  const forbidden = findForbiddenTerms(Object.values(sections).join('\n'));
  if (forbidden.length > 0) {
    const first = forbidden[0];
    throw new Error(`判定基準の雛形に禁止語があります(${first.term}, ${first.line} 行目)`);
  }
  return content;
}

function appendIgnoreEntries(source) {
  const lines = source.split(/\r?\n/u).map((line) => line.trim());
  const missing = IGNORE_ENTRIES.filter((entry) => {
    const withoutSlash = entry.slice(0, -1);
    return !lines.includes(entry) && !lines.includes(withoutSlash);
  });
  if (missing.length === 0) return source;
  if (!source) return `${missing.join('\n')}\n`;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return `${source}${source.endsWith('\n') || source.endsWith('\r') ? '' : newline}${missing.join(newline)}${newline}`;
}

function writeTemporaryFile(targetPath, content) {
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
  return temporaryPath;
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function ensureUniqueTargets(targets) {
  const paths = targets.map((target) => target.path);
  for (let index = 0; index < paths.length; index++) {
    if (paths.some((candidate, candidateIndex) => candidateIndex !== index && samePath(paths[index], candidate))) {
      throw new Error(`生成先が重複しています: ${paths[index]}`);
    }
  }
}

function removeGeneratedFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // 本来の生成エラーを後始末の失敗で隠さない。
  }
}

function commitGeneratedFiles(files, gitignorePath, gitignoreContent, updateGitignore, originalGitignore) {
  const temporaryPaths = [];
  const createdPaths = [];
  let gitignoreTemporaryPath;
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      const temporaryPath = writeTemporaryFile(file.path, file.content);
      temporaryPaths.push(temporaryPath);
    }
    if (updateGitignore) {
      gitignoreTemporaryPath = writeTemporaryFile(gitignorePath, gitignoreContent);
      temporaryPaths.push(gitignoreTemporaryPath);
    }

    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      fs.linkSync(temporaryPaths[index], file.path);
      createdPaths.push(file.path);
    }

    if (updateGitignore) {
      if (originalGitignore === null) {
        fs.linkSync(gitignoreTemporaryPath, gitignorePath);
        createdPaths.push(gitignorePath);
      } else {
        const current = fs.readFileSync(gitignorePath, 'utf8');
        if (current !== originalGitignore) throw new Error('.gitignore が読み取り後に変更されたため、生成を中止しました');
        fs.renameSync(gitignoreTemporaryPath, gitignorePath);
      }
    }
  } catch (error) {
    for (const createdPath of createdPaths) removeGeneratedFile(createdPath);
    throw error;
  } finally {
    for (const temporaryPath of temporaryPaths) removeGeneratedFile(temporaryPath);
  }
}

function readGitignore(filePath) {
  try {
    if (!fs.lstatSync(filePath).isFile()) throw new Error('.gitignore は通常ファイルである必要があります');
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`.gitignore を読めません: ${error.message}`, { cause: error });
  }
}

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function runInitCommand(argv, io) {
  const options = parseArgs(argv);
  const repoRoot = repositoryRoot(path.resolve(options.repoRoot ?? process.cwd()));
  const configPath = path.resolve(options.configPath ?? path.join(repoRoot, '.comment-tidy', 'config.json'));
  const criteriaPath = path.join(repoRoot, '.comment-tidy', `criteria-${options.pass}.md`);
  const gitignorePath = path.join(repoRoot, '.gitignore');
  ensureUniqueTargets([
    { path: configPath },
    { path: criteriaPath },
    { path: gitignorePath },
  ]);

  const existing = [configPath, criteriaPath].filter(pathExists);
  if (existing.length > 0) throw new Error(`既存の成果物を上書きしないため初期化を中止しました: ${existing.join(', ')}`);

  const snapshot = createGitSnapshot(repoRoot);
  const config = createInitialConfig(snapshot.listTrackedFiles(), options.pass);
  const template = criteriaTemplate();
  const originalGitignore = readGitignore(gitignorePath);
  const gitignoreContent = appendIgnoreEntries(originalGitignore ?? '');
  const updateGitignore = originalGitignore === null || gitignoreContent !== originalGitignore;
  const files = [
    { path: configPath, content: `${JSON.stringify(config, null, 2)}\n` },
    { path: criteriaPath, content: template },
  ];

  commitGeneratedFiles(files, gitignorePath, gitignoreContent, updateGitignore, originalGitignore);
  io.stdout(`init: ${path.relative(repoRoot, configPath).replace(/\\/g, '/')}, .comment-tidy/criteria-${options.pass}.md${updateGitignore ? ', .gitignore' : ''}`);
  return 0;
}
