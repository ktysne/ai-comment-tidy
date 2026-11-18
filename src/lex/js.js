import { lexCppLike } from './c-like.js';
import { separatorPattern } from './separator.js';

export const language = {
  id: 'js',
  extensions: ['js', 'mjs', 'cjs'],
  lex(source) { return lexCppLike(source, { language: 'js' }); },
  docCommentMarkers: ['///', '//!', '/**', '/*!'],
  separatorPattern: separatorPattern(/\/\/+/),
};
