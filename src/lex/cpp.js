import { lexCppLike } from './c-like.js';

export const language = {
  id: 'cpp',
  extensions: ['h', 'hpp', 'hh', 'hxx', 'c', 'cc', 'cpp', 'cxx', 'inl', 'ipp'],
  lex(source) { return lexCppLike(source, { language: 'cpp' }); },
  docCommentMarkers: ['///', '//!', '/**', '/*!'],
  separatorPattern: /^\/\/+\s*(?:[=*~#_-]{4,}|[=-]{3,}\s.*\s[=-]{3,}\s*)$/i,
};
