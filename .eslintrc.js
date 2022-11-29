const path = require('path')

module.exports = {
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  overrides: [],
  parser: '@typescript-eslint/parser',
  root: true,
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    // https://github.com/microsoft/vscode-eslint/issues/1170#issuecomment-811871985
    project: [path.join(__dirname, 'tsconfig.json')],
  },
  plugins: ['@typescript-eslint'],
  rules: {
    '@typescript-eslint/no-unused-vars': 'off',
    '@typescript-eslint/require-await': 'off',
  },
  ignorePatterns: ['.eslintrc.js', 'tree-sitter-*'],
}
