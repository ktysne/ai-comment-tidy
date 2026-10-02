import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

import { run } from '../src/cli.js';

const roots = [];

function makeSettingsPath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-install-hooks-'));
  roots.push(root);
  return path.join(root, 'settings.json');
}

function capture() {
  const stdout = [];
  const stderr = [];
  return { stdout, stderr, io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) } };
}

async function runInstall(settingsPath, ...args) {
  const result = capture();
  const code = await run(['install-hooks', '--settings', settingsPath, ...args], result.io);
  return { code, ...result };
}

function readSettings(settingsPath) {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

function commandFor(hook) {
  const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'comment-tidy.js')
    .replace(/\\/g, '/');
  return `"${path.resolve(process.execPath).replace(/\\/g, '/')}" "${scriptPath}" lint --hook ${hook}`;
}

function ownedHooks(settings) {
  return Object.values(settings.hooks ?? {}).flatMap((groups) => groups)
    .flatMap((group) => group.hooks ?? [])
    .filter((hook) => hook.command?.includes('comment-tidy.js'));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('install-hooks', () => {
  test('設定ファイルが無ければ 2 つのフックを新しく作る', async () => {
    const settingsPath = makeSettingsPath();

    const result = await runInstall(settingsPath);

    expect(result.code).toBe(0);
    const settings = readSettings(settingsPath);
    expect(Object.keys(settings)).toEqual(['hooks']);
    expect(settings.hooks.PostToolUse).toEqual([{
      matcher: 'Edit|Write',
      hooks: [{ type: 'command', command: commandFor('post-edit'), timeout: 30 }],
    }]);
    expect(settings.hooks.PreToolUse).toEqual([{
      matcher: 'Bash|PowerShell',
      hooks: [{ type: 'command', command: commandFor('pre-commit'), timeout: 30 }],
    }]);
    expect(fs.readdirSync(path.dirname(settingsPath)).filter((name) => name.includes('.bak-'))).toEqual([]);
  });

  test('既存の設定項目とほかのフックの順序を残す', async () => {
    const settingsPath = makeSettingsPath();
    const existingPost = { type: 'command', command: 'other-post-hook', timeout: 10 };
    const existingPre = { type: 'command', command: 'other-pre-hook', timeout: 20 };
    fs.writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['Read'] },
      hooks: {
        PostToolUse: [{ matcher: 'Other', hooks: [existingPost] }],
        PreToolUse: [{ matcher: 'Other', hooks: [existingPre] }],
      },
    }), 'utf8');

    const result = await runInstall(settingsPath);

    expect(result.code).toBe(0);
    const settings = readSettings(settingsPath);
    expect(settings.permissions).toEqual({ allow: ['Read'] });
    expect(settings.hooks.PostToolUse[0]).toEqual({ matcher: 'Other', hooks: [existingPost] });
    expect(settings.hooks.PreToolUse[0]).toEqual({ matcher: 'Other', hooks: [existingPre] });
    expect(settings.hooks.PostToolUse[1].matcher).toBe('Edit|Write');
    expect(settings.hooks.PreToolUse[1].matcher).toBe('Bash|PowerShell');
  });

  test('2 回目は設定を書き込まず控えも増やさない', async () => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(settingsPath, JSON.stringify({ custom: true }), 'utf8');
    await runInstall(settingsPath);
    const firstContents = fs.readFileSync(settingsPath, 'utf8');
    const backups = fs.readdirSync(path.dirname(settingsPath)).filter((name) => name.startsWith('settings.json.bak-'));

    const second = await runInstall(settingsPath);

    expect(second.code).toBe(0);
    expect(second.stdout).toEqual(['変更はありません。']);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(firstContents);
    expect(fs.readdirSync(path.dirname(settingsPath)).filter((name) => name.startsWith('settings.json.bak-')))
      .toEqual(backups);
  });

  test('古いパスのフックを現在のコマンドと timeout へ書き換える', async () => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PostToolUse: [{
          matcher: 'Edit|Write',
          hooks: [{
            type: 'command',
            command: '"C:/old/node.exe" "C:/old/bin/comment-tidy.js" lint --hook post-edit',
            timeout: 12,
          }],
        }],
      },
    }), 'utf8');

    const result = await runInstall(settingsPath);

    expect(result.code).toBe(0);
    const settings = readSettings(settingsPath);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse[0].hooks).toEqual([
      { type: 'command', command: commandFor('post-edit'), timeout: 30 },
    ]);
    expect(ownedHooks(settings)).toHaveLength(2);
  });

  test('既存設定を書き換える前に同じフォルダーへ控えを作る', async () => {
    const settingsPath = makeSettingsPath();
    const original = '{"custom":true}\n';
    fs.writeFileSync(settingsPath, original, 'utf8');

    const result = await runInstall(settingsPath);

    expect(result.code).toBe(0);
    const backups = fs.readdirSync(path.dirname(settingsPath))
      .filter((name) => /^settings\.json\.bak-\d{8}-\d{6}$/.test(name));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(settingsPath), backups[0]), 'utf8')).toBe(original);
    expect(result.stdout.join('\n')).toContain(path.join(path.dirname(settingsPath), backups[0]));
  });

  test('--remove はこの道具のフックだけを外す', async () => {
    const settingsPath = makeSettingsPath();
    const otherPost = { type: 'command', command: 'other-post' };
    const otherEvent = { type: 'command', command: 'other-event' };
    fs.writeFileSync(settingsPath, JSON.stringify({
      custom: true,
      hooks: {
        PostToolUse: [{
          matcher: 'Edit|Write',
          hooks: [
            { type: 'command', command: '"/old/node" "/old/comment-tidy.js" lint --hook post-edit', timeout: 30 },
            otherPost,
          ],
        }],
        PreToolUse: [{
          matcher: 'Bash|PowerShell',
          hooks: [{ type: 'command', command: '"/old/node" "/old/comment-tidy.js" lint --hook pre-commit', timeout: 30 }],
        }],
        Notification: [{ matcher: '.*', hooks: [otherEvent] }],
      },
    }), 'utf8');

    const result = await runInstall(settingsPath, '--remove');

    expect(result.code).toBe(0);
    const settings = readSettings(settingsPath);
    expect(settings.custom).toBe(true);
    expect(settings.hooks.PostToolUse).toEqual([{ matcher: 'Edit|Write', hooks: [otherPost] }]);
    expect(settings.hooks.PreToolUse).toBeUndefined();
    expect(settings.hooks.Notification).toEqual([{ matcher: '.*', hooks: [otherEvent] }]);
    expect(ownedHooks(settings)).toEqual([]);
  });

  test('--dry-run は追加内容を表示して設定ファイルを変えない', async () => {
    const settingsPath = makeSettingsPath();
    const original = '{"custom":true}\n';
    fs.writeFileSync(settingsPath, original, 'utf8');

    const result = await runInstall(settingsPath, '--dry-run');

    expect(result.code).toBe(0);
    expect(result.stdout.join('\n')).toContain('追加予定: PostToolUse');
    expect(result.stdout.join('\n')).toContain(JSON.stringify(commandFor('post-edit')));
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(original);
    expect(fs.readdirSync(path.dirname(settingsPath)).filter((name) => name.includes('.bak-'))).toEqual([]);
  });

  test('壊れた JSON は書き換えずに 2 で終わる', async () => {
    const settingsPath = makeSettingsPath();
    const original = '{ invalid';
    fs.writeFileSync(settingsPath, original, 'utf8');

    const result = await runInstall(settingsPath);

    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain('JSON として読めません');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(original);
    expect(fs.readdirSync(path.dirname(settingsPath)).filter((name) => name.includes('.bak-'))).toEqual([]);
  });
});
