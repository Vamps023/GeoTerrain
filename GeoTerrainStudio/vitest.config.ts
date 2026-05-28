import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'electron/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    globals: true,
    testTimeout: 30000,
  },
});
