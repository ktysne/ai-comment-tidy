import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { batchPaths, ensureManagedPath, validateName } from './paths.js';

export const STATUS_LABELS = Object.freeze({
  prepared: '用意済み', delegated: '委譲中', reported: '報告あり', checked: '検査済み', applied: '取り込み済み',
});

const TRANSITIONS = new Map([
  [null, ['prepared']], ['prepared', ['delegated', 'prepared']],
  ['delegated', ['reported', 'delegated', 'prepared']], ['reported', ['checked', 'prepared']],
  ['checked', ['applied', 'checked', 'prepared']], ['applied', []],
]);

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('状態の時刻はタイムゾーン付きの日時で指定してください');
  }
}

export function statusLabel(state) {
  return state === null ? '未着手' : STATUS_LABELS[state.status];
}

export function validateState(value, pass, batch) {
  if (!value || value.schemaVersion !== 1) throw new Error('束の状態は schemaVersion 1 が必要です');
  validateName(value.pass, '回');
  validateName(value.batch, '束');
  if ((pass !== undefined && value.pass !== pass) || (batch !== undefined && value.batch !== batch)) {
    throw new Error('束の状態と指定した回、束が一致しません');
  }
  if (!Object.hasOwn(STATUS_LABELS, value.status) || !value.timestamps || typeof value.timestamps !== 'object'
    || Array.isArray(value.timestamps) || !Array.isArray(value.notes) || value.notes.some((note) => typeof note !== 'string')
    || (value.runId !== null && (typeof value.runId !== 'string' || !value.runId))
    || !Object.hasOwn(value, 'check') || !Object.hasOwn(value, 'report')) throw new Error('束の状態の形が不正です');
  for (const [name, time] of Object.entries(value.timestamps)) {
    if (!Object.hasOwn(STATUS_LABELS, name)) throw new Error(`状態の時刻に未知の名前があります: ${name}`);
    timestamp(time);
  }
  if (!Object.hasOwn(value.timestamps, value.status)) throw new Error('現在の状態の時刻がありません');
  for (const field of ['check', 'report']) {
    if (value[field] !== null && (typeof value[field] !== 'object' || Array.isArray(value[field]))) {
      throw new Error(`状態の ${field} はオブジェクトか null で指定してください`);
    }
  }
  return value;
}

export function updateState(state, changes) {
  validateState(state);
  if (Object.keys(changes).some((key) => !['runId', 'notes', 'check', 'report'].includes(key))) {
    throw new Error('状態の補足として変更できるのは runId、notes、check、report だけです');
  }
  return validateState(structuredClone({ ...state, ...changes }));
}

export function transitionState(state, nextStatus, { pass, batch, now = new Date().toISOString(), changes = {} } = {}) {
  if (state !== null) validateState(state, pass, batch);
  if (!TRANSITIONS.get(state?.status ?? null)?.includes(nextStatus)) {
    throw new Error(`許可されない状態遷移です: ${state?.status ?? '未着手'} -> ${nextStatus}`);
  }
  timestamp(now);
  const next = nextStatus === 'prepared' ? {
    schemaVersion: 1, pass: state?.pass ?? pass, batch: state?.batch ?? batch, status: 'prepared',
    runId: null, timestamps: { prepared: now }, notes: [], check: null, report: null,
  } : {
    ...structuredClone(state), status: nextStatus, timestamps: { ...state.timestamps, [nextStatus]: now },
  };
  return updateState(next, changes);
}

export function readState(repoRoot, pass, batch) {
  const filePath = batchPaths(repoRoot, pass, batch).state;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`束の状態を読めません: ${filePath} (${error.message})`, { cause: error });
  }
  return validateState(value, pass, batch);
}

export function writeState(repoRoot, pass, batch, state) {
  validateState(state, pass, batch);
  const filePath = batchPaths(repoRoot, pass, batch).state;
  ensureManagedPath(repoRoot, filePath);
  const previous = readState(repoRoot, pass, batch);
  if (previous?.status !== state.status && !TRANSITIONS.get(previous?.status ?? null)?.includes(state.status)) {
    throw new Error(`許可されない状態遷移です: ${previous?.status ?? '未着手'} -> ${state.status}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    ensureManagedPath(repoRoot, filePath);
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
