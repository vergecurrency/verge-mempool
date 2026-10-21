import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  verbose: true,
  automock: false,
  collectCoverage: true,
  collectCoverageFrom: ['./src/**/**.ts', '!**/__tests__/verge/**'],
  coverageProvider: 'v8',
  coverageThreshold: {
    global: {
      lines: 1
    }
  },
  setupFiles: [
    './testSetup.ts',
  ],
  testPathIgnorePatterns: [
    '/dist/',
    '/node_modules/',
    '/__integration_tests__/',
    '/__tests__/verge/', // Executed separately with Node's test runner.
    'test-utils\\.ts$',
  ],
};
export default config;
