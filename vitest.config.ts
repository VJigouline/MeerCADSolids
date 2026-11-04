import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Generous, because coverage instrumentation slows the geometry down a lot.
    testTimeout: 600000,
    coverage: {
      include: ['src/**/*.ts'],
    },
  },
});
