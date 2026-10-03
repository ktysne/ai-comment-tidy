import { language as cpp } from './cpp.js';
import { language as csharp } from './csharp.js';
import { language as js } from './js.js';
import { language as ts } from './typescript.js';
import { language as cmake } from './cmake.js';
import { language as bat } from './bat.js';
import { matchesGlob } from '../glob.js';

export const languages = [cpp, csharp, js, ts, cmake, bat];
const languageById = new Map(languages.map((language) => [language.id, language]));

export function languageOf(filePath) {
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  const fileName = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
  if (fileName === 'cmakelists.txt') return cmake;

  const extensionStart = fileName.lastIndexOf('.') + 1;
  if (extensionStart === 0) return null;
  const extension = fileName.slice(extensionStart);
  return languages.find((language) => language.extensions.includes(extension)) ?? null;
}

export function languageFor(filePath, config) {
  if (config?.languages === undefined) return languageOf(filePath);
  const normalizedPath = filePath.replace(/\\/g, '/');
  for (const [id, patterns] of Object.entries(config.languages)) {
    if (patterns.some((pattern) => matchesGlob(normalizedPath, pattern))) return languageById.get(id) ?? null;
  }
  return null;
}

export function lex(filePath, source, config) {
  const language = languageFor(filePath, config);
  return language ? language.lex(source) : [{ kind: 'code', start: 0, end: source.length }];
}
