import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { createFsSnapshot } from '../snapshot/fs.js';
import { readHashList } from '../snapshot/hash-list.js';
import { runCheck } from './run.js';

function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} の後に値を指定してください`);
  return value;
}

function parseArgs(argv) {
  const parsed = { files: [], seenFiles: false, offline: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--offline') {
      if (parsed.offline) throw new Error('--offline は 1 つだけ指定できます');
      parsed.offline = true;
    } else if (['--base', '--base-dir', '--hashes', '--config', '--out', '--repo'].includes(argument)) {
      if (seen.has(argument)) throw new Error(`${argument} は 1 つだけ指定できます`);
      seen.add(argument);
      const key = {
        '--base': 'base',
        '--base-dir': 'baseDir',
        '--hashes': 'hashesPath',
        '--config': 'configPath',
        '--out': 'outPath',
        '--repo': 'repoRoot',
      }[argument];
      parsed[key] = requiredValue(argv, index, argument);
      index++;
    } else if (argument === '--files') {
      if (parsed.seenFiles) throw new Error('--files は 1 つだけ指定できます');
      parsed.seenFiles = true;
      const start = index + 1;
      while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) parsed.files.push(argv[++index]);
      if (index + 1 === start) throw new Error('--files の後にパスを 1 つ以上指定してください');
    } else {
      throw new Error(`認識できない引数です: ${argument}`);
    }
  }

  if (!parsed.seenFiles || parsed.files.length === 0) throw new Error('--files に 1 つ以上のパスを指定してください');
  if (parsed.offline) {
    if (parsed.base !== undefined) throw new Error('--offline と --base は同時に指定できません');
    if (parsed.baseDir === undefined || parsed.hashesPath === undefined) {
      throw new Error('--offline では --base-dir と --hashes を指定してください');
    }
    if (parsed.outPath !== undefined) throw new Error('--offline は標準出力に結果を出すため --out は使えません');
  } else if (parsed.base === undefined) {
    throw new Error('--base に比較元のコミットを指定してください');
  } else if (parsed.baseDir !== undefined || parsed.hashesPath !== undefined) {
    throw new Error('--base-dir と --hashes は --offline と同時に指定してください');
  }
  if (parsed.configPath !== undefined && !path.isAbsolute(parsed.configPath) && !path.win32.isAbsolute(parsed.configPath)) {
    throw new Error('--config には絶対パスを指定してください');
  }

  parsed.files = parsed.files.map((filePath) => {
    const normalized = filePath.replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || path.win32.isAbsolute(filePath)
      || normalized.split('/').some((part) => part === '..' || part === '.' || part === '')) {
      throw new Error(`--files には相対パスを指定してください: ${filePath}`);
    }
    return normalized;
  });
  if (new Set(parsed.files).size !== parsed.files.length) throw new Error('--files に同じパスを重ねて指定できません');
  return parsed;
}

function isRegularFile(root, filePath) {
  try {
    return fs.lstatSync(path.resolve(root, ...filePath.split('/'))).isFile();
  } catch {
    return false;
  }
}

function offlineSnapshots(options, repoRoot, hashList) {
  const baseDir = path.resolve(options.baseDir);
  const baseline = Object.assign(createFsSnapshot(baseDir, options.files), { baseDir });
  const possibleFiles = [...new Set([...options.files, ...Object.keys(hashList.files)])]
    .filter((filePath) => isRegularFile(repoRoot, filePath));
  const target = createFsSnapshot(repoRoot, possibleFiles);
  return { baseline, target };
}

function formatSummary(result) {
  const lines = [
    `check: ${result.ok ? '合格' : '不合格'}`,
    `対象ファイル: ${result.files.length} 件`,
    `不合格: ${result.failures.length} 件、警告: ${result.warnings.length} 件`,
  ];
  for (const item of [...result.failures, ...result.warnings]) {
    lines.push(`${item.file}${item.line === undefined ? '' : `:${item.line}`} [${item.check}] ${item.detail}`);
  }
  return lines.join('\n');
}

export async function runCheckCommand(argv, io) {
  const options = parseArgs(argv);
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const config = loadConfig(repoRoot, options.configPath);
  let baseline;
  let target;
  let hashList = null;
  let offline = options.offline;

  if (offline) {
    hashList = readHashList(path.resolve(options.hashesPath));
    ({ baseline, target } = offlineSnapshots(options, repoRoot, hashList));
  } else {
    const { createGitSnapshot, resolveCommit } = await import('../snapshot/git.js');
    const base = resolveCommit(repoRoot, options.base);
    baseline = Object.assign(createGitSnapshot(repoRoot, base), { base });
    target = createGitSnapshot(repoRoot);
  }

  const result = runCheck({ files: options.files, baseline, target, hashList, config, offline });
  if (options.outPath !== undefined) {
    fs.writeFileSync(path.resolve(options.outPath), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  } else {
    io.stdout(formatSummary(result));
  }
  return result.ok ? 0 : 1;
}
