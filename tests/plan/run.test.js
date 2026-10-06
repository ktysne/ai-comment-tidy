import { describe, expect, test } from 'vitest';
import { planForSnapshot } from '../../src/plan/run.js';

function snapshot(entries, reverse = false) {
  const files = new Map(entries.map(([name, content]) => [name, Buffer.isBuffer(content) ? content : Buffer.from(content)]));
  return {
    listFiles: () => reverse ? [...files.keys()].reverse() : [...files.keys()],
    readMany: (paths) => new Map(paths.map((name) => [name, files.get(name)])),
  };
}

function plan(entries, config, reverse = false) {
  return planForSnapshot(snapshot(entries, reverse), { pass: 'volume', base: 'abc', toolCommit: 'def', config });
}

const oneWeightComment = `//${'x'.repeat(48)}\n`;

describe('束の計画', () => {
  test('コメント文字数と3行を超えるブロックの行数から重みを計算する', () => {
    const result = plan([['src/a.cpp', '\ufeff// a\r\n// b\r\n// c\r\n// d\r\nint a;\r\n']]);
    expect(result.definition.batches).toEqual([
      { id: 'V01', area: 'src', files: ['src/a.cpp'], weight: 4.24, commentChars: 12, docs: [] },
    ]);
  });

  test('引数説明と空行はコメント行数の上限と同じ基準で数える', () => {
    const result = plan([['a.cpp', '// a\n//\n// b\n// c\n// @param value 入力\n']]);
    expect(result.definition.batches[0].weight).toBe(result.definition.batches[0].commentChars / 50);
  });

  test('同じディレクトリの語幹を寄せ、上限と同じ重みまで束に含める', () => {
    const result = plan([
      ['src/a.cpp', oneWeightComment], ['src/a.h', oneWeightComment],
      ['src/b.cpp', oneWeightComment], ['src/c.cpp', oneWeightComment],
    ], { plan: { maxWeight: 3 } });
    expect(result.definition.batches.map(({ files, weight }) => ({ files, weight }))).toEqual([
      { files: ['src/a.cpp', 'src/a.h', 'src/b.cpp'], weight: 3 },
      { files: ['src/c.cpp'], weight: 1 },
    ]);
  });

  test('上限を超える語幹の単位は単独の束にし、重み0の後続も分ける', () => {
    const result = plan([
      ['src/a.cpp', oneWeightComment], ['src/a.hpp', oneWeightComment], ['src/a.inl', oneWeightComment],
      ['src/b.cpp', 'int b;\n'], ['other/a.cpp', oneWeightComment],
    ], { plan: { maxWeight: 2 } });
    expect(result.definition.batches.map(({ area, files, weight }) => ({ area, files, weight }))).toEqual([
      { area: 'other', files: ['other/a.cpp'], weight: 1 },
      { area: 'src', files: ['src/a.cpp', 'src/a.hpp', 'src/a.inl'], weight: 3 },
      { area: 'src', files: ['src/b.cpp'], weight: 0 },
    ]);
  });

  test('語幹ではなく単位の先頭ファイルのパスで並べる', () => {
    const result = plan([['src/a.cpp', oneWeightComment], ['src/a.b.cpp', oneWeightComment]], { plan: { maxWeight: 1 } });
    expect(result.definition.batches.map((batch) => batch.files)).toEqual([['src/a.b.cpp'], ['src/a.cpp']]);
  });

  test('領域の記述順で割り当て、重複と未所属をパス順で知らせる', () => {
    const result = plan([
      ['src/a.cpp', 'int a;'], ['tests/a.cpp', 'int b;'], ['root.cpp', 'int c;'],
    ], { areas: { engine: ['src/**'], all: ['src/**', 'tests/**'] } });
    expect(result.definition.batches.map(({ area, files }) => ({ area, files }))).toEqual([
      { area: '(なし)', files: ['root.cpp'] },
      { area: 'all', files: ['tests/a.cpp'] },
      { area: 'engine', files: ['src/a.cpp'] },
    ]);
    expect(result.warnings.map((warning) => warning.path)).toEqual(['root.cpp', 'src/a.cpp']);
    expect(result.warnings[1].message).toContain('engine, all');
  });

  test('scope と languages に従い、設定した言語のコメントから資料を拾う', () => {
    const result = plan([
      ['src/a.custom', '// notes/05「概要」\n// notes/05「別節」\nconst text = "notes/09「概要」";'],
      ['src/skip.custom', oneWeightComment], ['other/a.cpp', oneWeightComment],
      ['notes/05-architecture.md', '# 概要'], ['notes/05-details.md', '# 別節'],
      ['notes/09-other.md', '# 概要'],
    ], {
      scope: { include: ['src/**'], exclude: ['src/skip.custom'] },
      languages: { cpp: ['**/*.custom'] },
      docs: { root: 'notes', refPattern: 'notes/(?<doc>[\\w.-]+)「(?<heading>[^」]+)」' },
    });
    expect(result.definition.batches[0].files).toEqual(['src/a.custom']);
    expect(result.definition.batches[0].docs).toEqual(['notes/05-architecture.md', 'notes/05-details.md']);
  });

  test('UTF-8で読めないファイルを束から除き、一覧で知らせる', () => {
    const result = plan([['src/b.cpp', Buffer.from([0xff])], ['src/a.cpp', oneWeightComment]]);
    expect(result.definition.batches[0].files).toEqual(['src/a.cpp']);
    expect(result.warnings).toEqual([{ path: 'src/b.cpp', message: 'src/b.cpp を UTF-8 として読めません' }]);
  });

  test('一覧の順序が違っても同じ定義を作り、100番目以降も一意の名前にする', () => {
    const entries = Array.from({ length: 101 }, (_, index) => [`src/file${String(index).padStart(3, '0')}.cpp`, oneWeightComment]);
    const result = plan(entries, { plan: { maxWeight: 1 } });
    expect(plan(entries, { plan: { maxWeight: 1 } }, true)).toEqual(result);
    expect(result.definition.batches[99].id).toBe('V100');
    expect(result.definition.batches[100].id).toBe('V101');
  });

  test('対象ファイルが無くても版と基準を持つ空の定義を返す', () => {
    expect(plan([['readme.md', '# 説明']]).definition).toEqual({
      schemaVersion: 1, pass: 'volume', base: 'abc', toolCommit: 'def', batches: [],
    });
  });
});
