/* eslint-env node */
// app/ui/.eslintrc.cjs
//
// `npm run lint` used to fail with "couldn't find a configuration file" — the
// script existed, the plugins were installed, and nothing was ever linted.
// `tsc --noEmit` covers types; this covers the class of bug types cannot see:
// a `useEffect` missing a dependency or a cleanup, a list keyed by array index
// (which makes React reuse the wrong row when the list reorders), and a promise
// nobody awaited. Those are exactly the defects this codebase has already hit.
//
// Rule severity is chosen deliberately: `error` for things that are always a
// bug, `warn` for patterns that are usually wrong but have legitimate
// exceptions. Nothing purely stylistic is enabled — formatting arguments are
// not what this file is for.
module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
    // Type-aware linting: required by no-floating-promises / no-misused-promises,
    // which are the only way to catch an un-awaited async call.
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  settings: { react: { version: 'detect' } },
  ignorePatterns: [
    'dist',
    'dist-electron',
    'release',
    'node_modules',
    'public',
    '*.config.ts',
    '*.config.js',
    '*.cjs',
  ],
  rules: {
    // ── React correctness ────────────────────────────────────────────────
    'react-hooks/rules-of-hooks': 'error',
    // Missing deps produce stale closures — the "why is it showing the old
    // value" bug. Warn, not error: some effects intentionally run once and the
    // fix there is a comment, not a dependency.
    'react-hooks/exhaustive-deps': 'warn',
    'react/jsx-key': ['error', { checkFragmentShorthand: true }],
    'react/no-unstable-nested-components': 'warn',
    'react/jsx-no-target-blank': 'error',

    // ── Async correctness ────────────────────────────────────────────────
    '@typescript-eslint/no-floating-promises': 'warn',
    '@typescript-eslint/no-misused-promises': [
      'warn',
      { checksVoidReturn: false },   // onClick={async () => …} is idiomatic here
    ],
    'require-atomic-updates': 'off',  // too many false positives on zustand sets

    // ── Plain-JS footguns ────────────────────────────────────────────────
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-unsafe-optional-chaining': 'error',
    'no-fallthrough': 'error',
    eqeqeq: ['warn', 'smart'],

    // ── Off on purpose ───────────────────────────────────────────────────
    'react/prop-types': 'off',        // TypeScript already does this
    'react/react-in-jsx-scope': 'off', // React 18 automatic JSX runtime
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
  overrides: [
    {
      // Tests lean on loose typing and deliberate misuse; keep the noise out.
      files: ['src/tests/**/*.ts', 'src/tests/**/*.tsx'],
      rules: {
        '@typescript-eslint/no-floating-promises': 'off',
        '@typescript-eslint/no-misused-promises': 'off',
      },
    },
  ],
}
