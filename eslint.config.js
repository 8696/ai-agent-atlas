import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'dist-web/**', 'node_modules/**', 'data/**', 'logs/**', 'backups/**'] },
  js.configs.recommended,
  {
    // ⚠️ **类型感知规则只给 TS/TSX** ——
    // `recommendedTypeChecked` 里的规则要类型信息，
    // 而 `eslint.config.js` 这类 .js 文件没有类型信息 → 规则直接抛错。
    // 所以整组配置（含 parser）都限定在 TS 文件上。
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        // ⚠️ **用 projectService 而不是 project** ——
        // `project: [...]` 每个文件都新建一个 TS Program（慢）；
        // `projectService: true` 走 TS 的增量服务，自动就近找 tsconfig。
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // ⚠️ 允许 `info` / `warn` / `error` —— CLI 与启动期的用户可见输出走这三个，
      //    其余的 `console.log` 一律报警（业务侧日志走 `src/logger.ts` 的 pino）
      'no-console': ['warn', { allow: ['info', 'warn', 'error'] }],
    },
  },
);
