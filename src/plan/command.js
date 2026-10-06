import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { commitDate, createGitSnapshot, repositoryRoot, resolveCommit } from '../snapshot/git.js';
import { planForSnapshot } from './run.js';
import { batchDefinitionPath } from '../paths.js';

const TOOL_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function parseArgs(argv) {
  const options = { force: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (['--base', '--repo', '--config', '--force'].includes(argument)) {
      if (seen.has(argument)) throw new Error(`${argument} は 1 つだけ指定できます`);
      seen.add(argument);
      if (argument === '--force') {
        options.force = true;
        continue;
      }
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} の後に値を指定してください`);
      options[{ '--base': 'base', '--repo': 'repoRoot', '--config': 'configPath' }[argument]] = value;
    } else if (argument.startsWith('-')) {
      throw new Error(`認識できない引数です: ${argument}`);
    } else if (options.pass === undefined) {
      options.pass = argument;
    } else {
      throw new Error('回は 1 つだけ指定してください');
    }
  }
  if (!options.pass || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(options.pass)) {
    throw new Error('回は英数字、ハイフン、アンダースコアで指定してください');
  }
  if (options.configPath !== undefined && !path.isAbsolute(options.configPath) && !path.win32.isAbsolute(options.configPath)) {
    throw new Error('--config には絶対パスを指定してください');
  }
  return options;
}

function fileStatus(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validateOutput(outputPath, force) {
  const directory = fileStatus(path.dirname(outputPath));
  if (directory && !directory.isDirectory()) throw new Error('束の定義の置き場は通常のディレクトリである必要があります');
  const existing = fileStatus(outputPath);
  if (existing && (!force || !existing.isFile())) {
    throw new Error(`既存の束の定義を上書きできません: ${outputPath}${force ? '' : ' (--force が必要です)'}`);
  }
}

function writeDefinition(outputPath, definition, force) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(definition, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    validateOutput(outputPath, force);
    if (force) fs.renameSync(temporaryPath, outputPath);
    else fs.linkSync(temporaryPath, outputPath);
  } finally {
    if (fileStatus(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

export function runPlanCommand(argv, io) {
  const options = parseArgs(argv);
  const repoRoot = repositoryRoot(path.resolve(options.repoRoot ?? process.cwd()));
  const config = loadConfig(repoRoot, options.configPath);
  if (!config.passes || !Object.hasOwn(config.passes, options.pass)) {
    throw new Error(`設定に回がありません: ${options.pass}`);
  }
  const outputPath = batchDefinitionPath(repoRoot, options.pass);
  validateOutput(outputPath, options.force);
  const base = resolveCommit(repoRoot, options.base ?? config.plan.base);
  const date = commitDate(repoRoot, base);
  let toolCommit = null;
  try {
    toolCommit = resolveCommit(TOOL_ROOT, 'HEAD');
  } catch {
    // 配布先に Git の情報が無い場合も、対象リポジトリの束は生成できる。
  }
  const { definition, warnings } = planForSnapshot(createGitSnapshot(repoRoot, base), {
    pass: options.pass, base, toolCommit, config,
  });
  writeDefinition(outputPath, definition, options.force);
  io.stdout(`plan: 基準 ${base} (${date})`);
  io.stdout(`${path.relative(repoRoot, outputPath).replace(/\\/g, '/')}: ${definition.batches.length} 束`);
  for (const warning of warnings) io.stderr(`警告: ${warning.path}: ${warning.message}`);
  return 0;
}
