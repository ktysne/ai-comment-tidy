import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { batchPaths } from '../src/paths.js';
import { readState, statusLabel, transitionState, updateState, validateState, writeState } from '../src/state.js';

const now = '2026-10-07T10:00:00Z';
const later = '2026-10-07T10:05:00Z';
const names = ['prepared', 'delegated', 'reported', 'checked', 'applied'];
const roots = [];
function prepared() {
  return transitionState(null, 'prepared', { pass: 'volume', batch: 'V01', now });
}
function state(status) {
  return { ...prepared(), status, timestamps: { prepared: now, [status]: now } };
}
function root() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tidy-state-'));
  roots.push(directory);
  return directory;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('束の状態', () => {
  test('未着手から用意済みを作り、表示は一か所から取る', () => {
    expect(prepared()).toEqual({
      schemaVersion: 1, pass: 'volume', batch: 'V01', status: 'prepared', runId: null,
      timestamps: { prepared: now }, notes: [], check: null, report: null,
    });
    expect(statusLabel(null)).toBe('未着手');
    expect(names.map((name) => statusLabel(state(name)))).toEqual(['用意済み', '委譲中', '報告あり', '検査済み', '取り込み済み']);
  });

  const allowed = {
    prepared: ['delegated', 'prepared'], delegated: ['reported', 'delegated', 'prepared'],
    reported: ['checked', 'prepared'], checked: ['applied', 'checked', 'prepared'], applied: [],
  };
  test.each(names.flatMap((from) => names.map((to) => [from, to])))('表にある遷移だけを受け付ける: %s -> %s', (from, to) => {
    const previous = state(from);
    if (allowed[from].includes(to)) expect(transitionState(previous, to, { now: later }).status).toBe(to);
    else expect(() => transitionState(previous, to, { now: later })).toThrow('許可されない');
    expect(previous).toEqual(state(from));
  });

  test.each(names.filter((name) => name !== 'prepared'))('未着手からの飛び越しを拒否する: %s', (to) => {
    expect(() => transitionState(null, to, { pass: 'volume', batch: 'V01', now })).toThrow('許可されない');
  });

  test('委譲を先に記録し、二回目の呼び出しで実行IDを追記する', () => {
    const first = transitionState(prepared(), 'delegated', { now });
    const second = transitionState(first, 'delegated', { now: later, changes: { runId: 'run-123' } });
    expect(first.runId).toBeNull();
    expect(second).toMatchObject({ status: 'delegated', runId: 'run-123', timestamps: { prepared: now, delegated: later } });
  });

  test('用意済みへ戻すと実行IDと検査、報告、補足をリセットする', () => {
    const previous = updateState(state('checked'), { runId: 'run-123', check: { ok: true }, report: {}, notes: ['補足'] });
    expect(transitionState(previous, 'prepared', { now: later })).toEqual({
      ...prepared(), timestamps: { prepared: later },
    });
  });

  test('不合格の検査結果を記録しても状態を変えず、入力も変更しない', () => {
    const previous = state('reported');
    const next = updateState(previous, { check: { ok: false } });
    expect(next.status).toBe('reported');
    expect(next.check).toEqual({ ok: false });
    expect(previous.check).toBeNull();
    expect(() => updateState(previous, { status: 'applied' })).toThrow();
  });

  test('状態を保存して読み戻し、不明な版や束の不一致を拒否する', () => {
    const directory = root();
    expect(readState(directory, 'volume', 'V01')).toBeNull();
    writeState(directory, 'volume', 'V01', prepared());
    expect(readState(directory, 'volume', 'V01')).toEqual(prepared());
    expect(() => validateState({ ...prepared(), schemaVersion: 2 })).toThrow('schemaVersion');
    expect(() => writeState(directory, 'volume', 'V02', prepared())).toThrow('一致');
    const file = batchPaths(directory, 'volume', 'V01').state;
    fs.writeFileSync(file, '{壊れたデータ');
    expect(() => readState(directory, 'volume', 'V01')).toThrow('読めません');
    expect(() => writeState(directory, 'volume', 'V01', prepared())).toThrow('読めません');
    expect(fs.readFileSync(file, 'utf8')).toBe('{壊れたデータ');
  });

  test('保存でも許可されない飛び越しを拒否し、元のファイルを保持する', () => {
    const directory = root();
    expect(() => writeState(directory, 'volume', 'V01', state('applied'))).toThrow('許可されない');
    writeState(directory, 'volume', 'V01', prepared());
    const file = batchPaths(directory, 'volume', 'V01').state;
    const original = fs.readFileSync(file, 'utf8');
    expect(() => writeState(directory, 'volume', 'V01', state('checked'))).toThrow('許可されない');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  test('保存に失敗しても元の状態を保持し、一時ファイルを残さない', () => {
    const directory = root();
    writeState(directory, 'volume', 'V01', prepared());
    const file = batchPaths(directory, 'volume', 'V01').state;
    const original = fs.readFileSync(file, 'utf8');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('保存失敗'); });
    expect(() => writeState(directory, 'volume', 'V01', state('delegated'))).toThrow('保存失敗');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['V01.json']);
  });

  test('管理先がリンクなら保存せず停止する', () => {
    const directory = root();
    const target = path.join(directory, '.comment-tidy');
    const lstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => {
      if (file === target) return { isSymbolicLink: () => true };
      return lstat(file, ...args);
    });
    expect(() => writeState(directory, 'volume', 'V01', prepared())).toThrow('リンク');
    expect(fs.existsSync(target)).toBe(false);
  });

  test.each([
    { status: 'unknown' }, { timestamps: {} }, { notes: [{}] }, { runId: 123 },
    { timestamps: { prepared: 'not-a-date' } },
    { check: 'not-an-object' }, { report: [] },
  ])('壊れた状態を拒否する: %j', (change) => {
    expect(() => validateState({ ...prepared(), ...change })).toThrow();
  });
});
