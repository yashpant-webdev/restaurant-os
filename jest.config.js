const swc = ['@swc/jest', { jsc: { parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true }, target: 'es2022' } }];
const moduleNameMapper = { '^@ros/(contracts|common)$': '<rootDir>/packages/$1/src' };
module.exports = {
  testTimeout: 30000,
  maxWorkers: 1, // integration suites share one Postgres server and recreate service databases
  projects: [
    { displayName: 'unit', testMatch: ['<rootDir>/packages/**/*.unit.test.ts', '<rootDir>/services/**/*.unit.test.ts'], transform: { '^.+\\.ts$': swc }, moduleNameMapper, testEnvironment: 'node' },
    {
      displayName: 'integration',
      testMatch: ['<rootDir>/services/**/*.int.test.ts', '<rootDir>/tests/e2e/**/*.test.ts'],
      transform: { '^.+\\.ts$': swc },
      moduleNameMapper,
      testEnvironment: 'node',
      globalSetup: '<rootDir>/tests/support/pg-global-setup.mjs',
      globalTeardown: '<rootDir>/tests/support/pg-global-teardown.mjs',
    },
  ],
};
