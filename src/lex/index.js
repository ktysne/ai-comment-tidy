import { language as cpp } from './cpp.js';
import { language as csharp } from './csharp.js';
import { language as js } from './js.js';
import { language as cmake } from './cmake.js';
import { language as bat } from './bat.js';

export const languages = [cpp, csharp, js, cmake, bat];

export function languageOf(filePath) {
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  const fileName = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
  if (fileName === 'cmakelists.txt') return cmake;

  const extensionStart = fileName.lastIndexOf('.') + 1;
  if (extensionStart === 0) return null;
  const extension = fileName.slice(extensionStart);
  return languages.find((language) => language.extensions.includes(extension)) ?? null;
}

export function lex(filePath, source) {
  const language = languageOf(filePath);
  return language ? language.lex(source) : [{ kind: 'code', start: 0, end: source.length }];
}
