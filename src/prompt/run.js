import { commentBlocks } from '../comment-blocks.js';
import { findForbiddenTerms, parseCriteriaSections } from '../init/criteria.js';
import { formatPromptPath } from '../paths.js';

const DEFAULT_PRESERVE = [
  'ライセンス表示と移植の約束を残す。',
  'テストの入力値の根拠を残す。',
  '契約の語の主語、順序、条件を変えない。',
  '共通規約の正本と、その適用範囲を残す。',
];

function quoteArgument(value, platform) {
  const text = formatPromptPath(value);
  return platform === 'win32' ? `'${text.replace(/'/g, "''")}'` : `'${text.replace(/'/g, "'\"'\"'")}'`;
}

function decodeSource(buffer, file) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`担当ファイルを UTF-8 として読めません: ${file}`);
  }
}

export function generatePrompt({ batch, paths, criteria, criteriaPath, rulesPaths, docsPaths,
  snapshot, changed = null, config, configPath, toolPath, nodePath = process.execPath, platform = process.platform }) {
  const sections = parseCriteriaSections(criteria);
  const forbidden = [];
  for (const [name, text] of [['目的', sections.purpose], ['落とさないもの', sections.preserve], ['対象外', sections.excluded]]) {
    for (const match of findForbiddenTerms(text)) forbidden.push(`${name} ${match.line}行目: ${match.value}`);
  }
  if (forbidden.length > 0) throw new Error(`判定基準の埋め込み対象に禁止語があります:\n${forbidden.join('\n')}`);

  const present = batch.files.filter((file) => snapshot.has(file));
  if (changed === null && present.length !== batch.files.length) throw new Error('担当ファイルが基準コミットにありません');
  const contents = snapshot.readMany(present);
  const fileStates = batch.files.map((file) => {
    if (!contents.has(file)) return `- ${file}: 欠落`;
    const ranges = commentBlocks(file, decodeSource(contents.get(file), file), config)
      .filter((block) => block.countedLines > 3).map((block) => `${block.startLine}-${block.endLine}`);
    return `- ${file}: ${changed === null ? '基準' : changed.has(file) ? '変更あり' : '未着手'}; 3行を超えるブロック: ${ranges.join(', ') || 'なし'}`;
  });
  const command = [nodePath, toolPath, 'check', '--offline', '--repo', paths.worktree,
    '--base-dir', paths.baseline, '--hashes', paths.hashes, '--config', configPath, '--files', ...batch.files]
    .map((value) => quoteArgument(value, platform)).join(' ');
  const position = changed === null ? ['新規の作業である。'] : [
    '途中の作業を再開する。',
    `変更あり: ${batch.files.filter((file) => changed.has(file)).join(', ') || 'なし'}`,
    `未着手: ${batch.files.filter((file) => !changed.has(file)).join(', ') || 'なし'}`,
  ];
  return [
    '## 位置づけ', ...position, '',
    '## 目的', sections.purpose, '',
    '## 落とさないもの', ...DEFAULT_PRESERVE.map((line) => `- ${line}`), sections.preserve, '',
    '## 作業ディレクトリ', formatPromptPath(paths.worktree), '',
    '## 必ず読むもの', ...[...rulesPaths, criteriaPath, ...docsPaths].map((file) => `- ${formatPromptPath(file)}`), '',
    '## 担当ファイルの状態', ...fileStates, '',
    '## 禁止事項', sections.excluded, '担当ファイル以外は変更しない。', '',
    '## 検証', '作業の後に次のコマンドで検査する。検査を実行できなければ、その理由を報告する。',
    `\`\`\`${platform === 'win32' ? 'powershell' : 'sh'}`, `${platform === 'win32' ? '& ' : ''}${command}`, '```', '',
    '## 報告',
    '「あなたの判断が必要なこと」「やったこと」「見つけた未対応の問題」の3つの見出しで報告する。',
    '「やったこと」の最後に、次の形の JSON を1つ置く。候補が無ければ空の配列とする。',
    'lines は基準の行番号で書く。各候補は file、lines、summary を持つ。',
    '```json', JSON.stringify({ docsCandidates: [], needsDecision: [], codeImprovements: [] }, null, 2), '```', '',
  ].join('\n');
}
