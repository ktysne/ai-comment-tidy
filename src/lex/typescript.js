import { lexCppLike } from './c-like.js';

export const language = {
  id: 'ts',
  extensions: ['ts', 'mts', 'cts'],
  lex(source) { return lexCppLike(source, { language: 'ts' }); },
  docCommentMarkers: ['///', '//!', '/**', '/*!'],
  separatorPattern: /^\/\/+\s*(?:[=*~#_-]{4,}|[=-]{3,}\s.*\s[=-]{3,}\s*)$/i,
};
