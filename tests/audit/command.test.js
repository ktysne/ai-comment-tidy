import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { run } from '../../src/cli.js';
import { loadConfig } from '../../src/config.js';
import { batchPaths } from '../../src/paths.js';
import { transitionState, writeState } from '../../src/state.js';
import { extractHunks } from '../../src/audit/hunks.js';
import { createGitSnapshot } from '../../src/snapshot/git.js';
import { statusForBatches } from '../../src/status/run.js';

const roots = [];
function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function write(root, file, text) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}
function setStatus(fixture, status) {
  let state = null;
  for (const next of ['prepared', 'delegated', 'reported', 'checked', 'applied']) {
    state = transitionState(state, next, { pass: 'volume', batch: 'V01' });
    if (next === status) break;
  }
  write(fixture.root, path.relative(fixture.root, fixture.paths.state), JSON.stringify(state));
}
function makeRepo({ files = { 'src/a.cpp': '// スレッド\nint a;\n' }, docs = {}, config = {} } = {}) {
  const directory = path.resolve('.cross-review');
  fs.mkdirSync(directory, { recursive: true });
  const root = fs.mkdtempSync(path.join(directory, 'audit-test-'));
  roots.push(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'audit@example.test']);
  git(root, ['config', 'user.name', '監査テスト']);
  git(root, ['config', 'core.autocrlf', 'true']);
  write(root, '.gitattributes', '* text=auto\n');
  write(root, '.gitignore', '.comment-tidy/work/\n.comment-tidy/worktrees/\n');
  for (const [file, source] of Object.entries({ ...files, ...docs, 'outside.cpp': '// 担当外\nint outside;\n' })) write(root, file, source);
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', '基準']);
  const base = git(root, ['rev-parse', 'HEAD']);
  const batch = { id: 'V01', area: 'src', files: Object.keys(files), docs: Object.keys(docs), weight: 1, commentChars: 999 };
  const definition = { schemaVersion: 1, pass: 'volume', base, toolCommit: null, batches: [batch] };
  write(root, '.comment-tidy/config.json', JSON.stringify({ passes: { volume: { criteria: 'criteria.md' } }, ...config }));
  write(root, '.comment-tidy/batches-volume.json', JSON.stringify(definition));
  const paths = batchPaths(root, 'volume', 'V01');
  fs.mkdirSync(path.dirname(paths.worktree), { recursive: true });
  git(root, ['worktree', 'add', '--quiet', '--detach', paths.worktree, base]);
  const fixture = { root, paths, base, definition, batch,
    json: path.join(root, '.comment-tidy/work/volume/audit-V01.json'),
    markdown: path.join(root, '.comment-tidy/work/volume/audit-V01.md') };
  setStatus(fixture, 'reported');
  return fixture;
}
async function audit(fixture, args = []) {
  const captured = capture();
  const code = await run(['audit', 'V01', '--repo', fixture.root, ...args], captured.io);
  return { code, ...captured, result: code === 0 ? JSON.parse(fs.readFileSync(fixture.json, 'utf8')) : null };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('束の監査', { timeout: 20000 }, () => {
  test('CRLFとBOM、日本語と空白のパス、文字列、行末と複数行のコメントの行番号を判定する', async () => {
    const file = 'src/日本語 [資料] 名前.cpp';
    const before = '\ufeffconst char* url = "// スレッド";\r\nint a; // 所有\r\n/* 丸め\r\n * 上限\r\n */ int b;\r\n';
    const after = '\ufeffconst char* url = "// スレッド";\r\nint a; // 必要に応じて\r\n/* 説明\r\n * 続き\r\n */ int b;\r\n';
    const fixture = makeRepo({ files: { [file]: before } });
    write(fixture.paths.worktree, file, after);
    const baseline = createGitSnapshot(fixture.paths.worktree, fixture.base);
    const extracted = extractHunks({ worktree: fixture.paths.worktree, base: fixture.base, file,
      before: baseline.readManyRaw([file]).get(file), after: Buffer.from(after), config: loadConfig(fixture.root) });
    expect(extracted.hunks).toHaveLength(1);
    expect(extracted.hunks[0].removed.map((row) => row.line)).toEqual([2, 3, 4]);
    expect(extracted.hunks[0].added.map((row) => row.line)).toEqual([2, 3, 4]);
    expect(extracted.currentLines.has(1)).toBe(false);
    const { code, result } = await audit(fixture);
    expect(code).toBe(0);
    expect(result.findings.find((finding) => finding.check === 'hedge')).toMatchObject({ file, line: 2 });
    expect(result.findings.find((finding) => finding.check === 'keyword-loss')).toMatchObject({
      line: 2, detail: 'スレッドと寿命と順序: 所有 / 数値と単位: 丸め、上限' });
  });

  test('変更のない担当では担当外の差分を読まず、該当なしの材料を書く', async () => {
    const fixture = makeRepo();
    write(fixture.paths.worktree, 'outside.cpp', '// 適宜\r\nint outside;\r\n');
    const { code, result } = await audit(fixture);
    expect(code).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.summary).toEqual({ 'keyword-loss': 0, 'full-delete': 0, hedge: 0, 'missing-ref': 0 });
    expect(fs.readFileSync(fixture.markdown, 'utf8')).toContain('該当なし。');
  });

  test.each(['追加', '別のコメント', '参照先'])('重要語が%sに残っていれば消失として拾わない', async (location) => {
    const before = '// スレッドの制約\nint a;\nint b;\nint c;\nint d;\nint e;\nint f;\n';
    const fixture = makeRepo({ files: { 'src/a.cpp': before + (location === '別のコメント' ? '// スレッドの寿命\n' : '') },
      docs: { 'docs/policy.md': '# 制約（補足）\nスレッドの規則\n' } });
    const first = location === '追加' ? '// スレッドを管理する\r\n' : location === '参照先' ? '// docs/policy「制約」\r\n' : '';
    write(fixture.paths.worktree, 'src/a.cpp', first + before.split('\n').slice(1).join('\r\n') + (location === '別のコメント' ? '// スレッドの寿命\r\n' : ''));
    const { code, result } = await audit(fixture);
    expect(code).toBe(0);
    expect(result.findings.filter((finding) => finding.check === 'keyword-loss')).toEqual([]);
  });

  test('コードの語や未参照の資料は重要語を保持したものとして扱わない', async () => {
    const fixture = makeRepo({ files: { 'src/a.cpp': '// atomic\nint atomic;\n' }, docs: { 'docs/policy.md': '# 制約\natomic\n' } });
    write(fixture.paths.worktree, 'src/a.cpp', 'int atomic;\r\n');
    const { result } = await audit(fixture);
    expect(result.summary['keyword-loss']).toBe(1);
  });

  test('既定の語群への追加と新しい語群、英字の単語境界を使う', async () => {
    const fixture = makeRepo({ files: { 'src/a.cpp': '// ms px Hz atomic TODO schemaVersion\n// 特別語 独自語 スレッド\nint a;\n' },
      config: { audit: { keywordGroups: { '互換': ['特別語'], '独自': ['独自語'] } } } });
    write(fixture.paths.worktree, 'src/a.cpp', '// items pixel kHz atomically TODOs schemaVersion2\r\nint a;\r\n');
    const { result } = await audit(fixture);
    const detail = result.findings.find((finding) => finding.check === 'keyword-loss').detail;
    for (const word of ['ms', 'px', 'Hz', 'atomic', 'TODO', 'schemaVersion', '特別語', '独自語', 'スレッド']) expect(detail).toContain(word);
    expect(detail).toContain('独自: 独自語');
    expect(detail).toContain('互換:');
  });

  test('英字の重要語を含む識別子だけの削除は拾わない', async () => {
    const fixture = makeRepo({ files: { 'src/a.cpp': '// items atomically TODOs schemaVersion2 pixel kHz\nint a;\n' } });
    write(fixture.paths.worktree, 'src/a.cpp', 'int a;\r\n');
    expect((await audit(fixture)).result.summary['keyword-loss']).toBe(0);
  });

  test.each([
    ['4 行', '// 一\n// 二\n// 三\n// 四\n', '', 1],
    ['3 行', '// 一\n// 二\n// 三\n', '', 0],
    ['追加あり', '// 一\n// 二\n// 三\n// 四\n', '// 要約\r\n', 0],
    ['空本文', '/*\n * 一\n * 二\n *\n */\n', '', 0],
    ['ライセンス', '// Copyright\n// 一\n// 二\n// 三\n// 四\n', '', 0],
    ['独自ライセンス', '// 利用許諾\n// 一\n// 二\n// 三\n// 四\n', '', 0],
  ])('丸ごと削除の%sを判定する', async (_, before, after, expected) => {
    const fixture = makeRepo({ files: { 'src/a.cpp': `${before}int a;\n` },
      config: { licensePatterns: ['Copyright', '利用許諾'] } });
    write(fixture.paths.worktree, 'src/a.cpp', `${after}int a;\r\n`);
    const { result } = await audit(fixture);
    expect(result.summary['full-delete']).toBe(expected);
  });

  test('別hunkの追加は4行以上の削除を隠さない', async () => {
    const codes = Array.from({ length: 12 }, (_, index) => `int a${index};`).join('\n');
    const fixture = makeRepo({ files: { 'src/a.cpp': `// 一\n// 二\n// 三\n// 四\n${codes}\n// 文\n` } });
    write(fixture.paths.worktree, 'src/a.cpp', `${codes.replaceAll('\n', '\r\n')}\r\n// 要約\r\n`);
    expect((await audit(fixture)).result.summary['full-delete']).toBe(1);
  });

  test('逃げ言葉と実在しない参照を追加行だけで拾い、見出しの照合を共用する', async () => {
    const fixture = makeRepo({ files: { 'src/a.cpp': '// など docs/policy「不存在」\nint a;\n' },
      docs: { 'docs/policy.md': '# 有効な節（補足）\n本文\n```md\n# 偽の節\n```\n' } });
    write(fixture.paths.worktree, 'src/a.cpp', '// など docs/policy「不存在」\r\nint a;\r\n// 適宜、必要に応じて適切に docs/policy「有効な節」\r\n// docs/policy「偽の節」 docs/unknown「節」\r\n');
    const { result } = await audit(fixture);
    expect(result.summary.hedge).toBe(1);
    expect(result.summary['missing-ref']).toBe(2);
    expect(result.findings.filter((finding) => finding.check === 'missing-ref').map((finding) => finding.line)).toEqual([4, 4]);
    expect(result.findings.filter((finding) => finding.check === 'hedge')[0].detail).toContain('適切に');
  });

  test.each(['reported', 'checked'])('%sの状態を変えずに材料と候補、statusと同じ削減率を書く', async (status) => {
    const fixture = makeRepo({ files: { 'src/a.cpp': '// 所有\n// 長い文\nint a;\n' } });
    setStatus(fixture, status);
    const state = JSON.parse(fs.readFileSync(fixture.paths.state, 'utf8'));
    state.report = { docsCandidates: [{ file: 'src/a.cpp', lines: '1-2', summary: '資料の候補' }],
      needsDecision: [{ file: 'src/a.cpp', lines: '2', summary: '判断の候補' }],
      codeImprovements: [{ file: 'src/a.cpp', lines: '3', summary: '改善の候補' }] };
    writeState(fixture.root, 'volume', 'V01', state);
    const before = fs.readFileSync(fixture.paths.state);
    write(fixture.paths.worktree, 'src/a.cpp', '// など\r\nint a;\r\n');
    const { code, result } = await audit(fixture);
    expect(code).toBe(0);
    expect(fs.readFileSync(fixture.paths.state)).toEqual(before);
    expect(result).toMatchObject({ schemaVersion: 1, pass: 'volume', batch: 'V01', base: fixture.base });
    expect(Number.isFinite(Date.parse(result.auditedAt))).toBe(true);
    const measured = statusForBatches({ definition: fixture.definition, baseline: createGitSnapshot(fixture.paths.worktree, fixture.base),
      currentByBatch: new Map([['V01', { snapshot: createGitSnapshot(fixture.paths.worktree) }]]), states: new Map([['V01', state]]), config: loadConfig(fixture.root) });
    expect(result.reduction).toEqual({ baseChars: measured.rows[0].baseChars, currentChars: measured.rows[0].currentChars,
      ratio: measured.rows[0].ratio, reductionRate: 100 - measured.rows[0].ratio });
    expect(result.reports).toEqual(measured.reports);
    const markdown = fs.readFileSync(fixture.markdown, 'utf8');
    for (const finding of result.findings) {
      expect(markdown).toContain(`${finding.file}:${finding.line}`);
      expect(markdown).toContain(finding.detail);
      for (const text of [...finding.removed, ...finding.added]) expect(markdown).toContain(text);
    }
    for (const name of Object.keys(result.summary)) expect(markdown).toContain(`(${name}): ${result.summary[name]} 件`);
    for (const candidates of Object.values(result.reports)) for (const candidate of candidates) expect(markdown).toContain(candidate.summary);
  });

  test('基準のコメントがない場合は削減率を算出不可にする', async () => {
    const fixture = makeRepo({ files: { 'src/a.cpp': 'int a;\n' } });
    expect((await audit(fixture)).result.reduction).toEqual({ baseChars: 0, currentChars: 0, ratio: null, reductionRate: null });
  });

  test.each([null, 'prepared', 'delegated', 'applied'])('%sからは状態を変えず材料の保存前に拒否する', async (status) => {
    const fixture = makeRepo();
    if (status === null) fs.unlinkSync(fixture.paths.state);
    else setStatus(fixture, status);
    const before = status === null ? null : fs.readFileSync(fixture.paths.state);
    expect((await audit(fixture)).code).toBe(2);
    expect(fs.existsSync(fixture.json)).toBe(false);
    expect(fs.existsSync(fixture.markdown)).toBe(false);
    expect(status === null ? null : fs.readFileSync(fixture.paths.state)).toEqual(before);
  });

  test('基準以外のHEADを持つ作業ツリーは材料を書かず拒否する', async () => {
    const fixture = makeRepo();
    git(fixture.paths.worktree, ['-c', 'user.name=監査テスト', '-c', 'user.email=audit@example.test', 'commit', '--allow-empty', '--quiet', '-m', '別のHEAD']);
    const { code, err } = await audit(fixture);
    expect(code).toBe(2);
    expect(err.join('')).toContain('detached HEAD');
    expect(fs.existsSync(fixture.json)).toBe(false);
    expect(fs.existsSync(fixture.markdown)).toBe(false);
  });

  test('複数回の明示選択、サブディレクトリ、絶対パスの外部設定を受ける', async () => {
    const fixture = makeRepo();
    write(fixture.root, '.comment-tidy/batches-other.json', JSON.stringify({ ...fixture.definition, pass: 'other' }));
    expect((await audit(fixture)).code).toBe(2);
    const configPath = path.join(fixture.root, 'external.json');
    fs.copyFileSync(path.join(fixture.root, '.comment-tidy/config.json'), configPath);
    expect(await run(['audit', 'V01', '--pass', 'volume', '--repo', path.join(fixture.root, 'src'), '--config', configPath], capture().io)).toBe(0);
  });

  test('保存先のリンクを拒否して既存の材料と状態を保つ', async (context) => {
    const fixture = makeRepo();
    const outside = path.join(fixture.root, 'keep.json');
    fs.writeFileSync(outside, '保持');
    try { fs.symlinkSync(outside, fixture.json, 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { context.skip(`リンク作成不可: ${error.code}`); return; }
      throw error;
    }
    const before = fs.readFileSync(fixture.paths.state);
    expect((await audit(fixture)).code).toBe(2);
    expect(fs.readFileSync(outside, 'utf8')).toBe('保持');
    expect(fs.existsSync(fixture.markdown)).toBe(false);
    expect(fs.readFileSync(fixture.paths.state)).toEqual(before);
  });

  test.for([[], ['V01', '--offline'], ['V01', '--pass', '../bad'], ['V01', '--config', 'relative.json'],
    ['V01', '--repo'], ['V01', 'V02'], ['V01', '--pass', 'volume', '--pass', 'other']])('不正な引数を拒否する: %j', async (args) => {
    expect(await run(['audit', ...args], capture().io)).toBe(2);
  });
});
