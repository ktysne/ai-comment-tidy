import { commentBlocks } from '../comment-blocks.js';
import { docReferenceExists, findDocReferences } from '../docs-refs.js';
import { languageOf } from '../lex/index.js';
import { normalizedCode, normalizedCodeTokens } from '../lex/normalized-code.js';
import { sha256 } from '../snapshot/hash-list.js';
import { lineEndingSignature } from './line-endings.js';
import { eastAsianWidth } from './line-width.js';

const CHECK_NAMES = [
  'token-identity',
  'out-of-scope-change',
  'comment-lines',
  'line-ending',
  'line-width',
  'doc-ref',
];

function decodeSource(buffer, filePath) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch (error) {
    throw new Error(`${filePath} を UTF-8 として読めません`, { cause: error });
  }
}

function sourceWithoutBom(source) {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
}

function firstTokenDifference(before, after) {
  let index = 0;
  while (index < before.length && index < after.length && before[index].value === after[index].value) index++;
  return {
    index,
    before: before[index],
    after: after[index],
    beforeContext: before.slice(Math.max(0, index - 2), index + 3).map(({ value }) => value),
    afterContext: after.slice(Math.max(0, index - 2), index + 3).map(({ value }) => value),
  };
}

function tokenFailure(filePath, before, after) {
  const difference = firstTokenDifference(before, after);
  const line = difference.after?.line ?? difference.before?.line ?? 1;
  const beforeLine = difference.before?.line ?? '末尾';
  const afterLine = difference.after?.line ?? '末尾';
  const beforeContext = JSON.stringify(difference.beforeContext);
  const afterContext = JSON.stringify(difference.afterContext);
  return {
    check: 'token-identity',
    file: filePath,
    line,
    detail: `基準 ${beforeLine} 行目と作業 ${afterLine} 行目でトークン ${difference.index} が異なります。基準 ${beforeContext}、作業 ${afterContext}`,
  };
}

function addedCommentLines(beforeBlocks, afterBlocks) {
  const remaining = new Map();
  for (const block of beforeBlocks) {
    for (const line of block.lines) {
      const key = line.text.replace(/\s+/g, ' ').trim();
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
  }
  const added = [];
  for (const block of afterBlocks) {
    for (const line of block.lines) {
      const key = line.text.replace(/\s+/g, ' ').trim();
      const count = remaining.get(key) ?? 0;
      if (count === 0) added.push(line);
      else remaining.set(key, count - 1);
    }
  }
  return added;
}

function isLicenseBlock(block, patterns) {
  return patterns.some((pattern) => new RegExp(pattern).test(block.text));
}

function normalizedPath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function compareOutOfScope({ files, target, targetContents, hashList, changedFiles, offline, failures }) {
  const assigned = new Set(files);
  if (offline) {
    const paths = Object.keys(hashList.files).filter((filePath) => !assigned.has(filePath));
    for (const filePath of paths) {
      if (!target.has(filePath)) {
        failures.push({ check: 'out-of-scope-change', file: filePath, detail: '基準にあるファイルが作業ツリーにありません' });
        continue;
      }
      if (sha256(targetContents.get(filePath)) !== hashList.files[filePath]) {
        failures.push({ check: 'out-of-scope-change', file: filePath, detail: '担当外のファイルが変更されています' });
      }
    }
    return;
  }

  for (const filePath of changedFiles.filter((changedPath) => !assigned.has(changedPath)).sort()) {
    failures.push({ check: 'out-of-scope-change', file: filePath, detail: '担当外のファイルが変更されています' });
  }
}

function addCommentLineFailures(filePath, blocks, config, failures) {
  for (const block of blocks) {
    if (isLicenseBlock(block, config.licensePatterns)) continue;
    if (block.countedLines > config.maxCommentLines) {
      failures.push({
        check: 'comment-lines',
        file: filePath,
        line: block.startLine,
        detail: `コメント ${block.countedLines} 行が上限 ${config.maxCommentLines} 行を超えています`,
      });
    }
  }
}

function addCommentWarnings(filePath, source, linesToCheck, config, targetContents, documentPaths, warnings) {
  const lines = sourceWithoutBom(source).replace(/\r\n/g, '\n').split('\n');
  const docsRoot = config.docs.root.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  const readDocument = (documentPath) => {
    return decodeSource(targetContents.get(documentPath), documentPath);
  };

  for (const commentLine of linesToCheck) {
    const sourceLine = lines[commentLine.line - 1] ?? '';
    const width = eastAsianWidth(sourceLine);
    if (width > config.maxLineWidth) {
      warnings.push({
        check: 'line-width',
        file: filePath,
        line: commentLine.line,
        detail: `コメントを含む行が上限 ${config.maxLineWidth} 桁を超えています (${width} 桁)`,
      });
    }
    for (const reference of findDocReferences(commentLine.text, config.docs.refPattern)) {
      if (!docReferenceExists({
        ...reference,
        docsRoot,
        files: documentPaths,
        read: readDocument,
      })) {
        warnings.push({
          check: 'doc-ref',
          file: filePath,
          line: commentLine.line,
          detail: `資料の参照 ${docsRoot}/${reference.doc}「${reference.heading}」に一致する見出しがありません`,
        });
      }
    }
  }
}

export function runCheck({ files, baseline, target, hashList = null, config, offline = false }) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('--files に 1 つ以上のファイルを指定してください');
  const selectedFiles = [...new Set(files.map(normalizedPath))].sort();
  const failures = [];
  const warnings = [];
  const targetPaths = new Set(target.listFiles().map(normalizedPath));
  const docsRoot = config.docs.root.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  const docsPrefix = docsRoot === '' || docsRoot === '.' ? '' : `${docsRoot}/`;
  const documentPaths = [...targetPaths].filter((filePath) => !docsPrefix || filePath.startsWith(docsPrefix));

  for (const filePath of selectedFiles) {
    if (!languageOf(filePath)) throw new Error(`対応する言語がありません: ${filePath}`);
    if (!baseline.has(filePath)) throw new Error(`基準に担当ファイルがありません: ${filePath}`);
  }

  const baselineReadPaths = selectedFiles.filter((filePath) => baseline.has(filePath));
  const targetReadPaths = offline
    ? [...targetPaths]
    : [...new Set([...selectedFiles, ...documentPaths])].filter((filePath) => target.has(filePath));
  const baselineContents = baseline.readMany(baselineReadPaths);
  const targetContents = target.readMany(targetReadPaths);
  const lineEndingMismatches = [];

  for (const filePath of selectedFiles) {
    if (!target.has(filePath)) {
      failures.push({ check: 'token-identity', file: filePath, line: 1, detail: '担当ファイルが作業ツリーから削除されています' });
      continue;
    }

    const beforeBuffer = baselineContents.get(filePath);
    const afterBuffer = targetContents.get(filePath);
    const beforeSource = decodeSource(beforeBuffer, filePath);
    const afterSource = decodeSource(afterBuffer, filePath);
    const beforeCode = sourceWithoutBom(beforeSource);
    const afterCode = sourceWithoutBom(afterSource);
    if (normalizedCode(filePath, beforeCode) !== normalizedCode(filePath, afterCode)) {
      failures.push(tokenFailure(
        filePath,
        normalizedCodeTokens(filePath, beforeCode),
        normalizedCodeTokens(filePath, afterCode),
      ));
    }

    const beforeBlocks = commentBlocks(filePath, beforeSource);
    const afterBlocks = commentBlocks(filePath, afterSource);
    addCommentLineFailures(filePath, afterBlocks, config, failures);
    const addedLines = addedCommentLines(beforeBlocks, afterBlocks);
    addCommentWarnings(filePath, afterSource, addedLines, config, targetContents, documentPaths, warnings);

    if (!beforeBuffer.equals(afterBuffer)) {
      const beforeSignature = lineEndingSignature(beforeBuffer);
      const afterSignature = lineEndingSignature(afterBuffer);
      if (JSON.stringify(beforeSignature) !== JSON.stringify(afterSignature)) {
        lineEndingMismatches.push({ filePath, beforeSignature, afterSignature });
      }
    }
  }

  let rawBaselineContents = new Map();
  if (!offline && lineEndingMismatches.length > 0 && typeof baseline.readManyRaw === 'function') {
    rawBaselineContents = baseline.readManyRaw(lineEndingMismatches.map(({ filePath }) => filePath));
  }
  for (const { filePath, beforeSignature, afterSignature } of lineEndingMismatches) {
    const rawBaseline = rawBaselineContents.get(filePath);
    const rawSignature = rawBaseline && lineEndingSignature(rawBaseline);
    if (rawSignature && JSON.stringify(rawSignature) === JSON.stringify(afterSignature)) continue;
    failures.push({
      check: 'line-ending',
      file: filePath,
      detail: `基準 ${JSON.stringify(beforeSignature)}、作業 ${JSON.stringify(afterSignature)}`,
    });
  }

  if (offline && (!hashList || hashList.algorithm !== 'sha256' || !hashList.files)) {
    throw new Error('--offline では sha256 形式の --hashes が必要です');
  }
  compareOutOfScope({
    files: selectedFiles,
    target,
    targetContents,
    hashList,
    changedFiles: !offline && typeof baseline.changedFiles === 'function' ? baseline.changedFiles() : [],
    offline,
    failures,
  });

  failures.sort((left, right) => left.file.localeCompare(right.file) || (left.line ?? 0) - (right.line ?? 0) || left.check.localeCompare(right.check));
  warnings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.check.localeCompare(right.check));
  const summary = {};
  for (const result of [...failures, ...warnings]) summary[result.check] = (summary[result.check] ?? 0) + 1;
  return {
    schemaVersion: 1,
    pass: null,
    batch: null,
    base: baseline.base ?? null,
    baseDir: baseline.baseDir ?? null,
    offline,
    checkedAt: new Date().toISOString(),
    files: selectedFiles,
    ok: failures.length === 0,
    failures,
    warnings,
    summary: Object.fromEntries(CHECK_NAMES.filter((name) => summary[name]).map((name) => [name, summary[name]])),
  };
}
