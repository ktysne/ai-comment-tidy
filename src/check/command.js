import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { validateName } from '../paths.js';
import { readHashList } from '../snapshot/hash-list.js';
import { runCheck } from './run.js';
import { offlineSnapshots } from './snapshots.js';
import { formatSummary } from './summary.js';

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
    } else if (['--base', '--base-dir', '--hashes', '--config', '--out', '--repo', '--pass'].includes(argument)) {
      if (seen.has(argument)) throw new Error(`${argument} は 1 つだけ指定できます`);
      seen.add(argument);
      const key = {
        '--base': 'base',
        '--base-dir': 'baseDir',
        '--hashes': 'hashesPath',
        '--config': 'configPath',
        '--out': 'outPath',
        '--repo': 'repoRoot',
        '--pass': 'pass',
      }[argument];
      parsed[key] = requiredValue(argv, index, argument);
      index++;
    } else if (argument === '--files') {
      if (parsed.seenFiles) throw new Error('--files は 1 つだけ指定できます');
      parsed.seenFiles = true;
      const start = index + 1;
      while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) parsed.files.push(argv[++index]);
      if (index + 1 === start) throw new Error('--files の後にパスを 1 つ以上指定してください');
    } else if (!argument.startsWith('-') && parsed.batch === undefined) {
      parsed.batch = validateName(argument, '束');
    } else {
      throw new Error(`認識できない引数です: ${argument}`);
    }
  }

  if (parsed.configPath !== undefined && !path.isAbsolute(parsed.configPath) && !path.win32.isAbsolute(parsed.configPath)) {
    throw new Error('--config には絶対パスを指定してください');
  }
  if (parsed.batch !== undefined) {
    if (parsed.pass !== undefined) validateName(parsed.pass, '回');
    if (parsed.seenFiles || ['base', 'baseDir', 'hashesPath', 'outPath'].some((key) => parsed[key] !== undefined)) {
      throw new Error('束の検査では --files、--base、--base-dir、--hashes、--out は指定できません');
    }
    return parsed;
  }
  if (parsed.pass !== undefined) throw new Error('--pass は束の検査だけで使えます');
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

export async function runCheckCommand(argv, io) {
  const options = parseArgs(argv);
  if (options.batch !== undefined) return (await import('./batch-command.js')).runBatchCheckCommand(options, io);
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
