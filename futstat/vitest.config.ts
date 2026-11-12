import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'pipeline/**/*.test.ts'],
    environment: 'node',
    // genera public/mock-data si falta (no se versiona; lo usan los tests de robustez de la app)
    globalSetup: ['tests/setup/mock-data.ts'],
    testTimeout: 30000,
  },
});
