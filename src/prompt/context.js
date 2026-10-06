import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchPaths, resolveExternalPath } from '../paths.js';

const TOOL_PATH = fileURLToPath(new URL('../../bin/comment-tidy.js', import.meta.url));

export function promptContext(repoRoot, definition, batch, config, configPath) {
  const pass = definition.pass;
  if (!config.passes || !Object.hasOwn(config.passes, pass)) throw new Error(`設定に回がありません: ${pass}`);
  if (!config.rulesPaths?.length) throw new Error('依頼文には rulesPaths でコメント記述ルールの正本を指定してください');
  const criteriaPath = resolveExternalPath(config.passes[pass].criteria, path.join(repoRoot, '.comment-tidy'));
  return {
    batch, config, configPath, paths: batchPaths(repoRoot, pass, batch.id),
    criteriaPath, criteria: fs.readFileSync(criteriaPath, 'utf8'),
    rulesPaths: config.rulesPaths.map((file) => resolveExternalPath(file, repoRoot)),
    docsPaths: batch.docs.map((file) => path.resolve(repoRoot, file)), toolPath: TOOL_PATH,
  };
}
