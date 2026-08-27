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
      // React Compiler diagnostics. These flag genuine modernization work
      // (setState-in-effect cascades, components created during render, refs
      // read during render) that needs real refactors across the screens —
      // tracked as cross-cutting cleanup, not something to fix in the same
      // change that introduces linting. Kept visible as warnings so the count
      // can be ratcheted down to `error` once the screens are cleaned up.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
];
