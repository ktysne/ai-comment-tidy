import { describe, expect, test } from 'vitest';
import { validateBatchDefinition } from '../src/batches.js';

function definition() {
  return {
    schemaVersion: 1, pass: 'volume', base: 'a'.repeat(40), toolCommit: null,
    batches: [{ id: 'V01', area: 'src', files: ['src/a.cpp'], weight: 1, commentChars: 50, docs: ['docs/design.md'] }],
  };
}
describe('束の定義の読み取り', () => {
  test('既知の版と完全なSHAを読み取る', () => {
    expect(validateBatchDefinition(definition(), 'volume')).toEqual(definition());
    expect(validateBatchDefinition({ ...definition(), base: 'b'.repeat(64) }).base).toHaveLength(64);
  });
  test.each([{ schemaVersion: 2 }, { pass: '../volume' }, { base: 'main' }, { toolCommit: 'abc' }, { batches: null }])('壊れた定義を拒否する: %j', (change) => {
    expect(() => validateBatchDefinition({ ...definition(), ...change })).toThrow();
  });
  test.each([{ files: ['../a.cpp'] }, { files: [] }, { docs: ['C:/outside.md'] }, { weight: -1 }, { commentChars: 0.1 }])('壊れた束を拒否する: %j', (change) => {
    const value = definition();
    Object.assign(value.batches[0], change);
    expect(() => validateBatchDefinition(value)).toThrow();
  });
  test('回の不一致と束や担当ファイルの重複を拒否する', () => {
    expect(() => validateBatchDefinition(definition(), 'history')).toThrow('一致');
    const value = definition();
    value.batches.push({ ...value.batches[0] });
    expect(() => validateBatchDefinition(value)).toThrow('重複');
    value.batches[1].id = 'V02';
    expect(() => validateBatchDefinition(value)).toThrow('別の束');
  });
});
