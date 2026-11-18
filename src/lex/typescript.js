import { lexCppLike } from './c-like.js';
import { separatorPattern } from './separator.js';

export const language = {
  id: 'ts',
  extensions: ['ts', 'mts', 'cts'],
  lex(source) { return lexCppLike(source, { language: 'ts' }); },
  docCommentMarkers: ['///', '//!', '/**', '/*!'],
  separatorPattern: separatorPattern(/\/\/+/),
};
