import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 対象を tests/ に限る。作業ツリーの写しや移行元の写しのテストを拾わないためである。
    include: ['tests/**/*.test.js'],
  },
});
