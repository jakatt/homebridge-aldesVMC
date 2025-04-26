import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended, // Basic ESLint recommended rules
  ...tseslint.configs.recommended, // TypeScript specific recommended rules
  {
    // Optional: Add custom rules or overrides here
    // rules: {
    //   'no-unused-vars': 'warn', // Example: warn about unused variables
    // },
  },
  {
    // Ignore build output directory
    ignores: ['dist/**'],
  }
);
