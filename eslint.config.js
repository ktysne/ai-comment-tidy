import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    // tools/cross-review*.js は上流からの取り込みで、ここでは直さない。
    // eslint は .gitignore を読まないので、作業ツリーの写しができる置き場もここで外す。
    ignores: [
      'node_modules/',
      'tools/cross-review*.js',
      '.claude/worktrees/',
      '.codegraph/',
      '.cross-review/',
      '.comment-tidy/',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    files: ['src/check/**/*.js', 'src/snapshot/fs.js'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: ['node:child_process'],
        patterns: [{ group: ['**/snapshot/git.js'], message: 'この領域では Git の読み取りを使えません。' }],
      }],
    },
  },
];
