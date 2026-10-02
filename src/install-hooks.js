import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENTS = [
  { name: 'PostToolUse', matcher: 'Edit|Write', hook: 'post-edit' },
  { name: 'PreToolUse', matcher: 'Bash|PowerShell', hook: 'pre-commit' },
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArgs(argv) {
  const options = { dryRun: false, remove: false, settingsPath: null };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--settings') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error('--settings の後にファイルを指定してください');
      options.settingsPath = value;
      index++;
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--remove') {
      options.remove = true;
    } else {
      throw new Error(`認識できない引数です: ${argument}`);
    }
  }
  return options;
}

function commandFor(hook) {
  const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'comment-tidy.js')
    .replace(/\\/g, '/');
  const nodePath = path.resolve(process.execPath).replace(/\\/g, '/');
  return `"${nodePath}" "${scriptPath}" lint --hook ${hook}`;
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return { settings: {}, exists: false };
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ') : 'JSON を解析できません';
    throw new Error(`設定ファイルを JSON として読めません: ${settingsPath} (${detail})`, { cause: error });
  }
  if (!isRecord(settings)) throw new Error(`設定ファイルの最上位はオブジェクトである必要があります: ${settingsPath}`);
  if (settings.hooks !== undefined && !isRecord(settings.hooks)) {
    throw new Error(`設定ファイルの hooks はオブジェクトである必要があります: ${settingsPath}`);
  }
  return { settings, exists: true };
}

function ensureEvent(settings, eventName) {
  if (settings.hooks === undefined) settings.hooks = {};
  const hooks = settings.hooks;
  if (hooks[eventName] === undefined) hooks[eventName] = [];
  if (!Array.isArray(hooks[eventName])) {
    throw new Error(`設定ファイルの hooks.${eventName} は配列である必要があります`);
  }
  return hooks[eventName];
}

function ownsCommand(hook) {
  if (!isRecord(hook) || typeof hook.command !== 'string') return false;
  return hook.command.includes('comment-tidy.js')
    && (hook.command.includes('lint --hook post-edit') || hook.command.includes('lint --hook pre-commit'));
}

function removeEmptyGroups(eventHooks) {
  for (let index = eventHooks.length - 1; index >= 0; index--) {
    const group = eventHooks[index];
    if (!isRecord(group) || !Array.isArray(group.hooks) || group.hooks.length > 0) continue;
    delete group.hooks;
    if (Object.keys(group).length === 0 || Object.keys(group).every((key) => key === 'matcher')) {
      eventHooks.splice(index, 1);
    }
  }
}

function addToMatcher(eventHooks, matcher, hook) {
  const group = eventHooks.find((item) => isRecord(item) && item.matcher === matcher && Array.isArray(item.hooks));
  if (group) {
    group.hooks.push(hook);
    return;
  }
  eventHooks.push({ matcher, hooks: [hook] });
}

function upsertEvent(settings, event) {
  const eventHooks = ensureEvent(settings, event.name);
  const matches = [];
  for (const group of eventHooks) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    for (const hook of group.hooks) {
      if (ownsCommand(hook)) matches.push({ group, hook });
    }
  }

  const desiredCommand = commandFor(event.hook);
  if (matches.length === 0) {
    addToMatcher(eventHooks, event.matcher, { type: 'command', command: desiredCommand, timeout: 30 });
    return 'added';
  }

  const first = matches[0];
  const unchanged = first.group.matcher === event.matcher
    && first.hook.type === 'command'
    && first.hook.command === desiredCommand
    && first.hook.timeout === 30
    && matches.length === 1;
  const canonical = { ...first.hook, type: 'command', command: desiredCommand, timeout: 30 };
  if (first.group.matcher === event.matcher) {
    Object.assign(first.hook, canonical);
    for (const group of eventHooks) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      group.hooks = group.hooks.filter((hook) => hook === first.hook || !matches.some((match) => match.hook === hook));
    }
    removeEmptyGroups(eventHooks);
    return unchanged ? 'unchanged' : 'updated';
  }

  for (const group of eventHooks) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    group.hooks = group.hooks.filter((hook) => !matches.some((match) => match.hook === hook));
  }
  removeEmptyGroups(eventHooks);
  addToMatcher(eventHooks, event.matcher, canonical);
  return 'updated';
}

function removeOwnedHooks(settings) {
  let removed = 0;
  if (!isRecord(settings.hooks)) return removed;
  for (const event of EVENTS) {
    const eventHooks = settings.hooks[event.name];
    if (!Array.isArray(eventHooks)) continue;
    for (const group of eventHooks) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      const remaining = group.hooks.filter((hook) => {
        if (!ownsCommand(hook)) return true;
        removed++;
        return false;
      });
      group.hooks = remaining;
    }
    removeEmptyGroups(eventHooks);
    if (eventHooks.length === 0) delete settings.hooks[event.name];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

function render(settings) {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function sameSettings(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function backupPathFor(settingsPath) {
  const now = new Date();
  const stamp = (date) => [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    '-',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join('');
  for (let offset = 0; offset < 86400; offset++) {
    const backupPath = `${settingsPath}.bak-${stamp(new Date(now.getTime() + offset * 1000))}`;
    if (!fs.existsSync(backupPath)) return backupPath;
  }
  throw new Error(`設定ファイルの控えを作れません: ${settingsPath}`);
}

function writeAtomically(settingsPath, contents, exists) {
  const directory = path.dirname(settingsPath);
  fs.mkdirSync(directory, { recursive: true });
  let backupPath = null;
  let mode = 0o666;
  if (exists) {
    mode = fs.statSync(settingsPath).mode;
    backupPath = backupPathFor(settingsPath);
    fs.copyFileSync(settingsPath, backupPath, fs.constants.COPYFILE_EXCL);
  }

  const tempPath = path.join(directory, `.${path.basename(settingsPath)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tempPath, contents, { encoding: 'utf8', flag: 'wx', mode });
    fs.renameSync(tempPath, settingsPath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // 一時ファイルの後始末に失敗しても、元の書き込みエラーを返す。
    }
    throw error;
  }
  return backupPath;
}

function describeActions(actions, dryRun) {
  const verbs = {
    added: dryRun ? '追加予定' : '追加しました',
    updated: dryRun ? '書き換え予定' : '書き換えました',
    unchanged: '変更はありません',
  };
  return actions
    .filter(([, status]) => status !== 'unchanged')
    .map(([eventName, status]) => `${verbs[status]}: ${eventName}`);
}

export function runInstallHooksCommand(argv, { stdout }) {
  const options = parseArgs(argv);
  const settingsPath = path.resolve(options.settingsPath ?? path.join(os.homedir(), '.claude', 'settings.json'));
  const { settings: original, exists } = readSettings(settingsPath);
  const settings = JSON.parse(JSON.stringify(original));
  let actions;

  if (options.remove) {
    const removed = removeOwnedHooks(settings);
    actions = removed > 0 ? [['フック', 'removed']] : [];
  } else {
    actions = EVENTS.map((event) => [event.name, upsertEvent(settings, event)]);
  }

  if (sameSettings(original, settings)) {
    stdout('変更はありません。');
    return 0;
  }

  const contents = render(settings);
  if (options.dryRun) {
    const details = options.remove
      ? ['外す予定: comment-tidy のフック', contents]
      : [...describeActions(actions, true), contents];
    stdout(details.join('\n'));
    return 0;
  }

  const backupPath = writeAtomically(settingsPath, contents, exists);
  const details = options.remove
    ? ['外しました: comment-tidy のフック']
    : describeActions(actions, false);
  if (backupPath) details.push(`控え: ${backupPath}`);
  stdout(details.join('\n'));
  return 0;
}
