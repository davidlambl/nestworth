// Flat config. `eslint-config-expo` carries the React Native / Expo rules;
// `eslint-config-prettier` is last so formatting is Prettier's job alone.
const expo = require('eslint-config-expo/flat');
const prettier = require('eslint-config-prettier');

module.exports = [
  ...expo,
  prettier,
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'electron/dist-main/**',
      'node_modules/**',
      '.claude/**',
      'backups/**',
      'nimbalyst-local/**',
      'playwright-report/**',
      'test-results/**',
      'ios/**',
      'android/**',
      '.expo/**',
      'expo-env.d.ts',
    ],
  },
  {
    // Jest hoists `jest.mock` above imports at transform time, so placing the
    // mock before the imports it applies to is both correct and clearer — it
    // keeps the mock next to the comment explaining it. Autofixing these to
    // "imports first" only detaches them.
    files: ['**/__tests__/**', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'import/first': 'off',
      '@typescript-eslint/array-type': 'off',
    },
  },
  {
    rules: {
      // React Compiler diagnostics (setState-in-effect cascades, components
      // created during render, refs read during render, values used before
      // they are declared, memoization the compiler cannot keep). Warnings
      // from the start of linting until the screens were cleaned up (#41);
      // errors now. eslint-plugin-react-hooks' recommended set already makes
      // them errors: they are named here so an upgrade of eslint-config-expo
      // or the plugin cannot quietly turn one back into a warning.
      'react-hooks/set-state-in-effect': 'error',
      'react-hooks/static-components': 'error',
      'react-hooks/refs': 'error',
      'react-hooks/immutability': 'error',
      'react-hooks/preserve-manual-memoization': 'error',
      // A warning in the recommended set, and CI fails on errors only. An
      // effect that leaves out a value it reads keeps the stale one: with an
      // empty list, the desktop menu would export the previous account after
      // a change of account or a sign-out (app/(tabs)/_layout.tsx).
      'react-hooks/exhaustive-deps': 'error',
    },
  },
];
