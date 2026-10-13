import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/', 'output/', 'state/', 'playwright-report/', 'test-results/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Explicit type arguments document intent and stay correct when more providers are added.
      '@typescript-eslint/no-unnecessary-type-arguments': 'off',
    },
  },
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
  prettier,
);
