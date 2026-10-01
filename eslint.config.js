import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    // tools/cross-review*.js は上流からの取り込みで、ここでは直さない。
    ignores: ['node_modules/', 'tools/cross-review*.js', '.codegraph/', '.cross-review/', '.comment-tidy/'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
  },
];
