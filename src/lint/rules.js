import { commentBlocks } from '../comment-blocks.js';
import { languageOf } from '../lex/index.js';
import {
  DEFAULT_LICENSE_PATTERNS,
  DEFAULT_MAX_COMMENT_LINES,
} from './config.js';

const TOOL_ANNOTATION_PATTERN = /eslint-|NOLINT|clang-format|clang-tidy|@ts-|prettier-ignore|istanbul ignore|c8 ignore|cspell:|noqa/i;
// 直前の文字の条件は後読みにし、当たった語に含めない(括弧の直後の番号も番号だけを報告し、allow の語と合うように)。
const ISSUE_REFERENCE_PATTERN = /[Ii]ssue ?#\d+|PR ?#\d+|(?<![0-9A-Za-z&#])#\d{1,4}(?![0-9A-Fa-f])/;
// チケットのキーは大文字 2 文字以上に限り、同じ形の規格名(UTF-8、SHA-256 など)を除く。`x-1` もチケットと誤らない。
const TICKET_PATTERN = /\b(?!(?:UTF|ISO|IEC|IEEE|ECMA|MPEG|SHA|MD|CRC|CP|AES|RSA|MP|JIS)-)[A-Z][A-Z0-9]+-\d+\b|[Ii]ssue ?#\d+|PR ?#\d+|(?<![0-9A-Za-z&#])#\d+(?![0-9A-Fa-f])|(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)\S+|\bTracking\b|追跡先/;
const TODO_PATTERN = /\b(?:TODO|FIXME|HACK)\b/;

const RULES = [
  {
    ruleId: 'length',
    severity: 'confirmed',
    hint: '行数の上限までに縮めるか、設計資料へ移して参照を 1 行置く。',
  },
  {
    ruleId: 'issue-ref',
    severity: 'confirmed',
    pattern: ISSUE_REFERENCE_PATTERN,
    hint: 'Issue 番号や PR 番号をコメントから削除する。',
  },
  {
    ruleId: 'date',
    severity: 'confirmed',
    pattern: /20\d{2}-\d{2}-\d{2}|20\d{2}\/\d{1,2}\/\d{1,2}|20\d{2} ?年 ?\d{1,2} ?月/,
    hint: '日付をコメントから削除する。',
  },
  {
    ruleId: 'separator',
    severity: 'confirmed',
    hint: '区切り線を削除する。',
  },
  {
    ruleId: 'history',
    severity: 'review',
    pattern: /以前は|以前の|以前と|従来(の|は|どおり|と)|もともとは|元々は|当初|最初は|今では|かつて|旧実装|旧来|リリース前|移設(で|の|前)|統合した際|限定前/,
    hint: '現在も必要な制約として書き直す。',
  },
  {
    ruleId: 'change-log',
    severity: 'review',
    pattern: /に変えた|へ変えた|をやめた|を廃止|に直した|を直した|修正した|変更した|追加した(?!ばかり)|削除した(?!後)|入れ替えた|置き換えた|移した(?!先)|になったので|になったため|ようになったので|なくなったので|していた(?!だ)|だった(?!とき)|ていた。/,
    hint: '変更の記録を削除し、現在の仕様と理由を書く。',
  },
  {
    ruleId: 'work-note',
    severity: 'review',
    patterns: [
      /相互レビュー|レビュー(指摘|指定|の例|で追加|の提案|で決めた)|利用者指摘|ユーザー(指摘|要望|報告|調整依頼)|実機確認|ユーザー確定/,
      /しようとした|消したかった|削ろうとした|直したかった|狙う削減|この ?PR|今回の(変更|修正|対応|作業)/,
      /(^|[^A-Za-z])M[0-6](?![0-9A-Za-z])|段階 ?[0-9]|フェーズ ?[0-9]/,
      /ステップ ?[0-9]/,
    ],
    hint: 'レビューや作業の記録を削除し、現在の仕様と理由を書く。',
  },
  {
    ruleId: 'todo-no-ticket',
    severity: 'review',
    hint: '対応するチケット番号を付けるか、TODO を削除する。',
  },
];

function makePatterns(patterns, field) {
  return patterns.map((pattern, index) => {
    try {
      return new RegExp(pattern, field === 'licensePatterns' ? 'i' : undefined);
    } catch {
      throw new Error(`${field}[${index}] は正規表現として解釈できません`);
    }
  });
}

function commentLineBody(text, languageId, closingMarker) {
  let body = text;
  if (languageId === 'cpp' || languageId === 'js') {
    if (body === '/**/') return '';
    body = body.replace(/^\/\/[/!]?<?/, '').replace(/^\/\*+!?<?/, '');
    body = body.replace(/^\*(?!\/)/, '').replace(/\*\/$/, '');
  } else if (languageId === 'cmake') {
    const bracket = /^#\[(=*)\[/.exec(body);
    if (bracket) body = body.slice(bracket[0].length);
    else body = body.replace(/^#+/, '');
    if (closingMarker && body.endsWith(closingMarker)) body = body.slice(0, -closingMarker.length);
  } else if (languageId === 'bat') {
    body = body.replace(/^@?rem\b/i, '').replace(/^::/, '');
  }
  return body;
}

function countLinesExcludingToolNotes(block, languageId) {
  const cmakeBracket = languageId === 'cmake'
    ? /^#\[(=*)\[/.exec(block.lines[0]?.text ?? '')
    : null;
  const closingMarker = cmakeBracket ? `]${cmakeBracket[1]}]` : '';
  const bodies = block.lines.map(({ text }) => commentLineBody(text, languageId, closingMarker));
  if (!bodies.some((body) => TOOL_ANNOTATION_PATTERN.test(body))) return block.countedLines;

  let count = 0;
  let inParameter = false;

  for (const body of bodies) {
    if (/^\s*[@\\](param|return|tparam|retval)\b/.test(body)) {
      inParameter = true;
      continue;
    }
    if (inParameter && /^\s{2,}\S/.test(body) && !/^\s*[@\\]/.test(body)) continue;
    inParameter = false;
    if (TOOL_ANNOTATION_PATTERN.test(body)) continue;
    if (!/^\s*$/.test(body)) count++;
  }

  return count;
}

function isAllowedHit(patterns, body, matchIndex, matchLength) {
  if (matchIndex === null) return false;
  return patterns.some((pattern) => {
    const match = pattern.exec(body);
    if (!match) return false;
    const allowStart = match.index;
    const allowEnd = allowStart + match[0].length;
    const hitEnd = matchIndex + matchLength;
    return allowStart <= matchIndex && allowEnd >= hitEnd;
  });
}

function firstMatch(patterns, text) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const leadingWhitespace = match[0].length - match[0].trimStart().length;
      const trimmed = match[0].trim();
      return { text: trimmed, index: match.index + leadingWhitespace, length: trimmed.length };
    }
  }
  return null;
}

function firstMatchInBodies(patterns, bodies) {
  for (const body of bodies) {
    const match = firstMatch(patterns, body);
    if (match) return { ...match, body };
  }
  return null;
}

/**
 * @param {string[]} bodies 行を改行でつないだ本文と、改行を詰めた本文。前者を先に調べる
 */
function matchRule(rule, block, bodies, countedLines, language) {
  const [linedBody] = bodies;
  if (rule.ruleId === 'length') {
    if (countedLines <= 0 || countedLines <= rule.maxCommentLines) return null;
    return { text: `${countedLines} 行`, index: null, length: 0, body: linedBody };
  }

  if (rule.ruleId === 'separator') {
    const pattern = language?.separatorPattern;
    const slashOnly = language?.id === 'cpp' || language?.id === 'js';
    for (const line of block.lines) {
      if (pattern?.test(line.text) || (slashOnly && /^\/{4,}$/.test(line.text))) {
        return { text: line.text, index: null, length: 0, body: linedBody };
      }
    }
    return null;
  }

  if (rule.ruleId === 'issue-ref' && /(\b(?:TODO|FIXME|HACK)\b|\bTracking\b|追跡先)/.test(linedBody)) return null;
  if (rule.ruleId === 'todo-no-ticket') {
    if (!TODO_PATTERN.test(linedBody) || TICKET_PATTERN.test(linedBody)) return null;
    return firstMatchInBodies([TODO_PATTERN], [linedBody]);
  }

  // 改行でつないだ本文だけだと、折り返しで 2 行に分かれた語を拾えない。
  // 詰めた本文だけだと、行末の `#123` が次の行の数字とつながって外れる。
  const patterns = rule.patterns ?? (rule.pattern ? [rule.pattern] : []);
  return firstMatchInBodies(patterns, bodies);
}

export function findViolations(filePath, source, options = {}) {
  const maxCommentLines = options.maxCommentLines ?? DEFAULT_MAX_COMMENT_LINES;
  const licensePatterns = makePatterns(options.licensePatterns ?? DEFAULT_LICENSE_PATTERNS, 'licensePatterns');
  const allowPatterns = (options.allow ?? []).map(({ pattern }) => {
    try {
      return new RegExp(pattern);
    } catch {
      throw new Error('allow の pattern は正規表現として解釈できません');
    }
  });
  const language = languageOf(filePath);
  const violations = [];

  for (const block of commentBlocks(filePath, source)) {
    const body = block.text;
    const ruleBody = body.replace(/\n/g, '');
    if (licensePatterns.some((pattern) => pattern.test(ruleBody))) continue;
    if (block.lines.length > 0 && block.lines.every(({ text }) => TOOL_ANNOTATION_PATTERN.test(text))) continue;

    const countedLines = countLinesExcludingToolNotes(block, language?.id);
    for (const rule of RULES) {
      // 行を改行でつないだ本文を先に調べる。詰めた本文だけだと、行末の `#123` が次の行の数字とつながって外れる。
      // 詰めた本文は、折り返しで 2 行に分かれた語を拾うために調べる。
      const match = matchRule({ ...rule, maxCommentLines }, block, [body, ruleBody], countedLines, language);
      if (!match || isAllowedHit(allowPatterns, match.body, match.index, match.length)) continue;
      violations.push({
        ruleId: rule.ruleId,
        severity: rule.severity,
        startLine: block.startLine,
        endLine: block.endLine,
        matched: match.text,
        hint: rule.ruleId === 'length'
          ? `${maxCommentLines} 行までに縮めるか、設計資料へ移して参照を 1 行置く。`
          : rule.hint,
        key: `${rule.ruleId}:${body.replace(/\s/g, '')}`,
      });
    }
  }

  return violations;
}
