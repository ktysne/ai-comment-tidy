import path from 'node:path';
import { lex } from './lex/index.js';

export function findDocReferences(text, refPattern) {
  const pattern = new RegExp(refPattern, 'g');
  const references = [];
  for (const match of text.matchAll(pattern)) {
    if (!match.groups?.doc || !match.groups?.heading) continue;
    references.push({ doc: match.groups.doc, heading: match.groups.heading, index: match.index });
  }
  return references;
}

export function findCommentDocReferences(filePath, source, refPattern, config) {
  const references = [];
  for (const segment of lex(filePath, source, config)) {
    if (segment.kind !== 'comment') continue;
    const comment = source.slice(segment.start, segment.end);
    const lineOffset = source.slice(0, segment.start).split('\n').length - 1;
    for (const reference of findDocReferences(comment, refPattern)) {
      const line = lineOffset + comment.slice(0, reference.index).split('\n').length;
      references.push({ ...reference, line });
    }
  }
  return references;
}

function withoutParentheticalSupplement(heading) {
  let normalized = heading;
  let previous;
  do {
    previous = normalized;
    normalized = normalized.replace(/\([^()]*\)|（[^（）]*）/g, '');
  } while (normalized !== previous);
  return normalized.trim();
}

export function markdownHeadings(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const headings = [];
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index]);
    if (fence !== null) {
      if (fenceLine && fenceLine[1][0] === fence.character && fenceLine[1].length >= fence.length
        && /^\s*$/.test(fenceLine[2])) fence = null;
      continue;
    }
    if (fenceLine) {
      fence = { character: fenceLine[1][0], length: fenceLine[1].length };
      continue;
    }
    const atx = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[index]);
    if (atx) {
      headings.push(atx[1].trim());
      continue;
    }
    if (index > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index])) {
      const title = lines[index - 1].trim();
      if (title) headings.push(title);
    }
  }
  return headings;
}

export function resolveDocPaths(doc, docsRoot, files) {
  const normalizedRoot = docsRoot.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  const rootPrefix = normalizedRoot === '.' || normalizedRoot === '' ? '' : `${normalizedRoot}/`;
  return files.filter((filePath) => {
    const normalized = filePath.replace(/\\/g, '/');
    const fileName = path.posix.basename(normalized);
    if (!normalized.startsWith(rootPrefix) || !fileName.toLowerCase().endsWith('.md')) return false;
    return fileName.startsWith(doc);
  });
}

export function docReferenceExists({ doc, heading, docsRoot, files, read }) {
  const candidates = resolveDocPaths(doc, docsRoot, files);
  const expected = withoutParentheticalSupplement(heading);
  return candidates.some((filePath) => markdownHeadings(read(filePath))
    .some((actual) => withoutParentheticalSupplement(actual).startsWith(expected)));
}
