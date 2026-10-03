import { lexCppLike } from './c-like.js';

export const language = {
  id: 'js',
  extensions: ['js', 'mjs', 'cjs'],
  lex(source) { return lexCppLike(source, { language: 'js' }); },
  docCommentMarkers: ['///', '//!', '/**', '/*!'],
  separatorPattern: /^\/\/+\s*(?:[=*~#_-]{4,}|[=-]{3,}\s.*\s[=-]{3,}\s*)$/i,
};
