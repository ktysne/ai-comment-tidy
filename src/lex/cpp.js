import { lexCppLike } from './c-like.js';
import { separatorPattern } from './separator.js';

export const language = {
  id: 'cpp',
  extensions: ['h', 'hpp', 'hh', 'hxx', 'c', 'cc', 'cpp', 'cxx', 'inl', 'ipp'],
  lex(source) { return lexCppLike(source, { language: 'cpp' }); },
  docCommentMarkers: ['///', '//!', '/**', '/*!'],
  separatorPattern: separatorPattern(/\/\/+/),
};
