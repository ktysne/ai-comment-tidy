import path from 'node:path';
import { commentBlocks } from '../comment-blocks.js';
import { DEFAULT_DOCS_CONFIG, DEFAULT_PLAN_CONFIG, isTargetFile } from '../config.js';
import { findCommentDocReferences, resolveDocPaths } from '../docs-refs.js';
import { matchesGlob } from '../glob.js';
import { areaOf } from '../stats/run.js';
import { fileStats, InvalidUtf8Error } from '../stats/file-stats.js';

const COMMENT_CHARS_PER_WEIGHT = 50;
const LONG_COMMENT_LINE_THRESHOLD = 3;

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assignedArea(filePath, config, warnings) {
  if (config?.areas !== undefined) {
    const matches = Object.entries(config.areas)
      .filter(([, patterns]) => patterns.some((pattern) => matchesGlob(filePath, pattern)))
      .map(([name]) => name);
    if (matches.length !== 1) {
      warnings.push({
        path: filePath,
        message: matches.length === 0 ? 'どの領域にも当たりません' : `複数の領域に当たります: ${matches.join(', ')}`,
      });
    }
  }
  return areaOf(filePath, config);
}

function unitKey(filePath) {
  const extension = path.posix.extname(filePath);
  return extension ? filePath.slice(0, -extension.length) : filePath;
}

function newBatch(area) {
  return { area, files: [], weight: 0, commentChars: 0, docs: new Set(), longCommentLines: 0 };
}

function addUnit(batch, files) {
  for (const file of files) {
    batch.files.push(file.path);
    batch.commentChars += file.commentChars;
    batch.longCommentLines += file.longCommentLines;
    for (const doc of file.docs) batch.docs.add(doc);
  }
  batch.weight = batch.commentChars / COMMENT_CHARS_PER_WEIGHT + batch.longCommentLines;
}

export function planForSnapshot(snapshot, { pass, base, toolCommit = null, config } = {}) {
  const allPaths = [...new Set(snapshot.listFiles().map((filePath) => filePath.replace(/\\/g, '/')))].sort(comparePaths);
  const paths = allPaths.filter((filePath) => isTargetFile(filePath, config));
  const contents = snapshot.readMany(paths);
  const warnings = [];
  const areas = new Map();
  const docsConfig = config?.docs ?? DEFAULT_DOCS_CONFIG;
  const maxWeight = config?.plan?.maxWeight ?? DEFAULT_PLAN_CONFIG.maxWeight;

  for (const filePath of paths) {
    let stats;
    try {
      stats = fileStats(filePath, contents.get(filePath), config);
    } catch (error) {
      if (!(error instanceof InvalidUtf8Error)) throw error;
      warnings.push({ path: filePath, message: error.message });
      continue;
    }
    const source = contents.get(filePath).toString('utf8');
    const longCommentLines = commentBlocks(filePath, source, config)
      .filter((block) => block.countedLines > LONG_COMMENT_LINE_THRESHOLD)
      .reduce((sum, block) => sum + block.countedLines, 0);
    const docs = new Set();
    for (const reference of findCommentDocReferences(filePath, source, docsConfig.refPattern, config)) {
      for (const doc of resolveDocPaths(reference.doc, docsConfig.root, allPaths)) docs.add(doc);
    }
    const area = assignedArea(filePath, config, warnings);
    if (!areas.has(area)) areas.set(area, new Map());
    const units = areas.get(area);
    const key = unitKey(filePath);
    if (!units.has(key)) units.set(key, []);
    units.get(key).push({ path: filePath, commentChars: stats.commentChars, longCommentLines, docs });
  }

  const batches = [];
  for (const area of [...areas.keys()].sort(comparePaths)) {
    let batch = newBatch(area);
    const units = areas.get(area);
    for (const key of [...units.keys()].sort((left, right) => comparePaths(units.get(left)[0].path, units.get(right)[0].path))) {
      const files = units.get(key);
      const unitChars = files.reduce((sum, file) => sum + file.commentChars, 0);
      const unitLines = files.reduce((sum, file) => sum + file.longCommentLines, 0);
      const combinedWeight = (batch.commentChars + unitChars) / COMMENT_CHARS_PER_WEIGHT + batch.longCommentLines + unitLines;
      if (batch.files.length > 0 && combinedWeight > maxWeight) {
        batches.push(batch);
        batch = newBatch(area);
      }
      addUnit(batch, files);
      if (batch.weight > maxWeight) {
        batches.push(batch);
        batch = newBatch(area);
      }
    }
    if (batch.files.length > 0) batches.push(batch);
  }

  return {
    definition: {
      schemaVersion: 1, pass, base, toolCommit,
      batches: batches.map((batch, index) => ({
        id: `${pass[0].toUpperCase()}${String(index + 1).padStart(2, '0')}`,
        area: batch.area,
        files: batch.files.sort(comparePaths),
        weight: batch.weight,
        commentChars: batch.commentChars,
        docs: [...batch.docs].sort(comparePaths),
      })),
    },
    warnings,
  };
}
