const baseConfig = require('../../eslint.config.js');

module.exports = [
  ...baseConfig,
  {
    languageOptions: {
      ecmaVersion: 6,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          modules: true,
          experimentalObjectRestSpread: true,
        },
      }
    },
    rules: {
      'comma-dangle': 'off',
      'no-unused-vars': 'warn',
      'no-unexpected-multiline': 'warn',
      'prefer-const': 'warn',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-var-requires': 'off',
    },
  }
];
